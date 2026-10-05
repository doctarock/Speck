// Induction as a task carries it out: a model reads the labelled examples in
// each of the user's messages (and the item claims in a reply); Speck keeps
// the rule hypotheses consistent with every example (src/cognition/induction.ts)
// and reads where they stand (src/cognition/induction-standing.ts).
import { rankHypotheses } from "../../belief/revision.js";
import { assess, isInductionItem, ruleKey, survivingRules } from "../../cognition/induction.js";
import { confirmingExamples, learnable, standingOf } from "../../cognition/induction-standing.js";
import { exampleExtractionContract } from "./contracts.js";
import { quotedIn } from "./statements.js";
import { actor, roleProcessor } from "./support.js";
import { MAXIMUM_ACTIVE_HYPOTHESES } from "./task-evidence.js";
export class InductionWork {
    runtime;
    evidence;
    constructor(runtime, evidence) {
        this.runtime = runtime;
        this.evidence = evidence;
    }
    state(worker) {
        const value = this.runtime.getWorker(worker.id)?.worldState["speck.induction"]?.value;
        return value && typeof value === "object" && Array.isArray(value.examples)
            ? value : null;
    }
    // Where the task's induction stands, from the examples it holds and the
    // rule hypotheses it holds (in ranked order); null while the examples are
    // not enough to learn from.
    standing(worker) {
        const induction = this.state(worker);
        if (!induction || !learnable(induction.examples))
            return null;
        return standingOf(induction.examples, heldRules(this.runtime.mentalObjects.listForWorker(worker.id).filter((object) => object.kind === "hypothesis")));
    }
    // Extracts labelled examples from task evidence not yet read (a model's
    // work, each example grounded in the user's words), then keeps the rule
    // hypotheses consistent with every example: a rule gains support when an
    // example confirms what it predicted from the earlier ones, and is refuted
    // outright by a counter-example. Reports whether induction applies (the
    // evidence holds examples with at least two labels) and whether a held rule
    // was refuted.
    async induce(worker) {
        const state = this.state(worker) ?? { examples: [], extracted: [] };
        let examples = [...state.examples];
        const extracted = [...state.extracted];
        let labelled = state.labelled ?? 0;
        // Extraction is the intake role's work, as for facts.
        const extractor = roleProcessor(this.runtime, "intake");
        for (const observation of this.evidence.messages(worker)) {
            if (extracted.includes(observation.id))
                continue;
            let reading = await this.readExamples(worker, extractor, observation);
            // In a task already learning from examples, "this message has none" is
            // a claim worth a second, independent reading.
            if (reading !== null && !reading.examples.length && examples.length >= 2) {
                const second = this.runtime.independentProcessor(extractor, exampleExtractionContract.name);
                if (second)
                    reading = await this.readExamples(worker, second, observation) ?? reading;
            }
            if (reading === null)
                continue; // unread; tried again on the next cycle
            const found = reading.examples;
            labelled += reading.labelled;
            for (const example of found) {
                if (!examples.some((known) => known.item.toUpperCase() === example.item.toUpperCase()))
                    examples.push(example);
            }
            extracted.push(observation.id);
        }
        if (!learnable(examples)) {
            if (extracted.length !== state.extracted.length)
                await this.save(worker, { examples, extracted, labelled });
            return { active: false, refuted: false };
        }
        examples = examples.map((example) => ({ ...example }));
        await this.save(worker, { examples, extracted, labelled });
        let refuted = false;
        const held = this.runtime.mentalObjects.listForWorker(worker.id).filter((object) => object.kind === "hypothesis" && object.data.inductionRule);
        for (const hypothesis of held) {
            if (["rejected", "superseded"].includes(String(hypothesis.data.status)))
                continue;
            const rule = hypothesis.data.inductionRule;
            const assessment = assess(rule, examples);
            if (!assessment.consistent && assessment.counterExample) {
                await this.runtime.reviseHypothesesFromEvidence({
                    workerId: worker.id, evidenceId: assessment.counterExample.evidenceId,
                    relations: [{ hypothesisId: hypothesis.id, direction: "contradicts", decisive: true }],
                    actor: { kind: "runtime", source: "speck-controller:induction" }
                });
                refuted = true;
                continue;
            }
            await this.support(worker, hypothesis.id, rule, examples);
            // The rule's mapping grows as new values are seen; its statement follows.
            if (assessment.description !== hypothesis.content) {
                await this.runtime.restateHypothesis({ workerId: worker.id, hypothesisId: hypothesis.id, content: assessment.description, actor: { kind: "runtime", source: "speck-controller:induction" } });
            }
        }
        const heldKeys = new Set(held.map((hypothesis) => ruleKey(hypothesis.data.inductionRule)));
        let active = this.evidence.activeHypotheses(worker).length;
        for (const survivor of survivingRules(examples)) {
            if (active >= MAXIMUM_ACTIVE_HYPOTHESES)
                break;
            if (heldKeys.has(survivor.key))
                continue;
            const adopted = await this.runtime.proposeHypothesis({
                workerId: worker.id, content: survivor.description, confidence: 0.5,
                data: { inductionRule: survivor.rule },
                actor: { kind: "runtime", source: "speck-controller:induction" }
            });
            active += 1;
            await this.support(worker, adopted.id, survivor.rule, examples);
        }
        return { active: true, refuted };
    }
    // The item → label pairs a processor reads in a text, each grounded in the
    // text's own words; null when the reading failed.
    async readLabelledPairs(worker, processorId, text, source) {
        try {
            // Asked for as one list: in native tool calling small models return a
            // single call per reply, which drops every example after the first.
            const reading = await this.runtime.inferForWorker({
                workerId: worker.id, ...(processorId ? { processorId } : {}), contract: exampleExtractionContract, contextScope: "minimal",
                instruction: `List the labelled examples in ${source}.\n${source === "the reply" ? "REPLY" : "USER MESSAGE"}:\n${text}`,
                actor: actor("example-extraction")
            });
            const raw = Array.isArray(reading.response.structured?.examples) ? reading.response.structured.examples : [];
            const found = [];
            for (const entry of raw) {
                if (!entry || typeof entry !== "object")
                    continue;
                const item = String(entry.item ?? "").trim();
                const label = String(entry.label ?? "").trim();
                // A pair the text does not contain was not read from it.
                if (!item || !label || !quotedIn(item, text) || !quotedIn(label, text))
                    continue;
                found.push({ item, label });
            }
            return found;
        }
        catch {
            return null;
        }
    }
    // The labelled examples a processor reads in one message, each grounded in
    // the user's words; null when the reading failed.
    // Only items induction can describe are examples (S25): "my wife's name is
    // Hippie" read as a pair is not one.
    // Also counts every grounded pair read, examples or not.
    async readExamples(worker, processorId, observation) {
        const pairs = await this.readLabelledPairs(worker, processorId, observation.content, "the user's message");
        return pairs && {
            examples: pairs.filter((pair) => isInductionItem(pair.item)).map((pair) => ({ ...pair, evidenceId: observation.id })),
            labelled: pairs.length
        };
    }
    // A rule gains support from each message whose example it predicted.
    async support(worker, hypothesisId, rule, examples) {
        for (const evidenceId of new Set(confirmingExamples(rule, examples).map((example) => example.evidenceId))) {
            await this.runtime.reviseHypothesesFromEvidence({
                workerId: worker.id, evidenceId: evidenceId, relations: [{ hypothesisId, direction: "supports" }],
                actor: { kind: "runtime", source: "speck-controller:induction" }
            });
        }
    }
    async save(worker, state) {
        await this.runtime.setWorldState({
            workerId: worker.id, key: "speck.induction", value: state,
            epistemicStatus: "observed", confidence: 1, actor: actor("induction")
        });
    }
}
// The rule hypotheses among a task's hypotheses, ranked, as held rules.
export function heldRules(hypotheses) {
    return rankHypotheses(hypotheses.filter((hypothesis) => hypothesis.data.inductionRule))
        .map((hypothesis) => ({ rule: hypothesis.data.inductionRule, confidence: hypothesis.confidence }));
}
//# sourceMappingURL=induction-work.js.map