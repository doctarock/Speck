import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NATIVE_VERIFICATION, ProcessorCompetenceStore, outcomeCapability, protocolCapability
} from "../metacognition/competence.js";
import type { ModelProcessorDescriptor } from "../models/types.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

test("protocol choice follows evidence, and a failing protocol yields to the untried one", () => {
  const store = new ProcessorCompetenceStore(null);
  // A model whose native test call worked starts on native.
  store.record("m", NATIVE_VERIFICATION, { success: true, source: "test call" });
  assert.equal(store.preferredProtocol("m", "tool-intent"), "native");
  // Native replies are usable, but the operations they choose keep failing.
  for (let index = 0; index < 4; index += 1) {
    store.record("m", protocolCapability("tool-intent", "native"), { success: true, source: "call" });
    store.record("m", outcomeCapability("tool-intent", "native"), { success: false, source: "invalid arguments" });
  }
  assert.equal(store.preferredProtocol("m", "tool-intent"), "json", "json is explored once native has a poor record");
  // A model whose test call failed is not explored on native without other evidence.
  store.record("n", NATIVE_VERIFICATION, { success: false, source: "test call" });
  store.record("n", outcomeCapability("tool-intent", "json"), { success: false, source: "invalid arguments" });
  assert.equal(store.preferredProtocol("n", "tool-intent"), "json");
});

test("the context window follows the largest observed call and doubles past an overflow", () => {
  const store = new ProcessorCompetenceStore(null);
  const limits = { minimum: 2_048, maximum: 32_768, replyReserve: 1_024 };
  assert.equal(store.contextWindow("m", limits), 2_048);
  store.recordTokens("m", 1_300, false);
  assert.equal(store.contextWindow("m", limits), 4_096);
  store.recordTokens("m", 4_096, true);
  assert.equal(store.contextWindow("m", limits), 16_384);
  store.recordTokens("m", 40_000, true);
  assert.equal(store.contextWindow("m", limits), 32_768, "never beyond the model's trained size");
});

const descriptor = (id: string): ModelProcessorDescriptor => ({
  id, provider: "ollama", model: `${id}-model`, tier: 1, contextSize: 8_192, specialties: ["general"], enabled: true
});

function runtimeAt(directory: string, routing: "configured" | "competence") {
  const runtime = new SpeckRuntime({
    databasePath: path.join(directory, "speck.sqlite"),
    modelRuntime: { processors: [], roles: { intake: "a", planner: "a", worker: "a", toolCaller: "a", specialists: {} }, routing }
  });
  for (const id of ["a", "b"]) runtime.registerModelProcessor(descriptor(id), { infer: async () => ({ text: "{}" }) });
  return runtime;
}

test("competence persists across restarts and routes a role once every candidate has enough evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-competence-"));
  const opened: SpeckRuntime[] = [];
  const open = (routing: "configured" | "competence") => { const runtime = runtimeAt(directory, routing); opened.push(runtime); return runtime; };
  try {
    const first = open("competence");
    assert.equal(first.processorForRole("worker"), "a", "the configured processor until there is evidence");
    for (let index = 0; index < 6; index += 1) {
      first.recordJudgment({ producerId: "a", contract: "speck-worker-cycle", protocol: "json", aspect: "quality", evaluator: "b", verdict: index < 2 ? "accepted" : "rejected" });
      first.recordJudgment({ producerId: "b", contract: "speck-worker-cycle", protocol: "json", aspect: "quality", evaluator: "a", verdict: "accepted" });
    }
    assert.equal(first.processorForRole("worker"), "b");
    first.close();
    const restarted = open("competence");
    assert.equal(restarted.processorForRole("worker"), "b", "the evidence survived the restart");
    restarted.close();
    const configured = open("configured");
    assert.equal(configured.processorForRole("worker"), "a", "configured routing ignores competence");
    configured.close();
  } finally {
    for (const runtime of opened) runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the native test call is made once per model and kept as evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-competence-"));
  try {
    let tests = 0;
    const make = () => {
      const runtime = new SpeckRuntime({
        databasePath: path.join(directory, "speck.sqlite"),
        modelRuntime: { processors: [], roles: { intake: "t", planner: "t", worker: "t", toolCaller: "t", specialists: {} } }
      });
      runtime.registerModelProcessor(descriptor("t"), {
        supportsNativeTools: async () => { tests += 1; return true; },
        infer: async (request) => ({ text: "", toolCalls: request.tools ? [{ name: "service_status", arguments: { service: "nginx" } }] : [] })
      });
      runtime.toolRegistry.register({
        name: "service_status", description: "Read a service status.", intents: ["read_service_status"],
        inputSchema: { service: { type: "string", required: true } },
        risk: "read-only", sideEffects: [], requiredPermissions: [], source: "test"
      }, async () => ({ active: true }));
      return runtime;
    };
    const first = make();
    const worker = await first.createWorker("Is nginx up?");
    const proposed = await first.proposeToolIntent({ workerId: worker.id, request: "Is nginx up?" });
    assert.equal(proposed.response.toolCalling, "native");
    first.close();
    const second = make();
    const again = await second.createWorker("Is nginx up?");
    await second.proposeToolIntent({ workerId: again.id, request: "Is nginx up?" });
    second.close();
    assert.equal(tests, 1, "the test call is not repeated once evidence exists");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("only independent or deterministic judgments count, and every judgment keeps its evaluator", () => {
  const store = new ProcessorCompetenceStore(null);
  const base = { contract: "speck-worker-cycle", protocol: "json" as const, aspect: "quality" as const, deterministicOutcome: null, context: {} };
  const self = store.judge("small", { ...base, evaluator: "small", verdict: "accepted" });
  assert.equal(self.verdict, "unobserved", "a model approving its own reply is not evidence");
  assert.equal(store.capability("small", outcomeCapability("speck-worker-cycle", "json")), undefined);
  // Two evaluators judge the same producer; one is far more lenient.
  for (let index = 0; index < 10; index += 1) {
    store.judge("small", { ...base, evaluator: "lenient", verdict: "accepted" });
    store.judge("small", { ...base, evaluator: "strict", verdict: index < 3 ? "accepted" : "rejected" });
  }
  const rows = store.agreement("speck-worker-cycle");
  assert.deepEqual(rows.map((row) => [row.evaluator, row.accepted, row.judged]).sort(), [["lenient", 10, 10], ["strict", 3, 10]]);
  assert.equal(store.get("small")!.judgments.length, 21, "the self-judgment is kept, unobserved");
  store.judge("small", { ...base, aspect: "execution", contract: "tool-intent", evaluator: "deterministic", verdict: "accepted", deterministicOutcome: "executed" });
  assert.equal(store.capability("small", outcomeCapability("tool-intent", "json", "execution"))?.successes, 1);
  store.judge("small", { ...base, aspect: "selection", contract: "tool-intent", evaluator: null, verdict: "accepted" });
  assert.equal(store.capability("small", outcomeCapability("tool-intent", "json", "selection")), undefined, "nothing independent judged selection");
});

test("two stores on one file keep each other's records: a stale store does not overwrite newer ones", () => {
  // As the server and a CLI probe do: each loads the file, then records.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-competence-"));
  const file = path.join(directory, "competence.json");
  try {
    const server = new ProcessorCompetenceStore(file);
    const probe = new ProcessorCompetenceStore(file);
    server.record("m", "c@json", { success: true, source: "server" });
    probe.record("m", "c@json", { success: false, source: "probe" });
    probe.recordTokens("m", 900, false);
    // The server records again from its older copy.
    server.record("m", "c@json", { success: true, source: "server" });
    server.recordTokens("m", 500, false);
    const reread = new ProcessorCompetenceStore(file);
    assert.deepEqual({ successes: reread.capability("m", "c@json")?.successes, failures: reread.capability("m", "c@json")?.failures }, { successes: 2, failures: 1 });
    assert.equal(reread.get("m")?.peakTokens, 900, "the larger peak stands");
    // What one store recorded is read by the other without a restart.
    assert.equal(server.capability("m", "c@json")?.failures, 1);
    assert.equal(server.get("m")?.peakTokens, 900);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
