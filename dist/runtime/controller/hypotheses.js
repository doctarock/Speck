// Hypotheses a task holds: generated only on cognitive demand, checked against
// every message the user sends, and shown to the writer as Speck has checked
// them. Labelled examples are handled by induction instead of a model.
//
// Any other hypothesis is checked through its requirements: what must be
// true if it is, each a proposition one statement can settle. A model that has
// been measured qualified for atomic entailment judges each requirement
// against one statement; Speck applies the consequences. No model is asked
// whether a hypothesis holds.
import { rankHypotheses } from "../../belief/revision.js";
import { learnable, standingOf } from "../../cognition/induction-standing.js";
import { renderInductionReport } from "../../cognition/induction-render.js";
import { entailmentLabel, entailmentRequest } from "../../metacognition/qualification.js";
import { hypothesisGenerationContract, replyClaimsContract, requirementsContract } from "./contracts.js";
import { heldRules } from "./induction-work.js";
import { MESSAGE_MATERIAL } from "./intake.js";
import { hypothesisKey, stringList } from "./statements.js";
import { actor, roleProcessor } from "./support.js";
import { HYPOTHESIS_CHECK_STRENGTH, MAXIMUM_ACTIVE_HYPOTHESES } from "./task-evidence.js";
// Shortcut S30 (docs/COGNITIVE_SHORTCUTS.md): how many of a reply's claims,
// and how many requirements of a hypothesis, are checked.
const MAXIMUM_CHECKED_CLAIMS = 3;
const MAXIMUM_REQUIREMENTS = 5;
const CHECKED = "speck.hypothesisChecks";
const REQUIREMENTS = "speck.hypothesisRequirements";
const JUDGMENTS = "speck.propositionJudgments";
export class HypothesisWork {
    runtime;
    view;
    evidence;
    induction;
    constructor(runtime, view, evidence, induction) {
        this.runtime = runtime;
        this.view = view;
        this.evidence = evidence;
        this.induction = induction;
    }
    // Records what the user has said as evidence, then brings every active
    // hypothesis up to date with it: rules by induction, other hypotheses
    // through their requirements. Returns whether any hypothesis was newly
    // contradicted.
    async update(worker) {
        await this.evidence.ingestConversation(worker);
        let contradicted = false;
        // Induction is Speck's own work, not a response to demand: it runs once
        // the task holds examples, which intake reads from each message (S25).
        // Waiting for an uncertain reply left a confident writer guessing alone
        // once a task carried on across its episode.
        const material = this.runtime.getWorker(worker.id)?.worldState[MESSAGE_MATERIAL]?.value;
        if (this.induction.state(worker) || (Array.isArray(material?.examples) && material.examples.length > 0)) {
            contradicted = (await this.induction.induce(worker)).refuted;
        }
        for (const hypothesis of this.evidence.activeHypotheses(worker).filter((held) => !held.data.inductionRule)) {
            if ((await this.check(worker, hypothesis)).contradictions.length)
                contradicted = true;
        }
        return contradicted;
    }
    // Shortcut S30 (docs/COGNITIVE_SHORTCUTS.md): the conclusions a reply draws
    // are claims, so each is held as a hypothesis and checked, through its
    // requirements, against everything the user said before the reply is kept.
    // Returns what to tell the writer about each claim a statement
    // contradicts. Only a task with more than one message has evidence besides
    // the request the reply answers; tasks Speck reasons about by induction are
    // checked against the induction state instead.
    async contradictedClaims(worker, reply, writerId) {
        if (this.evidence.messages(worker).length < 2 || !reply.trim())
            return [];
        let claims;
        try {
            // Reading its own reply's conclusions is extraction by the writer's
            // model, not a judgment of them; they are judged through requirements.
            const read = await this.runtime.inferForWorker({
                workerId: worker.id, processorId: writerId, contract: replyClaimsContract, contextScope: "minimal",
                instruction: `WHAT THE USER SAID (oldest first):\n${this.evidence.messages(worker).map((message) => `- ${message.content}`).join("\n")}\n\nREPLY:\n${reply}`,
                actor: actor("claim-reading")
            });
            claims = stringList(read.response.structured?.claims, MAXIMUM_CHECKED_CLAIMS);
        }
        catch {
            return [];
        }
        const faults = [];
        for (const claim of claims) {
            const held = this.runtime.mentalObjects.listForWorker(worker.id)
                .find((object) => object.kind === "hypothesis" && hypothesisKey(object.content) === hypothesisKey(claim));
            if (!held && await this.statedByUser(worker, claim, writerId))
                continue;
            const hypothesis = held ?? (await this.adopt(worker, writerId, [claim], { claimedInReply: true }))[0];
            if (!hypothesis)
                continue;
            const { contradictions } = await this.check(worker, hypothesis);
            const recorded = this.contradictions(worker, hypothesis);
            const first = contradictions[0] ?? recorded[0];
            if (first)
                faults.push(`Your reply states: "${claim}". That requires "${first.requirement}", but the user said: "${first.observation.content}". Do not state the claim as established or explain the contradiction by assuming it; say what the evidence supports instead.`);
        }
        return faults;
    }
    // Shortcut S18 (docs/COGNITIVE_SHORTCUTS.md): whether the task holds
    // anything a hypothesis could be checked against besides the request it
    // would interpret: more than one message from the user, or at least two
    // labelled pairs read from what the user said (examples, whether induction
    // can describe them or not). A lone request has nothing; readings of it
    // can only be settled by asking.
    async checkable(worker) {
        if (this.evidence.messages(worker).length > 1)
            return true;
        await this.induction.induce(worker);
        return (this.induction.state(worker)?.labelled ?? 0) >= 2;
    }
    // Shortcut S18 (docs/COGNITIVE_SHORTCUTS.md): hypotheses are generated only
    // on cognitive demand, read from the cycle's own state: the worker could
    // only answer provisionally or not at all, a proposed answer was rejected,
    // a claim in a reply was contradicted, or new evidence contradicted a held
    // hypothesis. A request answered with confidence never generates any.
    async generate(worker, processorId, demand) {
        // Deterministic paths come first: if the task's evidence is labelled
        // examples, Speck induces and checks the rules itself.
        if ((await this.induction.induce(worker)).active) {
            await this.recordDemand(worker, demand, "induction");
            return;
        }
        try {
            const generated = await this.runtime.inferForWorker({
                workerId: worker.id, ...(processorId ? { processorId } : {}), contract: hypothesisGenerationContract,
                instruction: `List the hypotheses still possible.${this.view.taskContext(worker)}${this.view.conversationInstruction(worker)}${this.state(worker)}\nCURRENT MESSAGE:\n${this.view.currentMessage(worker)}`,
                actor: actor("hypothesis-generation")
            });
            await this.adopt(worker, generated.response.processorId, stringList(generated.response.structured?.hypotheses, MAXIMUM_ACTIVE_HYPOTHESES));
            await this.recordDemand(worker, demand, "hypothesis-generation");
        }
        catch { /* no hypotheses this cycle; the reply proceeds without them */ }
    }
    // The task's hypotheses as Speck has checked them, most supported first.
    state(worker) {
        const hypotheses = rankHypotheses(this.runtime.mentalObjects.listForWorker(worker.id).filter((object) => object.kind === "hypothesis"));
        if (!hypotheses.length)
            return "";
        const induction = this.induction.state(worker);
        const current = this.evidence.currentEvidenceId(worker);
        // The rules replace the hypotheses only when there are examples to learn
        // from; a record of messages read with no examples in them is not that.
        if (induction && learnable(induction.examples))
            return renderInductionReport(standingOf(induction.examples, heldRules(hypotheses)), current);
        const changed = [];
        const judgments = this.judgments(worker);
        const lines = hypotheses.map((hypothesis) => {
            if (current && stringList(hypothesis.data.contradictoryEvidence, 1000).includes(current))
                changed.push(`- inconsistent with: ${hypothesis.content}`);
            else if (current && stringList(hypothesis.data.supportingEvidence, 1000).includes(current))
                changed.push(`- consistent with: ${hypothesis.content}`);
            const consistent = Array.isArray(hypothesis.data.supportingEvidence) ? hypothesis.data.supportingEvidence.length : 0;
            const contradicting = stringList(hypothesis.data.contradictoryEvidence, 1000);
            // Which of the user's statements turned against it, and which of its
            // requirements they ruled out, so a reply can say what changed and why.
            const against = this.contradictions(worker, hypothesis)
                .map(({ observation, requirement }) => `\n    contradicted by: "${observation.content}" (it requires: ${requirement})`).join("");
            const unverified = (judgments[hypothesis.id] ?? []).some((judgment) => judgment.label === "void") && !contradicting.length && !consistent
                ? "; unverified: no model is qualified to check it" : "";
            return `- ${hypothesis.content} [${String(hypothesis.data.status ?? "proposed")}, confidence ${hypothesis.confidence.toFixed(2)}; supported by ${consistent} later message${consistent === 1 ? "" : "s"}, inconsistent with ${contradicting.length}${unverified}]${against}`;
        });
        return `\nHYPOTHESES (checked by Speck against each of the user's messages; only messages sent after a hypothesis was proposed can support it; most supported first):\n${lines.join("\n")}${changed.length ? `\nWHAT THE CURRENT MESSAGE CHANGED:\n${changed.join("\n")}` : ""}`;
    }
    // Checks a hypothesis against each message it has not been checked
    // against, through its requirements, and applies the consequences:
    //   - a message that contradicts any requirement contradicts the hypothesis;
    //   - otherwise one that entails a requirement supports it, but only if it
    //     came after the hypothesis: fitting what it was written to fit is no
    //     evidence, and counted as support it made a restatement of the request
    //     look confirmed (S18, as for induced rules in S19);
    //   - with no qualified checker the judgment is void and nothing changes.
    //     The message stays unchecked, so a checker qualified later reads it.
    async check(worker, hypothesis) {
        const outcome = { contradictions: [], void: false };
        const messages = this.evidence.messages(worker);
        const checked = this.recorded(worker, CHECKED);
        const pending = messages.filter((message) => !(checked[hypothesis.id] ?? []).includes(message.id));
        if (!pending.length)
            return outcome;
        const proposer = hypothesis.provenance?.actorId ?? roleProcessor(this.runtime, "worker");
        const checker = this.runtime.qualifiedProcessor(proposer, "atomic-entailment");
        const judgments = this.judgments(worker);
        const kept = [...(judgments[hypothesis.id] ?? [])];
        if (!checker) {
            const voided = new Set(kept.filter((judgment) => judgment.label === "void").map((judgment) => judgment.evidenceId));
            const fresh = pending.filter((message) => !voided.has(message.id));
            if (fresh.length) {
                const at = new Date().toISOString();
                kept.push(...fresh.map((message) => ({ evidenceId: message.id, requirement: "", checker: null, label: "void", impact: "none", at })));
                await this.record(worker, JUDGMENTS, { ...judgments, [hypothesis.id]: kept });
            }
            outcome.void = true;
            return outcome;
        }
        const requirements = await this.requirements(worker, hypothesis, proposer);
        if (!requirements)
            return outcome;
        const done = [...(checked[hypothesis.id] ?? [])];
        for (const observation of pending) {
            const labels = [];
            let usable = true;
            for (const requirement of requirements) {
                try {
                    const judged = await this.runtime.inferForWorker({
                        workerId: worker.id, processorId: checker, contextScope: "minimal",
                        ...entailmentRequest(observation.content, requirement), actor: actor("proposition-check")
                    });
                    const label = entailmentLabel(judged.response.structured?.label);
                    if (!label) {
                        usable = false;
                        break;
                    }
                    labels.push({ requirement, label });
                }
                catch {
                    usable = false;
                    break;
                }
            }
            // A message is checked whole or not at all: an unusable judgment is
            // retried on the next cycle rather than leaving half a verdict.
            if (!usable)
                continue;
            const contradicted = labels.find((entry) => entry.label === "contradiction");
            const supports = !contradicted && labels.some((entry) => entry.label === "entailment") && observation.createdAt > hypothesis.createdAt;
            const at = new Date().toISOString();
            kept.push(...labels.map(({ requirement, label }) => ({
                evidenceId: observation.id, requirement, checker, label, at,
                impact: label === "contradiction" ? "contradicts" : label === "entailment" && supports ? "supports" : "none"
            })));
            if (contradicted || supports) {
                await this.runtime.reviseHypothesesFromEvidence({
                    workerId: worker.id, evidenceId: observation.id,
                    relations: [{ hypothesisId: hypothesis.id, direction: contradicted ? "contradicts" : "supports", strength: HYPOTHESIS_CHECK_STRENGTH }],
                    actor: { kind: "model", source: checker, actorId: checker }
                });
            }
            if (contradicted)
                outcome.contradictions.push({ observation, requirement: contradicted.requirement });
            done.push(observation.id);
        }
        await this.record(worker, JUDGMENTS, { ...this.judgments(worker), [hypothesis.id]: kept });
        await this.record(worker, CHECKED, { ...this.recorded(worker, CHECKED), [hypothesis.id]: done });
        return outcome;
    }
    // Whether one of the user's statements entails the claim, as judged by a
    // qualified checker: then the reply only restated it, and it is established,
    // not a conclusion to test. Without a qualified checker this cannot be told,
    // and the claim is held (unverified, it moves no belief).
    async statedByUser(worker, claim, writerId) {
        const checker = this.runtime.qualifiedProcessor(writerId, "atomic-entailment");
        if (!checker)
            return false;
        for (const message of this.evidence.messages(worker)) {
            try {
                const judged = await this.runtime.inferForWorker({
                    workerId: worker.id, processorId: checker, contextScope: "minimal",
                    ...entailmentRequest(message.content, claim), actor: actor("restatement-check")
                });
                if (entailmentLabel(judged.response.structured?.label) === "entailment")
                    return true;
            }
            catch { /* an unusable judgment says nothing either way */ }
        }
        return false;
    }
    // What must be true if the hypothesis is: written once, by the model that
    // proposed it (writing them is generation, not a judgment of anything),
    // and kept. Null when they could not be written this cycle.
    async requirements(worker, hypothesis, proposer) {
        const recorded = this.recorded(worker, REQUIREMENTS);
        if (recorded[hypothesis.id])
            return recorded[hypothesis.id];
        try {
            const written = await this.runtime.inferForWorker({
                workerId: worker.id, processorId: proposer, contract: requirementsContract, contextScope: "minimal",
                instruction: `HYPOTHESIS:\n${hypothesis.content}`, actor: actor("hypothesis-requirements")
            });
            const requirements = stringList(written.response.structured?.requirements, MAXIMUM_REQUIREMENTS);
            await this.record(worker, REQUIREMENTS, { ...recorded, [hypothesis.id]: requirements });
            return requirements;
        }
        catch {
            return null;
        }
    }
    // The messages that contradicted a hypothesis, each with the requirement
    // it ruled out, from the judgments kept.
    contradictions(worker, hypothesis) {
        const said = new Map(this.evidence.messages(worker).map((message) => [String(message.id), message]));
        const seen = new Set();
        return (this.judgments(worker)[hypothesis.id] ?? [])
            .filter((judgment) => judgment.impact === "contradicts" && said.has(judgment.evidenceId) && !seen.has(judgment.evidenceId) && seen.add(judgment.evidenceId))
            .map((judgment) => ({ observation: said.get(judgment.evidenceId), requirement: judgment.requirement }));
    }
    judgments(worker) {
        return this.recorded(worker, JUDGMENTS);
    }
    recorded(worker, key) {
        const value = this.runtime.getWorker(worker.id)?.worldState[key]?.value;
        return (value && typeof value === "object" ? { ...value } : {});
    }
    async record(worker, key, value) {
        await this.runtime.setWorldState({ workerId: worker.id, key, value, epistemicStatus: "observed", confidence: 1, actor: actor("hypothesis-check") });
    }
    // Records hypotheses the worker proposed that the task does not already
    // hold, up to the limit; returns the new ones.
    async adopt(worker, producerId, proposals, data) {
        if (!proposals.length)
            return [];
        const held = this.evidence.activeHypotheses(worker);
        const known = new Set(this.runtime.mentalObjects.listForWorker(worker.id)
            .filter((object) => object.kind === "hypothesis").map((object) => hypothesisKey(object.content)));
        const adopted = [];
        for (const proposal of proposals) {
            if (held.length + adopted.length >= MAXIMUM_ACTIVE_HYPOTHESES)
                break;
            if (known.has(hypothesisKey(proposal)))
                continue;
            known.add(hypothesisKey(proposal));
            adopted.push(await this.runtime.proposeHypothesis({
                workerId: worker.id, content: proposal, confidence: 0.5, ...(data ? { data } : {}),
                actor: { kind: "model", source: producerId, actorId: producerId }
            }));
        }
        return adopted;
    }
    async recordDemand(worker, demand, source) {
        await this.runtime.setWorldState({
            workerId: worker.id, key: "speck.hypothesisDemand", value: demand,
            epistemicStatus: "observed", confidence: 1, actor: actor(source)
        });
    }
}
//# sourceMappingURL=hypotheses.js.map