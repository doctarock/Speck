// Checks on a reply before it ends the cycle: independent models judge
// completion and waiting; Speck checks the reply against its own reasoning
// state deterministically.
import { claimedActions, unperformedActions } from "../../cognition/claims.js";
import { groundReply, mayClaimItems } from "../../cognition/reply-grounding.js";
import { completionContract, replyContract, waitValidationContract } from "./contracts.js";
import { boundedConfidence } from "./statements.js";
import { actor, roleProcessor } from "./support.js";
export class ReplyValidators {
    runtime;
    view;
    hypotheses;
    induction;
    constructor(runtime, view, hypotheses, induction) {
        this.runtime = runtime;
        this.view = view;
        this.hypotheses = hypotheses;
        this.induction = induction;
    }
    // Whether a reply that waits for the user may end the cycle, judged by a
    // different model than the one that wrote it.
    async wait(worker, action, writerId) {
        const validatorId = this.runtime.independentProcessor(writerId, waitValidationContract.name) ?? writerId;
        const question = action.action === "question"
            ? "The reply asks the user for information before continuing. justified is true only if the task cannot make any further progress without information that only the user can give; false if the reply could instead reason with what is already known, give a provisional answer, or state its uncertainty."
            : "The reply gives a provisional answer and waits for more from the user. justified is true only if the user is expected to provide more and the reply gives the best answer the information so far supports, with its uncertainty; false if it declines to answer or asks for information it does not need.";
        try {
            const checked = await this.runtime.inferForWorker({
                workerId: worker.id, processorId: validatorId, contract: waitValidationContract, contextScope: "minimal",
                instruction: `${question}${this.view.taskContext(worker)}\nMessage being answered: ${this.view.currentMessage(worker)}${this.hypotheses.state(worker)}\nReply: ${action.response}`,
                actor: actor("wait-validator")
            });
            return {
                justified: checked.response.structured?.justified === true, judged: true, validatorId,
                reason: String(checked.response.structured?.reason ?? "").trim() || "Waiting was not justified."
            };
        }
        catch {
            return { justified: false, judged: false, validatorId, reason: "" };
        }
    }
    async completion(worker, proposedAnswer, writerId, specialty) {
        // The model that wrote the answer does not certify it: another processor
        // validates whenever one exists.
        const validatorId = this.runtime.independentProcessor(writerId, completionContract.name) ?? writerId;
        let satisfied = false;
        let reason = "Completion validation did not produce a valid result.";
        let confidence = 0;
        let validatorObject = null;
        try {
            const validated = await this.runtime.inferForWorker({
                workerId: worker.id, ...(validatorId ? { processorId: validatorId } : {}), ...(specialty ? { specialty } : {}),
                contract: completionContract,
                contextScope: "minimal",
                instruction: `Evaluate this proposed final answer independently.${this.view.taskContext(worker)}${this.view.earlierUserMessages(worker)}\nMessage being answered: ${this.view.currentMessage(worker)}\nConstraints: ${worker.objective.constraints.join("; ") || "none"}\nTool operations actually performed: ${this.view.performedOperations(worker)}\nProposed answer: ${proposedAnswer}`,
                actor: actor("completion-validator")
            });
            const result = validated.response.structured;
            satisfied = result.satisfied === true;
            reason = String(result.reason || reason).trim();
            confidence = boundedConfidence(result.confidence, validated.response.confidence);
            validatorObject = validated.object;
        }
        catch { /* rejection is intentionally fail-closed */ }
        const validationObservation = {
            workerId: worker.id,
            content: `Completion validation ${satisfied ? "passed" : "failed"}: ${reason}`,
            confidence, importance: 0.8,
            data: { validation: { satisfied, reason, proposedAnswer, writerId, validatorId, validatorObjectId: validatorObject?.id ?? null } },
            actor: actor("completion-validation")
        };
        const observation = this.runtime.memoryAdmissionPolicy.validatorResponses
            ? await this.runtime.recordMemory({ ...validationObservation, type: "episodic" })
            : await this.runtime.createMentalObject({ ...validationObservation, kind: "observation", memoryRoles: [] });
        await this.runtime.competeForWorkingMemory({
            workerId: worker.id,
            candidateIds: [observation.id, ...(validatorObject ? [validatorObject.id] : [])],
            actor: actor("completion-validation")
        });
        return { satisfied, judged: validatorObject !== null, validatorId, reason, observation };
    }
    // Shortcut S28 (docs/COGNITIVE_SHORTCUTS.md): actions the reply states as
    // done that no operation performed. The claims are read from the reply's
    // grammar and compared with Speck's record of what ran, only while nothing
    // has run, the one case the comparison settles. A false claim is recorded
    // as evidence against the writer; a reply that claims nothing says nothing
    // about its quality, so it is not recorded.
    actionClaims(worker, reply, written) {
        const performed = this.view.operations(worker).length;
        if (performed || !reply.trim())
            return [];
        const unfounded = unperformedActions(claimedActions(reply), performed);
        if (unfounded.length) {
            this.runtime.recordJudgment({
                producerId: written.processorId, contract: replyContract.name, protocol: written.toolCalling ?? "json", aspect: "quality",
                evaluator: "deterministic", verdict: "rejected", deterministicOutcome: "claims-unperformed-action", context: { workerId: worker.id, unfounded }
            });
        }
        return unfounded.length
            ? [`Your reply says this was done: ${unfounded.map((quote) => `"${quote}"`).join(", ")} No operation was performed in this task, so it did not happen. Do not say it was done.`]
            : [];
    }
    // What, in a reply written from a reasoning state, that state contradicts
    // (see groundReply). The reply's item claims are read by the extraction
    // role only when it uses a label at all; the comparison is Speck's. Each
    // check is recorded as evidence of the writer's competence.
    async grounding(worker, reply, shown, state, written) {
        const claims = mayClaimItems(reply, state)
            ? await this.induction.readLabelledPairs(worker, roleProcessor(this.runtime, "intake"), reply, "the reply")
            : null;
        const faults = groundReply({ reply, shown, state, claims }).map((fault) => fault.message);
        this.runtime.recordJudgment({
            producerId: written.processorId, contract: replyContract.name, protocol: written.toolCalling ?? "json", aspect: "quality",
            evaluator: "deterministic", verdict: faults.length ? "rejected" : "accepted",
            deterministicOutcome: faults.length ? "reply-contradicts-state" : "reply-matches-state", context: { workerId: worker.id, faults }
        });
        return faults;
    }
}
//# sourceMappingURL=validators.js.map