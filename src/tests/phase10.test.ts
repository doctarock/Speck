import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { ProcedureStep } from "../procedure/types.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase10-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, ...overrides });
  return { directory, databasePath, runtime };
}

async function verifiedEpisode(runtime: SpeckRuntime, workerId: Parameters<SpeckRuntime["getWorker"]>[0], content: string) {
  return runtime.createMentalObject({ workerId, kind: "observation", content, confidence: 1, actor: { kind: "user", source: "test" } });
}

async function compile(runtime: SpeckRuntime, workerId: Parameters<SpeckRuntime["getWorker"]>[0], trigger: string, steps: ProcedureStep[], extra: Record<string, unknown> = {}) {
  let result;
  for (let index = 0; index < 3; index += 1) {
    const episode = await verifiedEpisode(runtime, workerId, `verified ${trigger} ${index}`);
    result = await runtime.recordProcedureDemonstration({ workerId, trigger, steps, episodeId: episode.id, ...extra });
  }
  return result!;
}

test("three distinct verified episodes compile an idempotent ACA-style procedure candidate", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Learn a repeatable answer");
    const steps: ProcedureStep[] = [{ kind: "answer", text: "E:\\AI\\Speck" }];
    const firstEpisode = await verifiedEpisode(f.runtime, worker.id, "first verified result");
    const first = await f.runtime.recordProcedureDemonstration({ workerId: worker.id, trigger: "Project path?", steps, episodeId: firstEpisode.id });
    const duplicate = await f.runtime.recordProcedureDemonstration({ workerId: worker.id, trigger: " project path! ", steps, episodeId: firstEpisode.id });
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.data.verifiedSuccesses, 1);
    let compiled = duplicate;
    for (let index = 1; index < 3; index += 1) {
      const episode = await verifiedEpisode(f.runtime, worker.id, `verified result ${index}`);
      compiled = await f.runtime.recordProcedureDemonstration({ workerId: worker.id, trigger: "project path", steps, episodeId: episode.id });
    }
    assert.equal(compiled.data.status, "compiled");
    assert.equal(compiled.confidence, 1);
    assert.equal((compiled.data.creditedEpisodeIds as unknown[]).length, 3);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("a compiled procedure executes with no model call and learns ACT-R utility", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Use learned competence");
    const procedure = await compile(f.runtime, worker.id, "where is speck", [{ kind: "answer", text: "E:\\AI\\Speck" }]);
    const beforeModelCalls = f.runtime.telemetry.snapshot().counters["model.calls"] ?? 0;
    const result = await f.runtime.executeProcedure({ workerId: worker.id, trigger: " Where is Speck? " });
    assert.equal(result.matched, true);
    assert.equal(result.successful, true);
    assert.deepEqual(result.outputs, [{ kind: "answer", text: "E:\\AI\\Speck" }]);
    assert.equal(f.runtime.telemetry.snapshot().counters["model.calls"] ?? 0, beforeModelCalls);
    assert.ok(Number(result.procedure?.data.utility) > Number(procedure.data.utility));
    assert.equal(f.runtime.telemetry.snapshot().counters["llm.calls.avoided"], 1);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("preconditions fail closed before any procedure step executes", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Validate before replay");
    let calls = 0;
    f.runtime.toolRegistry.register({
      name: "read_status", description: "read", intents: ["read_status"], inputSchema: {}, risk: "read-only", sideEffects: [], requiredPermissions: [], source: "test"
    }, async () => { calls += 1; return { ok: true }; });
    const procedure = await compile(f.runtime, worker.id, "check status", [{ kind: "tool", intent: { intent: "read_status", arguments: {}, expectedOutcome: "status read" } }], {
      preconditions: [{ path: "worldState.ready", operator: "equals", value: true }]
    });
    const result = await f.runtime.executeProcedure({ workerId: worker.id, trigger: "check status" });
    assert.equal(result.reason, "precondition-failed");
    assert.equal(calls, 0);
    assert.equal(f.runtime.mentalObjects.get(procedure.id)?.data.successCount, 0);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("compiled tool procedures retain the ordinary Genesis-compatible authorization boundary", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Run a governed procedure");
    let calls = 0;
    f.runtime.toolRegistry.register({
      name: "apply_fix", description: "fix", intents: ["apply_fix"], inputSchema: { target: { type: "string", required: true } },
      risk: "reversible-mutation", sideEffects: ["changes config"], requiredPermissions: ["config.write"], source: "test"
    }, async () => { calls += 1; return { ok: true }; });
    await compile(f.runtime, worker.id, "apply standard fix", [{ kind: "tool", intent: {
      intent: "apply_fix", arguments: { target: "service" }, expectedOutcome: "fix applied"
    } }]);
    const blocked = await f.runtime.executeProcedure({ workerId: worker.id, trigger: "apply standard fix" });
    assert.equal(blocked.successful, false);
    assert.match(blocked.reason ?? "", /permission|approval/);
    assert.equal(calls, 0);
    assert.equal(blocked.procedure?.data.failureCount, 0, "missing authority is not evidence that the procedure is defective");
    const allowed = await f.runtime.executeProcedure({
      workerId: worker.id, trigger: "apply standard fix",
      authorization: { approved: true, approvedBy: "operator", permissions: ["config.write"] }
    });
    assert.equal(allowed.successful, true);
    assert.equal(calls, 1);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("conflicting compiled sequences become ambiguous rather than executing arbitrarily", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Fail closed on ambiguity");
    const original = await compile(f.runtime, worker.id, "routine", [{ kind: "answer", text: "A" }]);
    assert.equal(original.data.status, "compiled");
    await compile(f.runtime, worker.id, "routine", [{ kind: "answer", text: "B" }]);
    const result = await f.runtime.executeProcedure({ workerId: worker.id, trigger: "routine" });
    assert.equal(result.matched, false);
    assert.equal(result.reason, "no-unambiguous-procedure");
    assert.equal(f.runtime.mentalObjects.get(original.id)?.data.status, "candidate");
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("repeated validator failure deprecates a procedure without deleting its audit history", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Retire a broken shortcut");
    const procedure = await compile(f.runtime, worker.id, "broken", [{ kind: "answer", text: "old" }], {
      validators: [{ path: "lastOutput.text", operator: "equals", value: "new" }]
    });
    for (let index = 0; index < 3; index += 1) await f.runtime.executeProcedure({ workerId: worker.id, trigger: "broken" });
    const deprecated = f.runtime.mentalObjects.get(procedure.id)!;
    assert.equal(deprecated.data.status, "deprecated");
    assert.equal(deprecated.status, "archived");
    assert.equal((deprecated.data.executionHistory as unknown[]).length, 3);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("Known Answers use normalized exact retrieval, retain provenance, and survive restart", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Remember a deterministic fact");
    const source = await verifiedEpisode(f.runtime, worker.id, "inspected package root");
    const known = await f.runtime.recordKnownAnswer({
      workerId: worker.id, query: "Where is the project?", aliases: ["project path"], answer: "E:\\AI\\Speck", sourceObjectId: source.id, confidence: 0.95
    });
    assert.equal((await f.runtime.retrieveKnownAnswer(worker.id, " PROJECT PATH! "))?.id, known.id);
    assert.equal(await f.runtime.retrieveKnownAnswer(worker.id, "different question"), null);
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    const hit = await restored.retrieveKnownAnswer(worker.id, "where is the project");
    assert.equal(hit?.data.sourceObjectId, source.id);
    assert.equal(hit?.provenance.kind, "runtime");
  } finally { restored?.close(); f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("model output cannot self-verify a procedure and proceduralisation is ablatable", async () => {
  const f = fixture();
  const disabled = fixture({ procedures: { enabled: false } });
  try {
    const worker = await f.runtime.createWorker("Reject self verification");
    const reflection = await f.runtime.createMentalObject({ workerId: worker.id, kind: "reflection", content: "I succeeded", actor: { kind: "model", source: "small" } });
    await assert.rejects(() => f.runtime.recordProcedureDemonstration({
      workerId: worker.id, trigger: "self claim", steps: [{ kind: "answer", text: "unsafe" }], episodeId: reflection.id
    }), /externally verified/);
    const other = await disabled.runtime.createWorker("No procedures");
    const episode = await verifiedEpisode(disabled.runtime, other.id, "verified");
    await assert.rejects(() => disabled.runtime.recordProcedureDemonstration({
      workerId: other.id, trigger: "x", steps: [{ kind: "answer", text: "x" }], episodeId: episode.id
    }), /disabled/);
  } finally {
    f.runtime.close(); disabled.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
    fs.rmSync(disabled.directory, { recursive: true, force: true });
  }
});
