import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rankHypotheses } from "../belief/revision.js";
import { candidateRules, ruleKey, statesRule } from "../cognition/induction.js";
import { standingOf } from "../cognition/induction-standing.js";
import { countsOf } from "../cognition/claims.js";
import { SpeckController } from "../runtime/controller.js";
import { Conversation } from "../runtime/conversation.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
// A hypothesis that names exactly one example restates an observation; a rule
// names none (or cites several as illustration).
const isRule = (hypothesis) => (hypothesis.content.match(/A\d+/g) ?? []).length !== 1;
const rules = (hypotheses) => hypotheses.filter(isRule);
const changed = (before, after) => rules(after).some((hypothesis) => {
    const earlier = before.find((entry) => entry.content === hypothesis.content);
    return !earlier || Math.abs(earlier.confidence - hypothesis.confidence) > 1e-9;
});
const weakened = (hypotheses) => rules(hypotheses).filter((hypothesis) => hypothesis.inconsistent > 0 || ["weakening", "rejected"].includes(hypothesis.status));
// The rule-learning checks, for a conversation whose four rule turns start
// at `offset` (turns before them, such as a greeting, are not checked).
function ruleChecks(offset) {
    const at = (s, turn) => s[offset + turn];
    const after = (turn) => offset + turn + 1;
    return [
        { afterTurn: after(0), expectation: "evidence 1–3: several provisional hypotheses that are rules", check: (s) => rules(at(s, 0).hypotheses).length >= 2 ? null : `${rules(at(s, 0).hypotheses).length} rules among ${at(s, 0).hypotheses.length} hypotheses` },
        { afterTurn: after(0), expectation: "evidence 1–3: waits for more input instead of blocking", check: (s) => at(s, 0).waitKind === "awaiting-input" ? null : `status ${at(s, 0).status}, wait ${at(s, 0).waitKind ?? "none"}` },
        { afterTurn: after(1), expectation: "evidence 4–5: support changes", check: (s) => changed(at(s, 0).hypotheses, at(s, 1).hypotheses) ? null : "no hypothesis changed" },
        { afterTurn: after(2), expectation: "evidence 6: at least one hypothesis weakened or rejected", check: (s) => weakened(at(s, 2).hypotheses).length ? null : "none weakened" },
        { afterTurn: after(3), expectation: "evidence 7–8: surviving hypotheses revised", check: (s) => changed(at(s, 2).hypotheses, at(s, 3).hypotheses) ? null : "no hypothesis changed" },
        {
            // Evidence accumulates across the whole conversation, whatever task
            // answers each message.
            afterTurn: after(3), expectation: "final: Speck holds all 8 examples", check: (s) => {
                const items = at(s, 3).examples.map((example) => example.item);
                return items.length === 8 ? null : `holds ${items.length}: ${items.join(", ") || "none"}`;
            }
        },
        {
            afterTurn: after(3), expectation: "final: answer from the leading hypothesis", check: (s) => {
                const allowed = concluded(at(s, 3));
                if (!allowed.length)
                    return "Speck concluded no rule";
                return allowed.some((rule) => statesRule(at(s, 3).reply, rule.rule)) ? null : `reply does not state "${allowed[0].description}"`;
            }
        },
        {
            // The question asks which alternatives were considered: the reply names
            // at least one rule besides the one Speck concluded, surviving or refuted.
            afterTurn: after(3), expectation: "final: names an alternative that was considered", check: (s) => {
                const examples = at(s, 3).examples;
                const chosen = new Set(concluded(at(s, 3)).map((rule) => rule.key));
                const alternatives = candidateRules(examples).filter((rule) => !chosen.has(ruleKey(rule)));
                return alternatives.some((rule) => statesRule(at(s, 3).reply, rule)) ? null : "no other rule named";
            }
        },
        {
            // Faithfulness at every turn, not only the last, and of the writer's own
            // words (Speck states the conclusion itself when the writer leaves it
            // out, which must not count for the writer): each reply states the
            // rule Speck had concluded when it was written.
            afterTurn: after(3), expectation: "the writer stated the rule Speck had concluded, every turn", check: (s) => {
                const unfaithful = s.filter((snapshot) => {
                    const allowed = concluded(snapshot);
                    return allowed.length > 0 && !allowed.some((rule) => statesRule(snapshot.writerReply, rule.rule));
                });
                return unfaithful.length ? `turn ${unfaithful.map((snapshot) => snapshot.turn).join(", ")}` : null;
            }
        },
        {
            afterTurn: after(3), expectation: "final: proposes a discriminating, unseen example", check: (s) => {
                const seen = new Set(s.flatMap((snapshot) => snapshot.message.match(/A\d+/g) ?? []));
                const proposed = (at(s, 3).reply.match(/A\d+/g) ?? []).filter((label) => !seen.has(label));
                return proposed.length ? null : "no unseen example proposed";
            }
        },
        {
            // A count copied from an earlier reply ("all three examples" when Speck
            // holds five) is the stale-evidence symptom the operator found.
            afterTurn: after(3), expectation: "every reply's count of examples is the count Speck held", check: (s) => {
                const stale = s.filter((snapshot) => snapshot.examples.length && countsOf(snapshot.writerReply, "example").some((count) => count !== snapshot.examples.length));
                return stale.length ? stale.map((snapshot) => `turn ${snapshot.turn} says ${countsOf(snapshot.writerReply, "example").join("/")}, held ${snapshot.examples.length}`).join("; ") : null;
            }
        },
        {
            afterTurn: after(3), expectation: "no example is stored as a fact about the user", check: (s) => {
                const stored = s.at(-1).userFacts.filter((fact) => /\bA\d+\b/.test(fact));
                return stored.length ? stored.join("; ") : null;
            }
        },
        {
            afterTurn: after(3), expectation: "no tool runs for a message that is only examples", check: (s) => {
                const ran = [1, 2].filter((turn) => at(s, turn).toolCalls > 0).map((turn) => `turn ${offset + turn + 1}`);
                return ran.length ? ran.join(", ") : null;
            }
        }
    ];
}
const RULE_TURNS = [
    "I’m going to give you examples from an unknown classification system. Work out the rule, but don’t commit too early.\nA17 → Blue\nA24 → Red\nA31 → Blue",
    "A42 → Red\nA55 → Blue",
    "A63 → Blue",
    "A72 → Red\nA81 → Blue\nWhat rule do you currently believe is operating, what alternatives did you consider, and what single example would be most useful to see next?"
];
// The operator's incremental classification test (2026-10-02), verbatim.
export const INCREMENTAL_RULE_CASE = { id: "incremental-rule", turns: RULE_TURNS, checks: ruleChecks(0) };
// The same test as the operator ran it after a reset: an introduction first,
// in the same conversation (2026-10-02, verbatim).
export const OPERATOR_SESSION_CASE = {
    id: "operator-session",
    turns: ["hello Speck my name is Derek I will be your operator my wife's name is hippie my son's name is Felix and my daughter's name is Holly", ...RULE_TURNS],
    checks: ruleChecks(1)
};
// Sentences of a reply, and whether one asserts something without hedging or
// denying it. Deterministic stand-ins for reading the reply, for scoring only.
const sentences = (text) => text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
const HEDGED = /\b(not|no longer|unlikely|ruled out|rather than|instead of|may|might|could|possibly|coincid|does not|doesn't|did not|didn't|before|unrelated|weaken)/i;
const asserts = (text, subject, predicate) => sentences(text).filter((sentence) => subject.test(sentence) && predicate.test(sentence) && !HEDGED.test(sentence));
const CAUSED = /\b(caused|cause of|direct cause|responsible|led to|resulted in|triggered|brought down|due to)\b/i;
const STORAGE = /\b(storage|disk|controller|hypervisor)\b/i;
const restartHypotheses = (snapshot) => snapshot.hypotheses.filter((hypothesis) => /restart/i.test(hypothesis.content) && CAUSED.test(hypothesis.content));
// The operator's causal-revision test (2026-10-03), verbatim: an outage told
// in parts, where a later statement (the restart completed and the server
// stayed healthy) changes what an earlier one (Alice's restart at 2:13)
// means, and a storage path explains what follows.
export const CAUSAL_OUTAGE_CASE = {
    id: "causal-outage",
    turns: [
        "A server went offline at 2:14 AM. There were three administrators: Alice, Ben and Carla. Alice was logged into the admin panel at 2:11 AM.",
        "The audit log records Alice issuing a restart command at 2:13 AM.",
        "The restart command completed successfully at 2:13:18. The server remained healthy afterward.",
        "At 2:14:03 the hypervisor recorded the virtual disk disappearing.",
        "Ben had replaced a failing storage controller earlier that evening. Carla had no access to the hypervisor.",
        "Reconstruct the most likely causal sequence. Separate what is established from what you infer. Which earlier evidence changed meaning as later evidence arrived?"
    ],
    checks: [
        {
            afterTurn: 3, expectation: "a held restart-caused-it hypothesis is contradicted once the restart is known to have completed", check: (s) => {
                const held = restartHypotheses(s[2]);
                return held.every((hypothesis) => hypothesis.inconsistent > 0 || ["weakening", "rejected"].includes(hypothesis.status)) ? null : held.map((hypothesis) => `${hypothesis.content} [${hypothesis.status}]`).join("; ");
            }
        },
        {
            afterTurn: 6, expectation: "from turn 3 on, no reply states that the restart caused the outage", check: (s) => {
                const stated = s.slice(2).flatMap((snapshot) => asserts(snapshot.writerReply, /restart/i, CAUSED).map((sentence) => `turn ${snapshot.turn}: ${sentence}`));
                return stated.length ? stated.join(" | ") : null;
            }
        },
        {
            // Speck's state, not the writer's prose, must carry the revision: the
            // restart explanation was held and evidence moved it, so a writer that
            // happens to avoid the restart bait does not pass on its own.
            afterTurn: 3, expectation: "Speck held a restart-caused-it hypothesis and the evidence moved it by turn 3", check: (s) => {
                const held = restartHypotheses(s[2]);
                if (!held.length)
                    return "no restart-caused-it hypothesis held";
                return held.some((hypothesis) => hypothesis.inconsistent > 0) ? null : held.map((hypothesis) => `${hypothesis.content} [${hypothesis.status} +${hypothesis.consistent}/-${hypothesis.inconsistent}]`).join("; ");
            }
        },
        {
            afterTurn: 5, expectation: "a storage-path hypothesis has more confidence than any restart hypothesis after the disk and controller evidence", check: (s) => {
                const ranked = s[4].hypotheses;
                const storage = Math.max(-1, ...ranked.filter((hypothesis) => STORAGE.test(hypothesis.content) && CAUSED.test(hypothesis.content)).map((hypothesis) => hypothesis.confidence));
                const restart = Math.max(-1, ...restartHypotheses(s[4]).map((hypothesis) => hypothesis.confidence));
                if (storage < 0)
                    return `no storage-cause hypothesis among ${ranked.length}`;
                return storage > restart ? null : `storage ${storage.toFixed(2)}, restart ${restart.toFixed(2)}`;
            }
        },
        {
            afterTurn: 6, expectation: "final: names the storage path as the likely cause", check: (s) => sentences(s[5].reply).some((sentence) => STORAGE.test(sentence)) ? null : "no storage, disk, controller or hypervisor in the reply"
        },
        {
            afterTurn: 6, expectation: "final: says the restart's meaning changed once it was known to have completed", check: (s) => sentences(s[5].reply).some((sentence) => /restart/i.test(sentence) && /\b(completed|healthy|ruled out|unlikely|not the cause|no longer|coincid)/i.test(sentence)) ? null : "the restart is not revisited"
        },
        {
            afterTurn: 6, expectation: "final: does not assert that Ben caused it", check: (s) => {
                const stated = asserts(s[5].reply, /\bBen\b/, CAUSED);
                return stated.length ? stated.join(" | ") : null;
            }
        }
    ]
};
export const TRAJECTORY_CASES = [INCREMENTAL_RULE_CASE, OPERATOR_SESSION_CASE, CAUSAL_OUTAGE_CASE];
export async function runTrajectoryProbe(input) {
    const probe = input.probe ?? INCREMENTAL_RULE_CASE;
    const results = [];
    for (let repetition = 0; repetition < Math.max(1, input.repetitions ?? 1); repetition += 1) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-trajectory-"));
        const runtime = new SpeckRuntime({
            databasePath: path.join(directory, "speck.sqlite"),
            genesisRuntimePath: directory,
            modelRuntime: { processors: input.processors.map((processor) => ({ ...processor, enabled: true })), roles: input.roles, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) },
            ...(input.embeddingRuntime ? { embeddingRuntime: input.embeddingRuntime } : {})
        });
        const snapshots = [];
        try {
            for (const statement of input.history ?? [])
                await runtime.createWorker(statement);
            // As in the interface: Speck places each message in an episode and runs
            // the task that answers it.
            const conversation = new Conversation(runtime, "trajectory");
            let worker = null;
            for (let turn = 0; turn < probe.turns.length; turn += 1) {
                const message = probe.turns[turn];
                const received = await conversation.receive(message);
                worker = received.worker;
                const toolsBefore = toolOutcomes(runtime);
                const outcome = received.route === "closed"
                    ? { worker: received.worker, summary: received.summary ?? "" }
                    : await new SpeckController(runtime, { maxCycles: 6 }).run(worker.id);
                worker = outcome.worker;
                await conversation.replied(worker.id, outcome.summary);
                const snapshot = snapshotOf(runtime, worker, turn + 1, message, outcome.summary, toolOutcomes(runtime) - toolsBefore);
                snapshots.push(snapshot);
                input.onTurn?.(repetition, snapshot);
            }
        }
        finally {
            runtime.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
        const checks = probe.checks.map((entry) => {
            if (snapshots.length < entry.afterTurn)
                return { afterTurn: entry.afterTurn, expectation: entry.expectation, passed: false, reason: `the task closed after turn ${snapshots.length}` };
            const reason = entry.check(snapshots.slice(0, entry.afterTurn));
            return { afterTurn: entry.afterTurn, expectation: entry.expectation, passed: reason === null, reason: reason ?? "passed" };
        });
        results.push({ caseId: probe.id, repetition, snapshots, checks, passed: checks.filter((check) => check.passed).length, total: checks.length });
    }
    return results;
}
function toolOutcomes(runtime) {
    return runtime.mentalObjects.listAll().filter((object) => object.kind === "tool-outcome").length;
}
function snapshotOf(runtime, worker, turn, message, reply, toolCalls) {
    const hypotheses = rankHypotheses(runtime.mentalObjects.listForWorker(worker.id).filter((object) => object.kind === "hypothesis"));
    const wait = worker.worldState["genesis.waitKind"]?.value;
    return {
        turn, message, status: worker.status, waitKind: worker.status === "waiting" && typeof wait === "string" ? wait : null, reply,
        hypotheses: hypotheses.map((hypothesis) => ({
            content: hypothesis.content,
            confidence: hypothesis.confidence,
            status: String(hypothesis.data.status ?? "proposed"),
            consistent: Array.isArray(hypothesis.data.supportingEvidence) ? hypothesis.data.supportingEvidence.length : 0,
            inconsistent: Array.isArray(hypothesis.data.contradictoryEvidence) ? hypothesis.data.contradictoryEvidence.length : 0
        })),
        examples: inductionExamples(runtime.getWorker(worker.id) ?? worker),
        held: hypotheses.filter((hypothesis) => hypothesis.data.inductionRule).map((hypothesis) => ({ rule: hypothesis.data.inductionRule, confidence: hypothesis.confidence })),
        writerReply: writerPart(reply, runtime.getWorker(worker.id) ?? worker),
        userFacts: runtime.mentalObjects.listAll()
            .filter((object) => object.status !== "archived" && object.data.verification === "validated-user-disclosure")
            .map((object) => object.content),
        toolCalls
    };
}
function writerPart(reply, worker) {
    const added = worker.worldState["speck.replyStatement"]?.value;
    return typeof added === "string" && added && reply.endsWith(added) ? reply.slice(0, -added.length).trim() : reply;
}
function inductionExamples(worker) {
    const value = worker.worldState["speck.induction"]?.value;
    return Array.isArray(value?.examples) ? value.examples : [];
}
// The rule Speck's state supports presenting: the preferred rule, any rule
// equivalent to it, and any
// equally preferred one; none while no rule generalises.
function concluded(snapshot) {
    return snapshot.examples.length ? standingOf(snapshot.examples, snapshot.held).preferred.flatMap((entry) => [entry.assessment, ...entry.equivalent.map((same) => same.assessment)]) : [];
}
//# sourceMappingURL=trajectory-probe.js.map