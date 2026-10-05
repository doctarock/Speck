// Model-scale comparison: Speck with a given mix of processors against a naked
// model on the same cognitive tests, measured the same way.
//
// Both kinds of subject are scored on their replies, so the comparison is
// like for like. Speck is additionally measured on what only it has: whether
// its reasoning state matched the evidence, how often its checks turned a
// reply back, and how often its validators intervened. Every run records
// success, first-pass success, corrections, model calls, tokens, latency and
// peak GPU memory.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countsOf, ungroundedNumbers } from "../cognition/claims.js";
import { candidateRules, statesRule, survivingRules } from "../cognition/induction.js";
import { MAX_OUTPUT_TOKENS } from "../models/providers.js";
import { afterReasoning } from "../models/response.js";
import { SpeckController } from "../runtime/controller.js";
import { Conversation } from "../runtime/conversation.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import { runRoleProbe } from "./role-probe.js";
import { INCREMENTAL_RULE_CASE, OPERATOR_SESSION_CASE } from "./trajectory-probe.js";
// ---- cases ---------------------------------------------------------------
const RULE_EXAMPLES = [["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"], ["A42", "Red"], ["A55", "Blue"], ["A63", "Blue"], ["A72", "Red"], ["A81", "Blue"]]
    .map(([item, label], index) => ({ item: item, label: label, evidenceId: `e${index}` }));
const PARITY = survivingRules(RULE_EXAMPLES).find((rule) => rule.rule.feature === "parity of the number").rule;
const OTHER_RULES = candidateRules(RULE_EXAMPLES).filter((rule) => rule.feature !== "parity of the number");
// The final answer to the rule test, judged on the reply alone.
function ruleAnswerChecks(finalTurn) {
    const final = (replies) => replies[finalTurn] ?? "";
    return [
        { expectation: "final: states the parity rule", check: (replies) => statesRule(final(replies), PARITY) ? null : "parity not stated" },
        { expectation: "final: names an alternative that was considered", check: (replies) => OTHER_RULES.some((rule) => statesRule(final(replies), rule)) ? null : "no alternative named" },
        {
            expectation: "final: proposes an unseen example", check: (replies) => {
                const seen = new Set(RULE_EXAMPLES.map((example) => example.item));
                return (final(replies).match(/\bA\d+\b/g) ?? []).some((item) => !seen.has(item)) ? null : "no unseen example proposed";
            }
        },
        {
            expectation: "final: any count of the examples is 8", check: (replies) => {
                const wrong = countsOf(final(replies), "example").filter((count) => count !== 8);
                return wrong.length ? `says ${wrong.join("/")}` : null;
            }
        }
    ];
}
// Speck's state: all eight examples held, with parity as the conclusion.
function ruleState(runtime, worker) {
    const examples = worker.worldState["speck.induction"]?.value?.examples ?? [];
    if (examples.length !== 8)
        return `holds ${examples.length} examples`;
    const parity = runtime.mentalObjects.listForWorker(worker.id).find((object) => object.data.inductionRule?.feature === "parity of the number");
    return parity && String(parity.data.status) !== "rejected" ? null : "parity not held";
}
const SYNTHESIS_NOTES = "Here are my notes: The server room is on level 3. Backups run nightly at 2am. The UPS was replaced in March. Summarise these notes in two sentences.";
// The notes' three facts, however a faithful reply words them ("level 3" or
// "the third floor"; "2am" or "2 a.m.").
const SYNTHESIS_FACTS = [
    { name: "the server room's level", stated: /\blevel\s*3\b|\b(?:3rd|third)\s+(?:floor|level)\b|\bfloor\s*3\b/i },
    { name: "the backup time", stated: /\b2\s?a\.?m\b|\b2:00\b/i },
    { name: "the month the UPS was replaced", stated: /\bmarch\b/i }
];
export const COMPARE_CASES = [
    {
        id: "incremental-rule", tests: "incremental induction over symbolic examples (Speck's deterministic substrate)",
        turns: INCREMENTAL_RULE_CASE.turns, checks: ruleAnswerChecks(3), state: ruleState
    },
    {
        id: "operator-session", tests: "the same, after an introduction in the same conversation",
        turns: OPERATOR_SESSION_CASE.turns, checks: ruleAnswerChecks(4), state: ruleState
    },
    {
        id: "semantic-induction", tests: "induction outside Speck's fixed features (meaning, not numbers)",
        turns: [
            "I'll give you labelled examples. Work out the rule.\napple → Blue\ncarrot → Red\nbanana → Blue\npotato → Red",
            "cherry → Blue\nonion → Red\nWhat rule do you think is operating, and what label would grape get?"
        ],
        checks: [
            { expectation: "final: the rule is fruit versus vegetable", check: (replies) => /fruit/i.test(replies[1] ?? "") && /vegetable/i.test(replies[1] ?? "") ? null : "fruit/vegetable not stated" },
            { expectation: "final: grape is Blue", check: (replies) => /grape[^.]*\bblue\b|\bblue\b[^.]*grape/i.test(replies[1] ?? "") ? null : "grape not labelled Blue" }
        ]
    },
    {
        id: "ambiguity", tests: "an ambiguous request: asks rather than invents",
        turns: ["Book it for Tuesday at 7."],
        checks: [
            // Asking may be phrased as a question or as a request for what is meant
            // ("tell me what you need booked"); confirming the request back is not.
            { expectation: "asks what to book", check: (replies) => /\?/.test(replies[0] ?? "") || /\b(what|which)\b[^.]*\b(book|booked|booking)\b|\b(details|information) about what\b|\bclarify\b|\bspecify\b/i.test(replies[0] ?? "") ? null : "no question asked" },
            { expectation: "does not claim a booking was made", check: (replies) => /\b(booked|reserved|confirmed|have scheduled)\b/i.test(replies[0] ?? "") ? "claims a booking" : null }
        ]
    },
    {
        id: "synthesis", tests: "faithful synthesis: keeps every fact, invents none",
        turns: [SYNTHESIS_NOTES],
        checks: [
            { expectation: "keeps every fact", check: (replies) => { const missing = SYNTHESIS_FACTS.filter((fact) => !fact.stated.test(replies[0] ?? "")).map((fact) => fact.name); return missing.length ? `missing ${missing.join(", ")}` : null; } },
            { expectation: "invents no numbers", check: (replies) => { const invented = ungroundedNumbers(replies[0] ?? "", SYNTHESIS_NOTES); return invented.length ? `invents ${invented.join(", ")}` : null; } }
        ]
    },
    {
        id: "arithmetic", tests: "a direct factual answer (arithmetic)",
        turns: ["What is 17 plus 25?"],
        checks: [{ expectation: "answers 42", check: (replies) => /\b42\b/.test(replies[0] ?? "") ? null : "42 not given" }]
    }
];
// Tool use is measured with the role probe's own cases and stub tools.
const TOOL_CASES = ["read-tool", "write-tool"];
// ---- subjects ------------------------------------------------------------
// A processor for a model: the configured one when it exists (its context
// size and tool-calling settings), otherwise a plain local Ollama processor.
// The parameter count a model's name states ("qwen3:4b", "Qwen3-0.6B-tools"),
// for models whose configuration does not give it; 0 when the name is silent.
export function parametersInName(model) {
    const stated = /(?:^|[:\-_/])(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model);
    return stated ? Number(stated[1]) * 1e9 : 0;
}
export const NLI_SIDECAR_URL = "http://127.0.0.1:8765";
// A model is named as Ollama names it ("qwen3:4b"), as a llama.cpp server's
// address with an optional label ("http://localhost:8001#Ling"), or as an
// NLI cross-encoder served by the sidecar in sidecars/nli
// ("nli:MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli", optionally
// "@http://host:port").
export function processorFor(model, configured, baseUrl) {
    const existing = configured.find((processor) => processor.model === model);
    if (existing)
        return { ...existing, enabled: true };
    if (model.startsWith("nli:")) {
        const [name = "", address = NLI_SIDECAR_URL] = model.slice("nli:".length).split("@");
        return {
            id: `nli-${name}`.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
            provider: "nli", model: name, baseUrl: address, tier: 1, contextSize: 512,
            hardware: "local", specialties: ["atomic-entailment"], enabled: true
        };
    }
    if (/^https?:\/\//i.test(model)) {
        const [address = model, label = ""] = model.split("#");
        return {
            id: (label || address).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
            provider: "llama.cpp", model, baseUrl: address, tier: 1, contextSize: 32_768,
            hardware: "remote", specialties: ["general"], enabled: true
        };
    }
    return {
        id: model.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
        provider: "ollama", model, baseUrl, tier: 1, contextSize: 32_768, runtimeContextSize: 4_096,
        hardware: "local", specialties: ["general", "tool-use"], enabled: true
    };
}
function speckMix(spec, configured, baseUrl) {
    const models = [...new Set([spec.intake, spec.worker, spec.writer ?? spec.worker, spec.toolCaller, spec.planner ?? spec.worker])];
    const processors = models.map((model) => processorFor(model, configured, baseUrl));
    const idOf = (model) => processors.find((processor) => processor.model === model).id;
    return { processors, roles: { intake: idOf(spec.intake), planner: idOf(spec.planner ?? spec.worker), worker: idOf(spec.worker), writer: idOf(spec.writer ?? spec.worker), toolCaller: idOf(spec.toolCaller), specialists: {} } };
}
// ---- GPU memory ------------------------------------------------------------
// Samples GPU memory in use (MB) until stopped; null when it cannot be read.
function sampleGpu() {
    let peak = null;
    let low = null;
    let child = null;
    try {
        child = spawn("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits", "-lms", "500"], { stdio: ["ignore", "pipe", "ignore"] });
        child.stdout?.on("data", (chunk) => {
            for (const line of chunk.toString().split(/\r?\n/)) {
                const value = Number(line.trim());
                if (line.trim() && Number.isFinite(value)) {
                    peak = Math.max(peak ?? 0, value);
                    low = Math.min(low ?? value, value);
                }
            }
        });
        child.on("error", () => { child = null; });
    }
    catch {
        child = null;
    }
    return { stop: () => { child?.kill(); return peak; }, lowest: () => low };
}
// GPU memory in use with no model loaded: the lowest reading over a few
// seconds, so memory still being released does not count as idle.
async function idleGpu() {
    const sampler = sampleGpu();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    sampler.stop();
    return sampler.lowest();
}
// Unloads every model Ollama holds, so each subject's peak is its own.
async function unloadModels(baseUrl) {
    try {
        const loaded = await (await fetch(`${baseUrl}/api/ps`)).json();
        for (const model of loaded.models ?? []) {
            await fetch(`${baseUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: model.name, keep_alive: 0 }) });
        }
        // Wait until Ollama reports nothing loaded (up to 30 seconds).
        for (let waited = 0; waited < 30_000; waited += 500) {
            const still = await (await fetch(`${baseUrl}/api/ps`)).json();
            if (!still.models?.length)
                break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    catch { /* not measurable; the run goes on */ }
}
// ---- runners -------------------------------------------------------------
const CORRECTION_ACTIONS = new Set(["repeated-reply", "ungrounded-reply", "unperformed-action-claimed", "wait-rejected", "completion-rejected", "invalid-structured-response"]);
async function runSpeckCase(spec, probe, repetition, options) {
    const { processors, roles } = speckMix(spec, options.configured, options.baseUrl);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-compare-"));
    const runtime = new SpeckRuntime({
        databasePath: path.join(directory, "speck.sqlite"), genesisRuntimePath: directory,
        modelRuntime: { processors, roles, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
        ...(options.embeddingRuntime ? { embeddingRuntime: options.embeddingRuntime } : {})
    });
    let calls = 0;
    let tokens = 0;
    const observe = runtime.modelRegistry.observer;
    const byContract = {};
    // Calls that never reached a model (a server down or reloading) say
    // nothing about the subject; a run with any is reported as not finished.
    let unreachable = 0;
    runtime.modelRegistry.observer = (observation) => {
        calls += 1;
        tokens += observation.tokens ?? 0;
        if (observation.outcome === "transport")
            unreachable += 1;
        const entry = byContract[observation.contract ?? "free"] ??= { calls: 0, ms: 0, unusable: 0 };
        entry.calls += 1;
        entry.ms += observation.latencyMs;
        if (observation.outcome !== "usable")
            entry.unusable += 1;
        observe?.(observation);
    };
    const replies = [];
    const started = Date.now();
    const gpu = sampleGpu();
    let worker = null;
    try {
        // As in the interface: Speck places each message in an episode and runs
        // the task that answers it.
        const conversation = new Conversation(runtime, "compare");
        for (const message of probe.turns) {
            const received = await conversation.receive(message);
            let summary = received.summary ?? "";
            if (received.route !== "closed") {
                const outcome = await new SpeckController(runtime, { maxCycles: 6 }).run(received.worker.id);
                worker = outcome.worker;
                summary = outcome.summary;
                await conversation.replied(outcome.worker.id, summary);
            }
            else {
                worker = received.worker;
            }
            replies.push(summary);
        }
        const latencyMs = Date.now() - started;
        const peakVramMB = gpu.stop();
        // Speck's own interventions, across every task the conversation used.
        let corrections = 0;
        let validatorCalls = 0;
        let validatorRejections = 0;
        for (const task of runtime.listWorkers()) {
            corrections += (task.metacognition?.cycleHistory ?? []).filter((entry) => entry.action && CORRECTION_ACTIONS.has(entry.action)).length;
            for (const object of runtime.mentalObjects.listForWorker(task.id)) {
                const response = object.data.modelResponse;
                if (response?.contract === "speck-completion-validation") {
                    validatorCalls += 1;
                    if (response.structured?.satisfied !== true)
                        validatorRejections += 1;
                }
                if (response?.contract === "speck-wait-validation") {
                    validatorCalls += 1;
                    if (response.structured?.justified !== true)
                        validatorRejections += 1;
                }
            }
        }
        const stateReason = probe.state && worker ? probe.state(runtime, runtime.getWorker(worker.id) ?? worker) : null;
        return scored(spec.id, "speck", probe, repetition, replies, {
            corrections, validatorCalls, validatorRejections,
            stateConsistent: probe.state ? stateReason === null : null, stateReason,
            calls, tokens, latencyMs, peakVramMB, byContract,
            ...(unreachable ? { error: `${unreachable} model call${unreachable === 1 ? "" : "s"} could not reach a model server` } : {})
        });
    }
    finally {
        gpu.stop();
        runtime.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
async function runNakedCase(spec, probe, repetition, options) {
    const messages = [];
    const replies = [];
    let calls = 0;
    let tokens = 0;
    const started = Date.now();
    const gpu = sampleGpu();
    try {
        for (const message of probe.turns) {
            messages.push({ role: "user", content: message });
            const response = await fetch(`${options.baseUrl}/api/chat`, {
                method: "POST",
                body: JSON.stringify({ model: spec.model, stream: false, think: false, messages, options: { temperature: options.temperature, num_ctx: 8_192, num_predict: MAX_OUTPUT_TOKENS } }),
                signal: AbortSignal.timeout(options.timeoutMs ?? 180_000)
            });
            if (!response.ok)
                throw new Error(`${spec.model} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
            const body = await response.json();
            calls += 1;
            tokens += (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0);
            const reply = String(body.message?.content ?? "").trim();
            replies.push(reply);
            // The conversation carries what the user saw, as a chat interface's does.
            messages.push({ role: "assistant", content: afterReasoning(reply).trim() });
        }
        return scored(spec.id, "naked", probe, repetition, replies, {
            corrections: 0, validatorCalls: 0, validatorRejections: 0, stateConsistent: null, stateReason: null,
            calls, tokens, latencyMs: Date.now() - started, peakVramMB: gpu.stop()
        });
    }
    finally {
        gpu.stop();
    }
}
// Recomputes every conversation case's checks from the replies a report
// stored, with the current case definitions (state and tool results are kept).
export function rescore(report, input, given) {
    const runs = report.runs.map((run) => {
        const probe = COMPARE_CASES.find((entry) => entry.id === run.caseId);
        if (!probe || run.error)
            return run;
        const { subject, kind, caseId: _caseId, repetition, replies, passed: _passed, total: _total, success: _success, firstPass: _firstPass, failures: _failures, ...measures } = run;
        return scored(subject, kind, probe, repetition, replies, measures);
    });
    // The subjects as run: stored in the report, or given again; otherwise only
    // their names and recorded largest models are known.
    const known = given ?? report.subjects;
    if (known) {
        const missing = report.summary.filter((entry) => !known.some((subject) => subject.id === entry.subject));
        if (missing.length)
            throw new Error(`no subject given for ${missing.map((entry) => entry.subject).join(", ")}`);
        const subjects = report.summary.map((entry) => known.find((subject) => subject.id === entry.subject));
        return { ...report, subjects, runs, summary: summarise(subjects, runs, input, report.baselineVramMB) };
    }
    const subjects = report.summary.map((entry) => ({ id: entry.subject, kind: "naked", model: entry.largestModel }));
    const summary = summarise(subjects, runs, input, report.baselineVramMB)
        .map((entry, index) => ({ ...entry, kind: report.summary[index].kind, largestModel: report.summary[index].largestModel }));
    return { ...report, runs, summary };
}
function scored(subject, kind, probe, repetition, replies, measures) {
    // Scored on what the user would see: reasoning a model emitted despite
    // thinking being off is stored with the reply but not credited.
    const visible = replies.map((reply) => afterReasoning(reply).trim());
    const failures = probe.checks.flatMap((entry) => { const reason = entry.check(visible); return reason ? [`${entry.expectation}: ${reason}`] : []; });
    const success = failures.length === 0 && measures.stateConsistent !== false && !measures.error;
    return {
        subject, kind, caseId: probe.id, repetition, passed: probe.checks.length - failures.length, total: probe.checks.length,
        success, firstPass: success && measures.corrections === 0,
        failures: measures.error ? [`run did not finish: ${measures.error}`, ...failures] : failures, replies, ...measures
    };
}
export async function runComparison(input) {
    const startedAt = new Date().toISOString();
    const cases = input.caseIds?.length ? COMPARE_CASES.filter((entry) => input.caseIds.includes(entry.id)) : COMPARE_CASES;
    await unloadModels(input.baseUrl);
    const baselineVramMB = await idleGpu();
    const runs = [];
    for (const subject of input.subjects) {
        await unloadModels(input.baseUrl);
        for (const probe of cases) {
            for (let repetition = 0; repetition < Math.max(1, input.repetitions ?? 1); repetition += 1) {
                const started = Date.now();
                const run = await (subject.kind === "speck"
                    ? runSpeckCase(subject, probe, repetition, input)
                    : runNakedCase(subject, probe, repetition, input))
                    .catch((error) => erroredRun(subject, probe, repetition, error, Date.now() - started));
                runs.push(run);
                input.onRun?.(run);
            }
        }
        if (input.includeTools !== false) {
            for (const run of await toolRuns(subject, input)) {
                runs.push(run);
                input.onRun?.(run);
            }
        }
    }
    return { schema: "speck-compare/v1", startedAt, completedAt: new Date().toISOString(), baselineVramMB, subjects: [...input.subjects], runs, summary: summarise(input.subjects, runs, input, baselineVramMB) };
}
// A run that could not finish counts as a failure of the subject, and the
// comparison goes on.
function erroredRun(subject, probe, repetition, error, latencyMs) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        subject: subject.id, kind: subject.kind, caseId: probe.id, repetition, passed: 0, total: probe.checks.length,
        success: false, firstPass: false, failures: [`run did not finish: ${message}`], replies: [],
        corrections: 0, validatorCalls: 0, validatorRejections: 0, stateConsistent: null, stateReason: null,
        calls: 0, tokens: 0, latencyMs, peakVramMB: null, error: message
    };
}
// The role probe's tool cases, through Speck or as a bare tool-calling chat.
async function toolRuns(subject, input) {
    const report = subject.kind === "speck"
        ? await runRoleProbe({ ...speckMix(subject, input.configured, input.baseUrl), processors: speckMix(subject, input.configured, input.baseUrl).processors, configuredRoles: speckMix(subject, input.configured, input.baseUrl).roles, caseIds: TOOL_CASES, repetitions: input.repetitions ?? 1, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), ...(input.embeddingRuntime ? { embeddingRuntime: input.embeddingRuntime } : {}) })
        : await runRoleProbe({ processors: [processorFor(subject.model, input.configured, input.baseUrl)], bare: true, caseIds: TOOL_CASES, repetitions: input.repetitions ?? 1, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) });
    return report.results.map((result) => ({
        subject: subject.id, kind: subject.kind, caseId: result.caseId, repetition: result.repetition,
        passed: result.passed ? 1 : 0, total: 1, success: result.passed, firstPass: result.passed && result.contractFailures === 0,
        failures: result.passed ? [] : [result.reason], replies: [result.summary],
        corrections: result.contractFailures, validatorCalls: 0, validatorRejections: 0, stateConsistent: null, stateReason: null,
        calls: result.modelCalls, tokens: result.calls.reduce((sum, call) => sum + (call.inputTokens ?? 0) + (call.outputTokens ?? 0), 0),
        latencyMs: result.durationMs, peakVramMB: null
    }));
}
function summarise(subjects, runs, input, baselineVramMB) {
    return subjects.map((subject) => {
        const mine = runs.filter((run) => run.subject === subject.id);
        const ratio = (count, total) => `${count}/${total}`;
        const states = mine.filter((run) => run.stateConsistent !== null);
        const validatorCalls = mine.reduce((sum, run) => sum + run.validatorCalls, 0);
        const mean = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
        const models = subject.kind === "speck" ? [subject.intake, subject.worker, subject.writer ?? subject.worker, subject.toolCaller, subject.planner ?? subject.worker] : [subject.model];
        const size = (model) => processorFor(model, input.configured, input.baseUrl).parameters ?? parametersInName(model);
        const largest = [...models].sort((left, right) => size(right) - size(left))[0] ?? "";
        const peaks = mine.map((run) => run.peakVramMB).filter((value) => value !== null);
        return {
            subject: subject.id, kind: subject.kind, largestModel: largest, cases: mine.length,
            success: ratio(mine.filter((run) => run.success).length, mine.length),
            unfinished: mine.filter((run) => run.error).length,
            firstPass: ratio(mine.filter((run) => run.firstPass).length, mine.length),
            checks: ratio(mine.reduce((sum, run) => sum + run.passed, 0), mine.reduce((sum, run) => sum + run.total, 0)),
            corrections: mine.reduce((sum, run) => sum + run.corrections, 0),
            validatorInterventionRate: validatorCalls ? ratio(mine.reduce((sum, run) => sum + run.validatorRejections, 0), validatorCalls) : "-",
            stateConsistency: states.length ? ratio(states.filter((run) => run.stateConsistent).length, states.length) : "-",
            meanCalls: mean(mine.map((run) => run.calls)), meanTokens: mean(mine.map((run) => run.tokens)),
            meanLatencyMs: mean(mine.map((run) => run.latencyMs)),
            peakVramMB: peaks.length ? Math.max(...peaks) : null,
            peakModelVramMB: peaks.length && baselineVramMB !== null ? Math.max(...peaks) - baselineVramMB : null
        };
    });
}
//# sourceMappingURL=compare.js.map