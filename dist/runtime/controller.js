import { groundableInduction, unsettled } from "../cognition/induction-standing.js";
import { correctCounts } from "../cognition/claims.js";
import { isInductionItem } from "../cognition/induction.js";
import { renderInductionStatement } from "../cognition/induction-render.js";
import { ReplyGate } from "./reply-gate.js";
import { COMPLETION_EXPECTATION, continuationContract, feedbackContract, replyContract } from "./controller/contracts.js";
import { FactRetention } from "./controller/facts.js";
import { HypothesisWork } from "./controller/hypotheses.js";
import { InductionWork } from "./controller/induction-work.js";
import { Intake, MESSAGE_MATERIAL } from "./controller/intake.js";
import { Planning } from "./controller/planning.js";
import { Recollection } from "./controller/recollection.js";
import { Settlement } from "./controller/settlement.js";
import { normalizedKey, quotedIn } from "./controller/statements.js";
import { actor, deriveAction, resultSummary, roleProcessor, statusResult } from "./controller/support.js";
import { TaskEvidence } from "./controller/task-evidence.js";
import { STATED_BY_SPECK, TaskView } from "./controller/task-view.js";
import { ToolStep } from "./controller/tool-step.js";
import { ReplyValidators } from "./controller/validators.js";
// What the user is asked when Speck could not recover from an impasse.
const STUCK_QUESTION = "I couldn't make progress on this. Could you rephrase it, or tell me more about what you need?";
// The controller sequences a task: intake routes it; a conversational turn is
// answered there; a task is planned or executed in bounded cycles. Each piece
// of cognitive work belongs to a collaborator in ./controller/.
export class SpeckController {
    runtime;
    options;
    view;
    evidence;
    settlement;
    facts;
    intake;
    induction;
    hypotheses;
    validators;
    tools;
    recollection;
    planning;
    constructor(runtime, options = {}) {
        this.runtime = runtime;
        this.options = options;
        this.view = new TaskView(runtime);
        this.evidence = new TaskEvidence(runtime, this.view);
        this.settlement = new Settlement(runtime);
        this.facts = new FactRetention(runtime, this.view);
        this.induction = new InductionWork(runtime, this.evidence);
        this.intake = new Intake(runtime, this.view, this.facts, this.settlement, this.induction);
        this.hypotheses = new HypothesisWork(runtime, this.view, this.evidence, this.induction);
        this.validators = new ReplyValidators(runtime, this.view, this.hypotheses, this.induction);
        this.tools = new ToolStep(runtime, this.view, options);
        this.recollection = new Recollection(runtime, this.view);
        this.planning = new Planning(runtime, this.view, this.recollection);
    }
    async run(workerId) {
        let worker = this.runtime.getWorker(workerId);
        if (!worker)
            throw new TypeError(`Worker ${workerId} was not found`);
        if (worker.status === "created")
            worker = await this.runtime.transitionWorker(worker.id, "ready", actor("controller"), "Admitted to controller");
        if (worker.status !== "ready")
            return { status: statusResult(worker), worker, summary: resultSummary(worker) };
        worker = await this.runtime.transitionWorker(worker.id, "orienting", actor("intake"), "Orienting to objective");
        await this.runtime.importSharedMemories({
            workerId: worker.id,
            query: worker.objective.description,
            role: "intake",
            limit: 8,
            actor: actor("shared-memory:intake")
        });
        await this.recollection.recall(worker, "intake");
        if (this.runtime.config.procedures.enabled) {
            const known = await this.runtime.retrieveKnownAnswer(worker.id, worker.objective.description, actor("fast-path"));
            if (known)
                return this.settlement.complete(worker, known.content, known, "Known Answer fast path", "intake");
            const procedure = await this.runtime.executeProcedure({ workerId: worker.id, trigger: worker.objective.description, actor: actor("fast-path") });
            if (procedure.matched && procedure.successful) {
                const answer = procedure.outputs.find((output) => output?.kind === "answer");
                return this.settlement.complete(this.runtime.getWorker(worker.id), answer?.text ?? "Procedure completed successfully.", procedure.procedure, "Compiled procedure fast path", "procedure");
            }
        }
        let specialty = worker.coordination ? "general" : undefined;
        if (!worker.coordination) {
            const intake = await this.intake.route(worker);
            specialty = intake.specialty;
            // What the user told us is captured independently of what they want
            // done, so a fact stated inside a request is kept like any disclosure.
            const retained = await this.facts.retain(worker, intake);
            if (intake.interaction !== "task")
                return this.intake.completeDialogueTurn(worker, intake, retained);
            if (intake.route === "plan" && this.runtime.config.coordination.enabled) {
                const planned = await this.planning.plan(worker);
                if (planned)
                    return planned;
            }
        }
        return this.execute(worker, specialty);
    }
    // How the user's message relates to the task waiting for them. Speck knows
    // two cases itself: when it asked for something (a blocked wait, such as an
    // approval), the reply is the answer; when the message gives labelled
    // examples, it is material for the task. Otherwise the worker role judges
    // whether the message carries the task on, closes it, or asks for
    // something new. Shortcut S26 (docs/COGNITIVE_SHORTCUTS.md).
    async relationToTask(workerId, message) {
        const worker = this.runtime.getWorker(workerId);
        // A task that has just finished is judged the same way: a message that
        // "closes" it is about the finished work (thanks, feedback).
        if (!worker || (worker.status !== "waiting" && worker.status !== "completed"))
            return "new";
        const finished = worker.status === "completed";
        const record = async (relation, basis) => {
            await this.runtime.setWorldState({ workerId, key: "speck.continuation", value: { message, relation, basis }, epistemicStatus: "observed", confidence: 1, actor: actor("continuation") });
            return relation;
        };
        if (!finished && worker.worldState["genesis.waitKind"]?.value === "blocked")
            return record("continues", "Speck asked the user for something");
        if (/\d/.test(message)) {
            const pairs = await this.induction.readLabelledPairs(worker, roleProcessor(this.runtime, "intake"), message, "the user's message");
            if ((pairs ?? []).some((pair) => isInductionItem(pair.item)))
                return record("continues", "the message gives labelled examples");
        }
        const lastReply = String((finished ? worker.worldState["genesis.resultSummary"]?.value : worker.worldState["genesis.questionForUser"]?.value) ?? "");
        try {
            const judged = await this.runtime.inferForWorker({
                workerId, processorId: roleProcessor(this.runtime, "worker"), contract: continuationContract, contextScope: "minimal",
                instruction: `${finished ? "A task has just been finished." : "A task is waiting for the user."} Decide how the user's new message relates to it.\nTASK: ${worker.objective.description}\nYOUR LAST REPLY: ${lastReply}\nUSER'S NEW MESSAGE: ${message}`,
                actor: actor("continuation")
            });
            const relation = judged.response.structured?.relation;
            return record(relation === "closes" || relation === "new" ? relation : "continues", "judged by the worker role");
        }
        catch {
            // Without a judgment, the task is carried on, as before.
            return record("continues", "no usable judgment");
        }
    }
    // A closing message may judge the work. The user is the most independent
    // evaluator Speck has, so a verdict is recorded as theirs: a judgment of the
    // processor that wrote the task's last reply (its result as performed, not a
    // confirmation of what the reply claimed), and the reward for calibrating
    // that processor's confidence. Reading the verdict is two models' work, and
    // it is recorded only when they agree: a missed verdict costs little, an
    // invented one would corrupt the evidence. Shortcut S27
    // (docs/COGNITIVE_SHORTCUTS.md).
    async recordUserVerdict(workerId, message) {
        const worker = this.runtime.getWorker(workerId);
        if (!worker)
            return null;
        const readers = [...new Map([roleProcessor(this.runtime, "worker"), roleProcessor(this.runtime, "intake")]
                .filter(Boolean).map((id) => [this.runtime.modelRegistry.modelKey(id), id])).values()];
        if (readers.length < 2)
            return null; // one model cannot corroborate itself
        // Feedback is short and names no items: a long message or one with
        // labelled items ("A63 → Blue") is work, not a verdict on it.
        if (message.length > 240 || /\p{L}+\d+/u.test(message))
            return null;
        const lastReply = String(worker.worldState["genesis.questionForUser"]?.value ?? worker.worldState["genesis.resultSummary"]?.value ?? "");
        const readings = [];
        for (const processorId of readers) {
            try {
                const read = await this.runtime.inferForWorker({
                    workerId, processorId, contract: feedbackContract, contextScope: "minimal",
                    instruction: `A task has just been worked on. Read the user's message about it.\nTASK: ${worker.objective.description}\nYOUR REPLY: ${lastReply}\nUSER'S MESSAGE: ${message}`,
                    actor: actor("user-feedback")
                });
                // A verdict counts only with the user's own words for it.
                const verdict = String(read.response.structured?.verdict ?? "neither");
                readings.push(verdict !== "neither" && quotedIn(String(read.response.structured?.quote ?? ""), message) ? verdict : "neither");
            }
            catch {
                readings.push("unread");
            }
        }
        const verdict = readings.every((reading) => reading === "praise") ? "praise" : readings.every((reading) => reading === "criticism") ? "criticism" : null;
        if (!verdict)
            return null;
        const written = [...this.runtime.mentalObjects.listForWorker(workerId)].reverse()
            .find((object) => ["speck-worker-cycle", "speck-dialogue-turn"].includes(String(object.data.modelResponse?.contract)));
        const writer = written ? String(written.data.modelResponse.processorId ?? "") : "";
        if (written && writer) {
            this.runtime.recordJudgment({
                producerId: writer, contract: String(written.data.modelResponse.contract), protocol: "json",
                aspect: "result", evaluator: "user", verdict: verdict === "praise" ? "accepted" : "rejected",
                deterministicOutcome: null, context: { workerId, message, readers: readings }
            });
            if (this.runtime.config.metacognition.enabled) {
                await this.runtime.recordModelOutcome({
                    workerId, processorId: writer, reportedConfidence: written.confidence, reward: verdict === "praise" ? 1 : 0,
                    sourceObjectId: written.id, actor: { kind: "user", source: "speck-controller:user-feedback" }
                });
            }
        }
        await this.runtime.setWorldState({
            workerId, key: "speck.userVerdict", value: { verdict, message, writer: writer || null },
            epistemicStatus: "observed", confidence: 1, actor: { kind: "user", source: "speck-controller:user-feedback" }
        });
        return verdict;
    }
    // The user ended the task: it completes, and their message is answered.
    async closeTask(workerId) {
        let worker = this.runtime.getWorker(workerId);
        if (worker.status === "waiting")
            worker = await this.runtime.transitionWorker(worker.id, "executing", actor("continuation"), "Closed by the user");
        const reply = await this.intake.converse(worker);
        return this.settlement.complete(worker, reply.response || "Understood, I'll leave that there.", reply.source, "Closed by the user", "conversation", false);
    }
    // The task is set aside to come back to: it stays waiting, with its own
    // thread, marked as parked so the conversation moves on without it.
    async parkTask(workerId, reason) {
        await this.runtime.setWorldState({ workerId, key: "genesis.parked", value: { reason, at: new Date().toISOString() }, epistemicStatus: "observed", confidence: 1, actor: actor("continuation") });
        const worker = this.runtime.getWorker(workerId);
        return { status: "waiting", worker, summary: String(worker.worldState["genesis.questionForUser"]?.value ?? "") };
    }
    // Bounded cognitive execution: each cycle runs the tool step, brings the
    // task's beliefs up to date, drafts a reply, reviews it against Speck's
    // checks, and settles it (wait, or validated completion).
    async execute(input, specialty) {
        const execution = await this.beginExecution(input, specialty);
        const maxCycles = Math.max(1, Math.min(12, this.options.maxCycles ?? 4));
        for (let cycle = 0; cycle < maxCycles; cycle += 1) {
            const outcome = await this.runCycle(execution);
            if (outcome !== "next" && outcome !== undefined)
                return outcome;
        }
        const worker = await this.runtime.completeCycle(execution.worker.id, { madeProgress: false, action: "cycle-budget-exhausted", actor: actor("controller") });
        if (worker.status === "impasse")
            return this.handOffImpasse(worker);
        return this.settlement.waitForUser(worker, execution.lastResponse || "The bounded cycle budget was exhausted; additional direction is required.");
    }
    async beginExecution(input, specialty) {
        let worker = this.runtime.getWorker(input.id);
        await this.runtime.importSharedMemories({
            workerId: worker.id,
            query: worker.objective.description,
            role: "worker",
            limit: 12,
            actor: actor("shared-memory:worker")
        });
        worker = this.runtime.getWorker(worker.id);
        const workerProcessor = specialty && this.runtime.config.modelRuntime.roles.specialists[specialty]
            ? this.runtime.config.modelRuntime.roles.specialists[specialty]
            : roleProcessor(this.runtime, "worker");
        if (workerProcessor && worker.modelAssignment?.processorId !== workerProcessor) {
            worker = await this.runtime.assignModelProcessor(worker.id, workerProcessor, actor("routing"));
        }
        if (worker.status === "orienting" || worker.status === "planning" || worker.status === "ready") {
            worker = await this.runtime.transitionWorker(worker.id, "executing", actor("worker"), "Beginning bounded cognitive execution");
        }
        return {
            worker, specialty, workerProcessor,
            writerProcessor: specialty && this.runtime.config.modelRuntime.roles.specialists[specialty] ? workerProcessor : roleProcessor(this.runtime, "writer"),
            demonstrated: [], recoveredImpasses: new Set(),
            lastResponse: "", lastRejection: "", uncertainty: null, hypothesesGenerated: false, toolRanSinceReply: false,
            repetitionGate: new ReplyGate(), groundingGate: new ReplyGate(), claimGate: new ReplyGate()
        };
    }
    async runCycle(execution) {
        await this.recollection.recall(execution.worker, "worker");
        const tool = await this.toolStage(execution);
        if (tool)
            return tool;
        const epistemicProgress = await this.beliefStage(execution);
        const drafted = await this.draftStage(execution);
        if (typeof drafted === "string" || !("draft" in drafted))
            return drafted;
        const reviewed = await this.reviewStage(execution, drafted.draft, drafted.instruction, epistemicProgress);
        if (typeof reviewed === "string" || !("draft" in reviewed))
            return reviewed;
        return this.settleStage(execution, reviewed.draft, epistemicProgress);
    }
    // Whether a registered tool still has to act is the Tool Caller's question,
    // asked before the worker is asked for a reply; neither role is shown the
    // other's options.
    async toolStage(execution) {
        if (this.runtime.toolRegistry.list().length && !execution.toolRanSinceReply && !this.examplesOnly(execution.worker)) {
            const worker = execution.worker;
            const result = await this.tools.attempt(worker, this.view.currentMessage(worker), this.view.toolSituation(worker));
            if (result.waiting)
                return this.settlement.waitForUser(worker, result.message);
            if (!result.noTool && !result.duplicate) {
                execution.toolRanSinceReply = Boolean(result.outcome);
                if (result.successful && result.intent && result.outcome) {
                    execution.demonstrated.push({ intent: result.intent, outcomeId: result.outcome.id });
                }
                return this.endCycle(execution, {
                    madeProgress: result.successful === true, action: "tool", validAction: true, resourceAvailable: result.successful === true
                });
            }
        }
        execution.toolRanSinceReply = false;
        return undefined;
    }
    // Shortcut S25 (docs/COGNITIVE_SHORTCUTS.md): a message that is nothing but
    // labelled examples asks for no operation, so no tool is considered for it.
    examplesOnly(worker) {
        const material = this.runtime.getWorker(worker.id)?.worldState[MESSAGE_MATERIAL]?.value;
        return material?.examplesOnly === true && material.message === this.view.currentMessage(worker);
    }
    // Brings the task's evidence and hypotheses up to date, generating
    // hypotheses when the run shows cognitive demand. Returns whether this
    // changed what the task holds: such a cycle made progress, even if its
    // reply is not accepted, so new user input is not stagnation.
    async beliefStage(execution) {
        const worker = execution.worker;
        const before = this.evidence.epistemicSignature(worker);
        const contradicted = await this.hypotheses.update(worker);
        const demand = execution.hypothesesGenerated ? null : execution.uncertainty ?? (contradicted ? "new evidence contradicted a held hypothesis" : null);
        if (demand) {
            execution.hypothesesGenerated = true;
            await this.hypotheses.generate(worker, execution.workerProcessor, demand);
            await this.hypotheses.update(worker);
        }
        return this.evidence.epistemicSignature(worker) !== before;
    }
    async draftStage(execution) {
        const worker = execution.worker;
        const instruction = `Write your reply to the user's current message, using only what is known or verified here.${this.view.taskContext(worker)}${this.view.conversationInstruction(worker)}${this.hypotheses.state(worker)}${execution.lastRejection ? `\nYOUR LAST REPLY WAS NOT ACCEPTED BECAUSE:\n${execution.lastRejection}` : ""}${this.view.latestToolOutcomeInstruction(worker)}\nTool operations actually performed: ${this.view.performedOperations(worker)}\nCURRENT MESSAGE (reply to this):\n${this.view.currentMessage(worker)}`;
        try {
            const inferred = await this.runtime.inferForWorker({
                workerId: worker.id, ...(execution.writerProcessor ? { processorId: execution.writerProcessor } : {}), ...(execution.specialty ? { specialty: execution.specialty } : {}),
                contract: replyContract,
                instruction,
                actor: actor("worker")
            });
            return { draft: { action: deriveAction(inferred.response.structured), inferred }, instruction };
        }
        catch {
            const ended = await this.endCycle(execution, {
                madeProgress: false, action: "invalid-structured-response", validAction: false, error: "Worker did not satisfy the reply contract"
            }, { retry: "Retrying after a reply that did not satisfy its contract." });
            return ended;
        }
    }
    // Speck's checks on a draft before it is settled: the reply's state against
    // Speck's own, repetition, cognitive demand, and grounding in the reasoning
    // state; then what Speck states itself is added (S24).
    async reviewStage(execution, draft, instruction, epistemicProgress) {
        const worker = execution.worker;
        let { action, inferred } = draft;
        // One reading of where the task's induction stands serves every check
        // and statement below.
        const standing = this.induction.standing(worker);
        // A request Speck's own state shows unsettled cannot be complete: while
        // the surviving rules still disagree on an unseen item, the answer is
        // provisional whatever the writer marked it.
        if (action.action === "complete" && standing && unsettled(standing))
            action = { ...action, action: "provisional" };
        // A reply the worker already gave, word for word, to a different
        // message does not answer this one.
        const repetition = execution.repetitionGate.review({ action, inferred }, this.view.repeatsEarlierReply(worker, action.response)
            ? ["Your reply repeats an earlier reply word for word, but the user's current message is different. Reply to the current message."]
            : []);
        if (repetition.rejected) {
            execution.lastRejection = repetition.faults.join(" ");
            return this.endCycle(execution, { madeProgress: epistemicProgress, action: "repeated-reply", validAction: true, error: execution.lastRejection });
        }
        // A reply never says an action was carried out that Speck's record shows
        // was not. Unlike the gated checks this one is not relaxed on a second
        // attempt: what it rejects is known to be false.
        const unfounded = this.validators.actionClaims(worker, action.response, inferred.response);
        if (unfounded.length) {
            execution.lastRejection = unfounded.join(" ");
            return this.endCycle(execution, { madeProgress: epistemicProgress, action: "unperformed-action-claimed", validAction: true, error: execution.lastRejection });
        }
        // Only a reply that is not known to be false can be what the user is
        // left with if the cycle budget runs out.
        execution.lastResponse = action.response || execution.lastResponse;
        // A reply that could not settle the request is cognitive demand: before
        // it is accepted, candidate hypotheses are generated and checked, and
        // the reply is written again from that state. Hypotheses Speck already
        // holds by induction meet that demand, so the reply stands.
        // A lone request holds nothing to check readings of it against, so its
        // uncertain reply goes to the user as it is (S18).
        if ((action.action === "question" || action.action === "provisional") && !execution.hypothesesGenerated && !standing && await this.hypotheses.checkable(worker)) {
            execution.uncertainty = action.action === "question" ? "the reply could not proceed without more information" : "the reply could only answer provisionally";
            return this.endCycle(execution, { madeProgress: epistemicProgress, action: "uncertain-reply", validAction: true }, { retry: "Retrying from hypotheses after an uncertain reply." });
        }
        // A reply's conclusions are claims: each is held as a hypothesis and
        // checked by another model against what the user said (S30). A claim the
        // user's statements contradict turns the reply back, and is cognitive
        // demand: competing hypotheses are generated before it is written again.
        if (!standing && action.response) {
            const contradicted = await this.hypotheses.contradictedClaims(worker, action.response, inferred.response.processorId);
            const claims = execution.claimGate.review({ action, inferred }, contradicted);
            if (claims.rejected) {
                execution.lastRejection = claims.faults.join(" ");
                execution.uncertainty ??= "a claim in the reply was contradicted by what the user said";
                return this.endCycle(execution, { madeProgress: epistemicProgress, action: "contradicted-claim", validAction: true, error: execution.lastRejection });
            }
            ({ action, inferred } = claims.value);
            execution.lastResponse = action.response || execution.lastResponse;
        }
        // A reply written from Speck's reasoning state must say what the state
        // says. Every such reply is checked and the outcome recorded.
        const groundable = standing ? groundableInduction(standing) : null;
        if (groundable && action.response) {
            const faults = await this.validators.grounding(worker, action.response, `${worker.objective.description}\n${instruction}`, groundable, inferred.response);
            const grounding = execution.groundingGate.review({ action, inferred }, faults);
            if (grounding.rejected) {
                execution.lastRejection = `Your reply does not match Speck's reasoning state. ${grounding.faults.join(" ")}`;
                return this.endCycle(execution, { madeProgress: epistemicProgress, action: "ungrounded-reply", validAction: true, error: execution.lastRejection });
            }
            ({ action, inferred } = grounding.value);
            // Shortcut S23 (docs/COGNITIVE_SHORTCUTS.md): a count Speck holds is not
            // left wrong in the kept reply. Once the writer has been told and still
            // miscounts, Speck sets the number itself, and records that it did.
            let counted = action.response;
            for (const { noun, value } of groundable.counts)
                counted = correctCounts(counted, noun, value);
            if (counted !== action.response) {
                this.runtime.recordJudgment({
                    producerId: inferred.response.processorId, contract: replyContract.name, protocol: inferred.response.toolCalling ?? "json",
                    aspect: "quality", evaluator: "deterministic", verdict: "rejected", deterministicOutcome: "count-corrected",
                    context: { workerId: worker.id, written: action.response, corrected: counted }
                });
                action = { ...action, response: counted };
            }
            execution.lastResponse = action.response;
        }
        // The cycle's action is recorded once the reply has passed Speck's
        // checks, in the writer's words (before Speck adds its own statement).
        // A rejected draft recorded as what the cycle did was recalled into
        // later prompts, repeating the claim that had been rejected.
        await this.integrateModelAction(worker, action, inferred.object);
        // What Speck alone derives is stated in Speck's words (S24), and
        // recorded so what the writer wrote and what Speck added stay distinct.
        if (standing && groundable) {
            const statement = action.response ? renderInductionStatement(standing, action.response, (text) => groundable.conclusion?.statedIn(text) ?? true) : null;
            if (statement) {
                action = { ...action, response: `${action.response}\n\n${statement}` };
                execution.lastResponse = action.response;
            }
            await this.runtime.setWorldState({ workerId: worker.id, key: "speck.replyStatement", value: statement ?? "", epistemicStatus: "observed", confidence: 1, actor: actor("controller") });
            if (statement) {
                const earlier = this.runtime.getWorker(worker.id)?.worldState[STATED_BY_SPECK]?.value;
                await this.runtime.setWorldState({
                    workerId: worker.id, key: STATED_BY_SPECK, value: [...(Array.isArray(earlier) ? earlier : []), statement].slice(-24),
                    epistemicStatus: "observed", confidence: 1, actor: actor("controller")
                });
            }
        }
        return { draft: { action, inferred } };
    }
    // A reviewed reply either waits for the user (when a validator agrees the
    // wait is justified) or is proposed as the answer and validated by another
    // model; anything else goes round again.
    async settleStage(execution, draft, epistemicProgress) {
        const worker = execution.worker;
        const { action, inferred } = draft;
        if (action.action === "question" || action.action === "provisional") {
            // Waiting must be justified: blocked only when progress needs the
            // user, provisional only with the best answer the evidence supports.
            const wait = await this.validators.wait(worker, action, inferred.response.processorId);
            this.runtime.recordJudgment({
                producerId: inferred.response.processorId, contract: replyContract.name, protocol: inferred.response.toolCalling ?? "json",
                aspect: "quality", evaluator: wait.judged ? wait.validatorId : null,
                verdict: !wait.judged ? "unobserved" : wait.justified ? "accepted" : "rejected",
                deterministicOutcome: null, context: { role: "worker", state: action.action, workerId: worker.id }
            });
            // A validator that could not judge does not trap the user's turn.
            if (wait.justified || !wait.judged)
                return this.settlement.waitForUser(worker, action.response, action.action === "question" ? "blocked" : "awaiting-input");
            execution.lastRejection = wait.reason;
            return this.endCycle(execution, { madeProgress: epistemicProgress, action: "wait-rejected", validAction: true, error: wait.reason });
        }
        if (action.action === "continue") {
            return this.endCycle(execution, { madeProgress: false, action: "empty-reply", validAction: true });
        }
        return this.settleCompletion(execution, action.response, draft);
    }
    async settleCompletion(execution, finalResponse, draft) {
        const worker = execution.worker;
        const { inferred } = draft;
        const prediction = this.runtime.config.predictiveLoop.enabled
            ? await this.runtime.createPrediction({
                workerId: worker.id,
                spec: { description: COMPLETION_EXPECTATION, confidence: inferred.response.confidence, sourceChannel: "completion", conditions: [{ path: "satisfied", operator: "equals", value: true }] },
                actor: actor("completion-prediction")
            }) : null;
        const validation = await this.validators.completion(worker, finalResponse, inferred.response.processorId, execution.specialty);
        if (prediction) {
            await this.runtime.comparePredictionToObservation({
                workerId: worker.id, predictionId: prediction.id, observationId: validation.observation.id,
                actual: { satisfied: validation.satisfied, reason: validation.reason }, actor: actor("completion-validation")
            });
        }
        if (this.runtime.config.metacognition.enabled) {
            await this.runtime.recordModelOutcome({
                workerId: worker.id, processorId: inferred.response.processorId,
                reportedConfidence: inferred.response.confidence, reward: validation.satisfied ? 1 : 0,
                sourceObjectId: inferred.object.id, actor: actor("completion-calibration")
            });
        }
        // The validator's verdict is evidence about the reply's writer only when
        // the validator is a different model and actually judged.
        this.runtime.recordJudgment({
            producerId: inferred.response.processorId, contract: replyContract.name, protocol: inferred.response.toolCalling ?? "json",
            aspect: "quality", evaluator: validation.judged ? validation.validatorId : null,
            verdict: !validation.judged ? "unobserved" : validation.satisfied ? "accepted" : "rejected",
            deterministicOutcome: null,
            context: { role: "worker", specialty: execution.specialty ?? "general", workerId: worker.id, toolsRun: execution.demonstrated.length }
        });
        if (validation.satisfied) {
            // Only an episode whose result passed validation is evidence that its
            // tool steps solve this kind of objective.
            // Shortcut S15 (docs/COGNITIVE_SHORTCUTS.md).
            if (this.runtime.config.procedures.enabled && execution.demonstrated.length) {
                await this.runtime.recordProcedureDemonstration({
                    workerId: worker.id, trigger: worker.objective.description,
                    steps: execution.demonstrated.map(({ intent }) => ({ kind: "tool", intent })), episodeId: execution.demonstrated.at(-1).outcomeId,
                    actor: actor("procedure-learning")
                });
            }
            return this.settlement.complete(this.runtime.getWorker(worker.id), finalResponse, validation.observation, validation.reason, execution.specialty ?? "general", true, false);
        }
        execution.lastRejection = validation.reason;
        execution.uncertainty ??= "a proposed answer was rejected";
        await this.runtime.setWorldState({
            workerId: worker.id, key: "genesis.lastRejectedReply", value: validation.reason,
            epistemicStatus: "observed", confidence: 1, actor: actor("completion-validation")
        });
        return this.endCycle(execution, { madeProgress: false, action: "completion-rejected", validAction: true, error: validation.reason });
    }
    // Ends a cycle that did not settle the task. On an impasse, one recovery is
    // tried. A run that cannot recover waits, or, when it has a concrete next
    // attempt, closes the impasse with that reason and retries: a run never
    // carries on while its worker is in impasse, or it could settle a task
    // whose worker stays stuck there.
    async endCycle(execution, record, handling = "wait") {
        execution.worker = await this.runtime.completeCycle(execution.worker.id, { ...record, actor: actor("controller") });
        if (execution.worker.status !== "impasse")
            return "next";
        const recovered = await this.recollection.recoverImpasse(execution.worker, execution.specialty, execution.recoveredImpasses);
        if (recovered) {
            execution.worker = recovered;
            return "next";
        }
        const impasseId = execution.worker.metacognition?.activeImpasseId;
        if (handling === "wait" || !impasseId)
            return this.handOffImpasse(execution.worker);
        const resolved = (await this.runtime.resolveImpasse({
            workerId: execution.worker.id, impasseId, resolution: handling.retry, nextStatus: "ready", actor: actor("impasse-retry")
        })).worker;
        execution.worker = await this.runtime.transitionWorker(resolved.id, "executing", actor("impasse-retry"), handling.retry);
        return "next";
    }
    // An impasse no route recovered is handed to the user: it is closed as
    // handed over, and the task waits with a question the user can answer, so
    // the conversation can continue it. Left in impasse, a task can be neither
    // continued nor seen to be stuck.
    async handOffImpasse(input) {
        let worker = this.runtime.getWorker(input.id) ?? input;
        const impasseId = worker.metacognition?.activeImpasseId;
        if (impasseId) {
            worker = (await this.runtime.resolveImpasse({
                workerId: worker.id, impasseId, resolution: "Handed to the user: retrieval and escalation did not recover it.",
                nextStatus: "waiting", actor: actor("impasse-handoff")
            })).worker;
        }
        return this.settlement.waitForUser(worker, STUCK_QUESTION, "blocked");
    }
    // A model response is a proposal, not proof of progress: each cycle's
    // action is recorded as an observation, and only runtime-observed effects
    // (for example, a successful tool outcome) credit progress.
    async integrateModelAction(worker, action, reflection) {
        const episodeInput = {
            workerId: worker.id,
            content: `Cycle action ${action.action}: ${action.response || "no response"}`,
            confidence: reflection.confidence, importance: 0.4,
            data: {
                cognitiveRole: "worker", action: action.action,
                progressAccepted: false, sourceObjectId: reflection.id,
                consolidationKey: normalizedKey(worker.objective.description)
            },
            actor: actor("cycle-observation")
        };
        const episode = this.runtime.memoryAdmissionPolicy.reasoningCycles
            ? await this.runtime.recordMemory({ ...episodeInput, type: "episodic" })
            : await this.runtime.createMentalObject({ ...episodeInput, kind: "observation", memoryRoles: [] });
        await this.runtime.competeForWorkingMemory({
            workerId: worker.id, candidateIds: [reflection.id, episode.id], actor: actor("cognitive-integration")
        });
    }
}
//# sourceMappingURL=controller.js.map