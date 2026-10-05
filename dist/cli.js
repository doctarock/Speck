#!/usr/bin/env node
import { loadAppConfig } from "./config.js";
import { parseMentalObjectId, parseWorkerId } from "./types/ids.js";
import { EDGE_KINDS, WORKER_STATUSES } from "./types/model.js";
import { SpeckRuntime } from "./runtime/speck-runtime.js";
import { SpeckController } from "./runtime/controller.js";
import { STANDARD_TASK_SUITE } from "./benchmark/suites.js";
import { BENCHMARK_HARNESS_VERSION } from "./benchmark/harness.js";
import { PROBE_HISTORY, ROLE_PROBE_CASES, runRoleProbe } from "./benchmark/role-probe.js";
import { runTrajectoryProbe, TRAJECTORY_CASES } from "./benchmark/trajectory-probe.js";
import { processorFor, rescore, runComparison } from "./benchmark/compare.js";
import { runQualificationProbe } from "./benchmark/qualification-probe.js";
import { TOOLBELT_DEVELOPMENT, TOOLBELT_HELD_OUT, TOOLBELT_HELD_OUT_2 } from "./benchmark/toolbelt-cases.js";
import { measureToolbelt } from "./benchmark/toolbelt-probe.js";
import fs from "node:fs";
import path from "node:path";
const [group, command, ...args] = process.argv.slice(2);
const runtime = new SpeckRuntime(loadAppConfig());
try {
    await runtime.initialize();
    let result;
    if (group === "worker" && command === "create") {
        result = await runtime.createWorker(args.join(" "), [], { kind: "user", source: "cli" });
    }
    else if (group === "worker" && command === "list") {
        result = runtime.listWorkers(args[0] ? parseStatus(args[0]) : undefined);
    }
    else if (group === "workers") {
        result = runtime.listWorkers(command ? parseStatus(command) : undefined);
    }
    else if (group === "worker" && command === "show") {
        result = runtime.getWorker(parseWorkerId(required(args[0], "worker id")));
    }
    else if (group === "worker" && command === "transition") {
        result = await runtime.transitionWorker(parseWorkerId(required(args[0], "worker id")), parseStatus(required(args[1], "status")), { kind: "user", source: "cli" }, args.slice(2).join(" "));
    }
    else if (group === "events" && command === "list") {
        result = runtime.listEvents(args[0] ? parseWorkerId(args[0]) : undefined);
    }
    else if (group === "memory" && command === "recall") {
        const anchorIds = args.slice(1).map(parseMentalObjectId);
        result = await runtime.retrieveMemories({
            workerId: parseWorkerId(required(args[0], "worker id")),
            ...(anchorIds.length ? { anchorIds } : {})
        });
    }
    else if (group === "memory" && command === "associate") {
        result = await runtime.reinforceAssociation({
            workerId: parseWorkerId(required(args[0], "worker id")),
            sourceId: parseMentalObjectId(required(args[1], "source object id")),
            targetId: parseMentalObjectId(required(args[2], "target object id")),
            kind: parseEdgeKind(args[3] ?? "associative"),
            actor: { kind: "user", source: "cli" }
        });
    }
    else if (group === "memory" && command === "domain-link") {
        result = await runtime.linkMemoryToDomain({
            workerId: parseWorkerId(required(args[0], "worker id")),
            objectId: parseMentalObjectId(required(args[1], "object id")),
            domain: required(args[2], "domain"), key: required(args[3], "key"),
            actor: { kind: "user", source: "cli" }
        });
    }
    else if (group === "memory" && command === "domain-recall") {
        result = await runtime.retrieveDomainMemories({
            workerId: parseWorkerId(required(args[0], "worker id")),
            domain: required(args[1], "domain"), key: required(args[2], "key"),
            actor: { kind: "user", source: "cli" }
        });
    }
    else if (group === "memory" && command === "compete") {
        const candidateIds = args.slice(1).map(parseMentalObjectId);
        result = await runtime.competeForWorkingMemory({
            workerId: parseWorkerId(required(args[0], "worker id")),
            ...(candidateIds.length ? { candidateIds } : {}),
            actor: { kind: "user", source: "cli" }
        });
    }
    else if (group === "context" && command === "build") {
        const tokenBudget = args[1] === undefined ? undefined : Number(args[1]);
        if (tokenBudget !== undefined && (!Number.isFinite(tokenBudget) || tokenBudget <= 0))
            throw new TypeError("token budget must be positive");
        result = runtime.buildContext({
            workerId: parseWorkerId(required(args[0], "worker id")),
            ...(tokenBudget === undefined ? {} : { tokenBudget })
        });
    }
    else if (group === "model" && command === "list") {
        result = runtime.modelRegistry.list();
    }
    else if (group === "model" && command === "assign") {
        result = await runtime.assignModelProcessor(parseWorkerId(required(args[0], "worker id")), required(args[1], "processor id"), { kind: "user", source: "cli" });
    }
    else if (group === "model" && command === "infer") {
        result = await runtime.inferForWorker({
            workerId: parseWorkerId(required(args[0], "worker id")),
            ...(args[1] ? { processorId: args[1] } : {}),
            actor: { kind: "user", source: "cli" }
        });
    }
    else if (group === "benchmark" && command === "suite") {
        result = { harnessVersion: BENCHMARK_HARNESS_VERSION, tasks: STANDARD_TASK_SUITE };
    }
    else if (group === "probe" && command === "roles") {
        const models = option(args, "--models")?.split(",").map((value) => value.trim()).filter(Boolean);
        const processors = runtime.config.modelRuntime.processors
            .filter((processor) => processor.provider !== "genesis" && (models ? models.includes(processor.id) : processor.enabled));
        if (!processors.length)
            throw new TypeError("No configured processors match --models");
        const report = await runRoleProbe({
            processors,
            ...(args.includes("--configured-roles") ? { configuredRoles: runtime.config.modelRuntime.roles } : {}),
            ...(args.includes("--bare") ? { bare: true } : {}),
            embeddingRuntime: runtime.config.embeddingRuntime,
            history: args.includes("--cold") ? [] : PROBE_HISTORY,
            ...(option(args, "--competence") ? { competencePath: path.resolve(option(args, "--competence")) } : {}),
            ...(option(args, "--routing") === "competence" ? { routing: "competence" } : {}),
            ...(option(args, "--cases") ? { caseIds: option(args, "--cases").split(",").map((value) => value.trim()) } : {}),
            repetitions: Number(option(args, "--repetitions") ?? 1),
            ...(option(args, "--timeout") ? { timeoutMs: Number(option(args, "--timeout")) } : {}),
            onResult: (entry) => console.error(`[probe] ${entry.processorId} ${entry.caseId}#${entry.repetition}: ${entry.passed ? "pass" : `FAIL (${entry.failureKind})`} ${entry.reason} [${entry.modelCalls} calls, ${entry.durationMs}ms]`)
        });
        const out = option(args, "--out");
        if (out)
            fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}
`);
        result = report.summary;
    }
    else if (group === "probe" && command === "toolbelt") {
        // Measures the toolbelt on labelled messages against the running server's
        // tools (plugins included). --sweep tries a grid of thresholds.
        const set = option(args, "--set") === "held-out-2" ? TOOLBELT_HELD_OUT_2 : option(args, "--set") === "held-out" ? TOOLBELT_HELD_OUT : TOOLBELT_DEVELOPMENT;
        const server = option(args, "--server") ?? "http://127.0.0.1:4310";
        const tools = (await (await fetch(`${server}/api/tools/config`)).json()).tools;
        const grid = args.includes("--sweep")
            ? [2, 2.5, 3, 3.5, 4, 4.5, 5].map((family) => ({ family }))
            : undefined;
        const scores = await measureToolbelt({ toolbelt: runtime.toolbelt, tools, cases: set, ...(grid ? { thresholds: grid } : {}) });
        const out = option(args, "--out");
        if (out)
            fs.writeFileSync(out, `${JSON.stringify(scores, null, 2)}\n`);
        const summary = (score) => ({
            family: score.thresholds.family,
            recall: `${score.recall.hit}/${score.recall.total}`, leaks: score.leaks, pluginOnNoTool: score.pluginOnNoTool,
            emptyOnNoTool: `${score.emptyOnNoTool.empty}/${score.emptyOnNoTool.total}`, meanOffered: Number(score.meanOffered.toFixed(1))
        });
        result = grid ? scores.map(summary) : { ...summary(scores[0]), cases: scores[0].cases.map((entry) => `${entry.hit === false ? "MISS" : entry.leaked.length ? "LEAK" : "ok  "} ${entry.message.slice(0, 60).replace(/\n/g, " ")} → ${entry.offered.join(", ") || "(none)"}${entry.leaked.length ? ` [leaked ${entry.leaked.join(", ")}]` : ""}`) };
    }
    else if (group === "probe" && command === "qualify") {
        // Measures models on a judgment class and records the result as their
        // qualification for it (unless --no-record). Models are named as Ollama
        // names them, or by configured processor id.
        const configured = runtime.config.modelRuntime.processors.filter((processor) => processor.provider !== "genesis");
        const baseUrl = configured.find((processor) => processor.provider === "ollama")?.baseUrl ?? "http://127.0.0.1:11434";
        const named = option(args, "--models")?.split(",").map((value) => value.trim()).filter(Boolean);
        const processors = named
            ? named.map((name) => configured.find((processor) => processor.id === name) ?? processorFor(name, configured, baseUrl))
            : configured.filter((processor) => processor.enabled);
        const results = await runQualificationProbe({
            processors, repetitions: Number(option(args, "--repetitions") ?? 3),
            ...(option(args, "--timeout") ? { timeoutMs: Number(option(args, "--timeout")) } : {}),
            onAnswer: (processorId, pair, answer) => console.error(`[qualify] ${processorId} ${answer.proposition === pair.label ? "ok " : "BAD"} ${pair.proposition} → ${answer.proposition ?? "invalid"} (want ${pair.label}); opposite → ${answer.opposite ?? "invalid"}`)
        });
        if (!args.includes("--no-record"))
            for (const entry of results)
                runtime.processorCompetence.recordQualification(entry.model, entry.qualification);
        const out = option(args, "--out");
        if (out)
            fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
        const rate = (tally) => `${tally.correct}/${tally.total}`;
        result = results.map((entry) => ({
            model: entry.model, qualified: entry.qualification.qualified, overall: rate(entry.qualification.overall),
            entailment: rate(entry.qualification.byLabel.entailment), contradiction: rate(entry.qualification.byLabel.contradiction),
            neutral: rate(entry.qualification.byLabel.neutral), negation: rate(entry.qualification.negationConsistency),
            latencyMs: entry.qualification.meanLatencyMs, confusion: entry.qualification.confusion,
            outageTask: { overall: rate(entry.task.overall), contradiction: rate(entry.task.byLabel.contradiction), negation: rate(entry.task.negationConsistency) }
        }));
    }
    else if (group === "probe" && command === "trajectory") {
        const caseId = option(args, "--case");
        const probeCase = caseId ? TRAJECTORY_CASES.find((entry) => entry.id === caseId) : undefined;
        if (caseId && !probeCase)
            throw new Error(`Unknown trajectory case ${caseId}; cases: ${TRAJECTORY_CASES.map((entry) => entry.id).join(", ")}`);
        const results = await runTrajectoryProbe({
            ...(probeCase ? { probe: probeCase } : {}),
            processors: runtime.config.modelRuntime.processors.filter((processor) => processor.provider !== "genesis" && processor.enabled),
            roles: runtime.config.modelRuntime.roles,
            repetitions: Number(option(args, "--repetitions") ?? 1),
            ...(option(args, "--timeout") ? { timeoutMs: Number(option(args, "--timeout")) } : {}),
            embeddingRuntime: runtime.config.embeddingRuntime,
            history: args.includes("--cold") ? [] : PROBE_HISTORY,
            onTurn: (repetition, snapshot) => console.error(`[trajectory #${repetition}] turn ${snapshot.turn}: ${snapshot.status}${snapshot.waitKind ? ` (${snapshot.waitKind})` : ""}; ${snapshot.hypotheses.length} hypotheses: ${snapshot.hypotheses.map((h) => `${h.content} [${h.confidence.toFixed(2)} ${h.status} +${h.consistent}/-${h.inconsistent}]`).join(" | ")}
  reply: ${snapshot.reply.replace(/\s+/g, " ").slice(0, 300)}`)
        });
        const out = option(args, "--out");
        if (out)
            fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}
`);
        result = results.map((entry) => ({ repetition: entry.repetition, passed: `${entry.passed}/${entry.total}`, checks: entry.checks.map((check) => `${check.passed ? "pass" : "FAIL"} ${check.expectation}${check.passed ? "" : ` (${check.reason})`}`) }));
    }
    else if (group === "bench" && command === "rescore") {
        // Re-scores a stored comparison report's replies with the current checks.
        // A report from before subjects were stored can be given them again with
        // the --speck and --naked options it was run with.
        const file = args[0];
        if (!file)
            throw new Error("Usage: speck bench rescore <report.json> [--speck ...]... [--naked MODEL]... [--out file]");
        const configured = runtime.config.modelRuntime.processors.filter((processor) => processor.provider !== "genesis" && processor.enabled);
        const subjects = compareSubjects(args, runtime.config.modelRuntime.roles, configured);
        const report = rescore(JSON.parse(fs.readFileSync(file, "utf8")), { configured, baseUrl: "", temperature: runtime.config.modelRuntime.temperature }, subjects.length ? subjects : undefined);
        const out = option(args, "--out");
        if (out)
            fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
        result = report.summary;
    }
    else if (group === "bench" && command === "compare") {
        // Speck with a mix of processors against naked models, on the same cases.
        const configured = runtime.config.modelRuntime.processors.filter((processor) => processor.provider !== "genesis" && processor.enabled);
        const subjects = compareSubjects(args, runtime.config.modelRuntime.roles, configured);
        if (!subjects.length)
            throw new Error("bench compare needs --current, --speck intake=MODEL,worker=MODEL,tool=MODEL, or --naked MODEL");
        const report = await runComparison({
            subjects, configured, baseUrl: configured.find((processor) => processor.provider === "ollama")?.baseUrl ?? "http://127.0.0.1:11434",
            temperature: runtime.config.modelRuntime.temperature,
            ...(option(args, "--timeout") ? { timeoutMs: Number(option(args, "--timeout")) } : {}),
            ...(option(args, "--cases") ? { caseIds: option(args, "--cases").split(",").map((value) => value.trim()) } : {}),
            repetitions: Number(option(args, "--repetitions") ?? 1),
            includeTools: !args.includes("--no-tools"),
            embeddingRuntime: runtime.config.embeddingRuntime,
            onRun: (run) => console.error(`[compare] ${run.subject} ${run.caseId}#${run.repetition}: ${run.success ? "pass" : `FAIL (${run.failures.join("; ") || run.stateReason})`} [${run.calls} calls, ${run.tokens} tokens, ${run.latencyMs}ms${run.peakVramMB ? `, peak ${run.peakVramMB} MB` : ""}${run.kind === "speck" ? `, ${run.corrections} corrections` : ""}]`)
        });
        const out = option(args, "--out");
        if (out)
            fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
        result = { baselineVramMB: report.baselineVramMB, summary: report.summary };
    }
    else if (group === "probe" && command === "cases") {
        result = ROLE_PROBE_CASES.map(({ id, role, objective }) => ({ id, role, objective }));
    }
    else if (group === "inspect") {
        result = runtime.getCognitiveState(parseWorkerId(required(command, "worker id")));
    }
    else if (group === "run") {
        const objective = [command, ...args].filter(Boolean).join(" ").trim();
        let worker = await runtime.createWorker(required(objective, "objective"), [], { kind: "user", source: "cli" });
        worker = await runtime.transitionWorker(worker.id, "ready", { kind: "runtime", source: "cli" }, "Admitted for controller execution");
        result = await new SpeckController(runtime).run(worker.id);
    }
    else if (group === "config") {
        result = runtime.config;
    }
    else if (group === "status") {
        result = { phase: 13, workers: runtime.listWorkers().length, models: runtime.modelRegistry.list(), tools: runtime.toolRegistry.list(), predictiveLoop: runtime.config.predictiveLoop, beliefRevision: runtime.config.beliefRevision, metacognition: runtime.config.metacognition, modelEscalation: runtime.config.modelEscalation, procedures: runtime.config.procedures, coordination: runtime.config.coordination, backgroundCognition: runtime.config.backgroundCognition, benchmarkHarness: { version: BENCHMARK_HARNESS_VERSION, standardTasks: STANDARD_TASK_SUITE.length }, tierResources: runtime.tierScheduler.snapshot(), telemetry: runtime.telemetry.snapshot(), llmRequired: false };
    }
    else {
        throw new Error("Usage: speck run <objective> | speck workers [status] | speck inspect <worker-id> | speck worker <create|list|show|transition> ... | memory <recall|associate|domain-link|domain-recall|compete> ... | context build <worker-id> [token-budget] | model <list|assign|infer> ... | benchmark suite | probe roles [--models a,b] [--configured-roles | --bare] [--cold] [--competence file] [--routing competence] [--cases a,b] [--repetitions n] [--out file] | bench compare [--current] [--speck intake=M,worker=M,writer=M,tool=M]... [--naked MODEL]... [--cases a,b] [--repetitions n] [--no-tools] [--out file] | probe cases | probe toolbelt [--set development|held-out|held-out-2] [--sweep] [--server url] [--out file] | probe qualify [--models a,b] [--repetitions n] [--no-record] [--out file] | probe trajectory [--case incremental-rule|operator-session|causal-outage] [--repetitions n] [--cold] [--out file] | events list [worker-id] | config | status");
    }
    console.log(JSON.stringify(result, null, 2));
}
catch (error) {
    console.error(`[speck] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
finally {
    runtime.close();
}
function option(values, name) {
    const index = values.indexOf(name);
    return index >= 0 ? values[index + 1] : undefined;
}
function required(value, label) {
    if (!value)
        throw new TypeError(`${label} is required`);
    return value;
}
function parseStatus(value) {
    if (!WORKER_STATUSES.includes(value))
        throw new TypeError(`Unknown worker status: ${value}`);
    return value;
}
function parseEdgeKind(value) {
    if (!EDGE_KINDS.includes(value))
        throw new TypeError(`Unknown edge kind: ${value}`);
    return value;
}
// The subjects a comparison names: --current, --speck id=..,intake=..,
// worker=..,writer=..,tool=.. (unnamed roles take the configured models), and
// --naked MODEL.
function compareSubjects(args, roles, configured) {
    const roleModel = (role) => configured.find((processor) => processor.id === roles[role])?.model ?? "";
    const subjects = [];
    if (args.includes("--current"))
        subjects.push({ id: "speck-current", kind: "speck", intake: roleModel("intake"), worker: roleModel("worker"), writer: roleModel("writer") || roleModel("worker"), toolCaller: roleModel("toolCaller") });
    args.forEach((value, index) => {
        if (value === "--speck") {
            const parts = Object.fromEntries(String(args[index + 1] ?? "").split(",").map((part) => part.split("=").map((piece) => piece.trim())));
            const intake = parts.intake || roleModel("intake");
            const worker = parts.worker || roleModel("worker");
            const toolCaller = parts.tool || roleModel("toolCaller");
            const writer = parts.writer || worker;
            subjects.push({ id: parts.id || `speck[${[intake, worker, writer, toolCaller].map((model) => model.split("/").at(-1)).join(" | ")}]`, kind: "speck", intake, worker, writer, toolCaller });
        }
        if (value === "--naked")
            subjects.push({ id: `naked[${args[index + 1]}]`, kind: "naked", model: String(args[index + 1]) });
    });
    return subjects;
}
//# sourceMappingURL=cli.js.map