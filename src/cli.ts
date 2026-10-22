#!/usr/bin/env node
import { loadAppConfig, type ModelRoleAssignments } from "./config.js";
import type { ConfiguredModelProcessor } from "./models/types.js";
import { parseMentalObjectId, parseWorkerId } from "./types/ids.js";
import { EDGE_KINDS, WORKER_STATUSES, type EdgeKind, type WorkerStatus } from "./types/model.js";
import { SpeckRuntime } from "./runtime/speck-runtime.js";
import { STANDARD_TASK_SUITE } from "./benchmark/suites.js";
import { BENCHMARK_HARNESS_VERSION } from "./benchmark/harness.js";
import { processorFor } from "./benchmark/processors.js";
import { CORPUS_V5_ADDITIONS } from "./metacognition/entailment-corpus-v5.js";
import { respond } from "./speck/respond.js";
import { SessionStore } from "./speck/session.js";
import { defaultPathDependencies } from "./speck/configure.js";
import { runQualificationProbe } from "./benchmark/qualification-probe.js";
import { TOOLBELT_DEVELOPMENT, TOOLBELT_HELD_OUT, TOOLBELT_HELD_OUT_2 } from "./benchmark/toolbelt-cases.js";
import { measureToolbelt } from "./benchmark/toolbelt-probe.js";
import type { ToolbeltTool } from "./cognition/toolbelt.js";
import fs from "node:fs";
import path from "node:path";

const [group, command, ...args] = process.argv.slice(2);
const runtime = new SpeckRuntime(loadAppConfig());

try {
  await runtime.initialize();
  let result: unknown;
  if (group === "worker" && command === "create") {
    result = await runtime.createWorker(args.join(" "), [], { kind: "user", source: "cli" });
  } else if (group === "worker" && command === "list") {
    result = runtime.listWorkers(args[0] ? parseStatus(args[0]) : undefined);
  } else if (group === "workers") {
    result = runtime.listWorkers(command ? parseStatus(command) : undefined);
  } else if (group === "worker" && command === "show") {
    result = runtime.getWorker(parseWorkerId(required(args[0], "worker id")));
  } else if (group === "worker" && command === "transition") {
    result = await runtime.transitionWorker(
      parseWorkerId(required(args[0], "worker id")), parseStatus(required(args[1], "status")),
      { kind: "user", source: "cli" }, args.slice(2).join(" ")
    );
  } else if (group === "events" && command === "list") {
    result = runtime.listEvents(args[0] ? parseWorkerId(args[0]) : undefined);
  } else if (group === "memory" && command === "recall") {
    const anchorIds = args.slice(1).map(parseMentalObjectId);
    result = await runtime.retrieveMemories({
      workerId: parseWorkerId(required(args[0], "worker id")),
      ...(anchorIds.length ? { anchorIds } : {})
    });
  } else if (group === "memory" && command === "associate") {
    result = await runtime.reinforceAssociation({
      workerId: parseWorkerId(required(args[0], "worker id")),
      sourceId: parseMentalObjectId(required(args[1], "source object id")),
      targetId: parseMentalObjectId(required(args[2], "target object id")),
      kind: parseEdgeKind(args[3] ?? "associative"),
      actor: { kind: "user", source: "cli" }
    });
  } else if (group === "memory" && command === "domain-link") {
    result = await runtime.linkMemoryToDomain({
      workerId: parseWorkerId(required(args[0], "worker id")),
      objectId: parseMentalObjectId(required(args[1], "object id")),
      domain: required(args[2], "domain"), key: required(args[3], "key"),
      actor: { kind: "user", source: "cli" }
    });
  } else if (group === "memory" && command === "domain-recall") {
    result = await runtime.retrieveDomainMemories({
      workerId: parseWorkerId(required(args[0], "worker id")),
      domain: required(args[1], "domain"), key: required(args[2], "key"),
      actor: { kind: "user", source: "cli" }
    });
  } else if (group === "memory" && command === "compete") {
    const candidateIds = args.slice(1).map(parseMentalObjectId);
    result = await runtime.competeForWorkingMemory({
      workerId: parseWorkerId(required(args[0], "worker id")),
      ...(candidateIds.length ? { candidateIds } : {}),
      actor: { kind: "user", source: "cli" }
    });
  } else if (group === "context" && command === "build") {
    const tokenBudget = args[1] === undefined ? undefined : Number(args[1]);
    if (tokenBudget !== undefined && (!Number.isFinite(tokenBudget) || tokenBudget <= 0)) throw new TypeError("token budget must be positive");
    result = runtime.buildContext({
      workerId: parseWorkerId(required(args[0], "worker id")),
      ...(tokenBudget === undefined ? {} : { tokenBudget })
    });
  } else if (group === "model" && command === "list") {
    result = runtime.modelRegistry.list();
  } else if (group === "model" && command === "assign") {
    result = await runtime.assignModelProcessor(
      parseWorkerId(required(args[0], "worker id")), required(args[1], "processor id"),
      { kind: "user", source: "cli" }
    );
  } else if (group === "model" && command === "infer") {
    result = await runtime.inferForWorker({
      workerId: parseWorkerId(required(args[0], "worker id")),
      ...(args[1] ? { processorId: args[1] } : {}),
      actor: { kind: "user", source: "cli" }
    });
  } else if (group === "benchmark" && command === "suite") {
    result = { harnessVersion: BENCHMARK_HARNESS_VERSION, tasks: STANDARD_TASK_SUITE };
  } else if (group === "probe" && command === "toolbelt") {
    // Measures the toolbelt on labelled messages against the running server's
    // tools (plugins included). --sweep tries a grid of thresholds.
    const set = option(args, "--set") === "held-out-2" ? TOOLBELT_HELD_OUT_2 : option(args, "--set") === "held-out" ? TOOLBELT_HELD_OUT : TOOLBELT_DEVELOPMENT;
    const server = option(args, "--server") ?? "http://127.0.0.1:4310";
    const tools = ((await (await fetch(`${server}/api/tools/config`)).json()) as { tools: ToolbeltTool[] }).tools;
    const grid = args.includes("--sweep")
      ? [2, 2.5, 3, 3.5, 4, 4.5, 5].map((family) => ({ family }))
      : undefined;
    const scores = await measureToolbelt({ toolbelt: runtime.toolbelt, tools, cases: set, ...(grid ? { thresholds: grid } : {}) });
    const out = option(args, "--out");
    if (out) fs.writeFileSync(out, `${JSON.stringify(scores, null, 2)}\n`);
    const summary = (score: (typeof scores)[number]) => ({
      family: score.thresholds.family,
      recall: `${score.recall.hit}/${score.recall.total}`, leaks: score.leaks, pluginOnNoTool: score.pluginOnNoTool,
      emptyOnNoTool: `${score.emptyOnNoTool.empty}/${score.emptyOnNoTool.total}`, meanOffered: Number(score.meanOffered.toFixed(1))
    });
    result = grid ? scores.map(summary) : { ...summary(scores[0]!), cases: scores[0]!.cases.map((entry) =>
      `${entry.hit === false ? "MISS" : entry.leaked.length ? "LEAK" : "ok  "} ${entry.message.slice(0, 60).replace(/\n/g, " ")} → ${entry.offered.join(", ") || "(none)"}${entry.leaked.length ? ` [leaked ${entry.leaked.join(", ")}]` : ""}`) };
  } else if (group === "probe" && command === "qualify") {
    // Measures models on a judgment class and records the result as their
    // qualification for it (unless --no-record). Models are named as Ollama
    // names them, or by configured processor id.
    const configured = runtime.config.modelRuntime.processors.filter((processor) => processor.provider !== "genesis");
    const baseUrl = configured.find((processor) => processor.provider === "ollama")?.baseUrl ?? "http://127.0.0.1:11434";
    const named = option(args, "--models")?.split(",").map((value) => value.trim()).filter(Boolean);
    const processors = named
      ? named.map((name) => configured.find((processor) => processor.id === name) ?? processorFor(name, configured, baseUrl))
      : configured.filter((processor) => processor.enabled);
    // --corpus v5-additions measures the 2026-10-22 additions only; a
    // qualification is recorded only on the official corpus.
    const corpusName = option(args, "--corpus");
    if (corpusName && corpusName !== "v5-additions") throw new Error("--corpus takes v5-additions");
    if (corpusName && !args.includes("--no-record")) throw new Error("--corpus requires --no-record: only the official corpus is recorded");
    // --capability paired-entailment measures the paired judgment on v4 and
    // the v5 additions, with Speck-formed opposites (needs the parse sidecar).
    const capability = option(args, "--capability") ?? "atomic-entailment";
    if (capability !== "atomic-entailment" && capability !== "paired-entailment") throw new Error("--capability takes atomic-entailment or paired-entailment");
    const results = await runQualificationProbe({
      processors, repetitions: Number(option(args, "--repetitions") ?? 3), capability,
      ...(corpusName ? { corpus: CORPUS_V5_ADDITIONS } : {}),
      ...(option(args, "--timeout") ? { timeoutMs: Number(option(args, "--timeout")) } : {}),
      onAnswer: (processorId, pair, answer) => console.error(`[qualify] ${processorId} ${answer.proposition === pair.label ? "ok " : "BAD"} ${pair.proposition} → ${answer.proposition ?? "invalid"} (want ${pair.label}); opposite → ${answer.opposite ?? "invalid"}`)
    });
    if (!args.includes("--no-record")) for (const entry of results) runtime.processorCompetence.recordQualification(entry.model, entry.qualification);
    const out = option(args, "--out");
    if (out) fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    const rate = (tally: { correct: number; total: number }) => `${tally.correct}/${tally.total}`;
    result = results.map((entry) => ({
      model: entry.model, qualified: entry.qualification.qualified, overall: rate(entry.qualification.overall),
      entailment: rate(entry.qualification.byLabel.entailment), contradiction: rate(entry.qualification.byLabel.contradiction),
      neutral: rate(entry.qualification.byLabel.neutral), negation: rate(entry.qualification.negationConsistency),
      latencyMs: entry.qualification.meanLatencyMs, confusion: entry.qualification.confusion,
      outageTask: { overall: rate(entry.task.overall), contradiction: rate(entry.task.byLabel.contradiction), negation: rate(entry.task.negationConsistency) }
    }));
  } else if (group === "inspect") {
    result = runtime.getCognitiveState(parseWorkerId(required(command, "worker id")));
  } else if (group === "chat") {
    // One message on Speck's default path, in a session kept under data/sessions.
    const sessionId = option(args, "--session");
    const message = [command, ...args].filter((value): value is string => typeof value === "string" && !value.startsWith("--") && value !== sessionId).join(" ").trim();
    const sessions = new SessionStore(path.join(path.dirname(runtime.config.databasePath), "sessions"));
    const session = sessions.load(option(args, "--session") ?? "cli");
    const answered = await respond(session, required(message, "message"), defaultPathDependencies(runtime.config, runtime.modelRegistry, runtime));
    sessions.save(session);
    result = { reply: answered.reply, path: answered.path, components: answered.components, latencyMs: answered.latencyMs };
  } else if (["run", "bench"].includes(group ?? "") || (group === "probe" && ["roles", "trajectory", "cases"].includes(command ?? ""))) {
    throw new Error("This command drove the worker pipeline archived in failed work/pipeline-2026-10-20. Use: speck chat <message> [--session id]");
  } else if (group === "config") {
    result = runtime.config;
  } else if (group === "status") {
    result = { phase: 13, workers: runtime.listWorkers().length, models: runtime.modelRegistry.list(), tools: runtime.toolRegistry.list(), predictiveLoop: runtime.config.predictiveLoop, beliefRevision: runtime.config.beliefRevision, metacognition: runtime.config.metacognition, modelEscalation: runtime.config.modelEscalation, procedures: runtime.config.procedures, coordination: runtime.config.coordination, backgroundCognition: runtime.config.backgroundCognition, benchmarkHarness: { version: BENCHMARK_HARNESS_VERSION, standardTasks: STANDARD_TASK_SUITE.length }, tierResources: runtime.tierScheduler.snapshot(), telemetry: runtime.telemetry.snapshot(), llmRequired: false };
  } else {
    throw new Error("Usage: speck chat <message> [--session id] | speck workers [status] | speck inspect <worker-id> | speck worker <create|list|show|transition> ... | memory <recall|associate|domain-link|domain-recall|compete> ... | context build <worker-id> [token-budget] | model <list|assign|infer> ... | benchmark suite | probe toolbelt [--set development|held-out|held-out-2] [--sweep] [--server url] [--out file] | probe qualify [--models a,b] [--repetitions n] [--no-record] [--out file] | events list [worker-id] | config | status");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[speck] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  runtime.close();
}

function option(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new TypeError(`${label} is required`);
  return value;
}

function parseStatus(value: string): WorkerStatus {
  if (!WORKER_STATUSES.includes(value as WorkerStatus)) throw new TypeError(`Unknown worker status: ${value}`);
  return value as WorkerStatus;
}

function parseEdgeKind(value: string): EdgeKind {
  if (!EDGE_KINDS.includes(value as EdgeKind)) throw new TypeError(`Unknown edge kind: ${value}`);
  return value as EdgeKind;
}

// The subjects a comparison names: --current, --speck id=..,intake=..,
// worker=..,writer=..,tool=.. (unnamed roles take the configured models), and
