// The NLI processor: a purpose-trained cross-encoder that answers atomic
// entailment and nothing else, reached only as a qualified checker.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateModelRoles, validateModelProcessors } from "../config.js";
import { brainConfig } from "../genesis-ui/presentation.js";
import { ATOMIC_ENTAILMENT_CORPUS, entailmentRequest, opposed, scoreQualification } from "../metacognition/qualification.js";
import { NliProcessor } from "../models/providers.js";
import type { ConfiguredModelProcessor } from "../models/types.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

// A sidecar that records what it was asked and calls everything a
// contradiction.
async function stubSidecar(): Promise<{ url: string; asked: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const asked: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      asked.push({ path: request.url, ...JSON.parse(body || "{}") });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ label: "contradiction", scores: { entailment: 0.02, contradiction: 0.93, neutral: 0.05 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, asked, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const nliDescriptor = (url: string): ConfiguredModelProcessor => ({
  id: "nli-checker", provider: "nli", model: "test/nli-model", baseUrl: url, tier: 1, contextSize: 512, specialties: ["atomic-entailment"], enabled: true
});

test("the NLI processor sends the model, premise and hypothesis, and answers with a label and its probability", async () => {
  const sidecar = await stubSidecar();
  try {
    const processor = new NliProcessor(nliDescriptor(sidecar.url));
    const { contract, input } = entailmentRequest("The server remained healthy afterward.", "The restart left the server unhealthy.");
    const completion = await processor.infer({ prompt: "ignored", temperature: 0, timeoutMs: 5_000, contract, input });
    assert.deepEqual(sidecar.asked[0], { path: "/classify", model: "test/nli-model", premise: "The server remained healthy afterward.", hypothesis: "The restart left the server unhealthy." });
    assert.deepEqual(JSON.parse(completion.text), { confidence: 0.93, response: { label: "contradiction" } });
  } finally {
    await sidecar.close();
  }
});

test("the NLI processor answers nothing but atomic entailment", async () => {
  const processor = new NliProcessor(nliDescriptor("http://127.0.0.1:9"));
  await assert.rejects(processor.infer({ prompt: "Write a reply.", temperature: 0, timeoutMs: 1_000, contract: { name: "speck-worker-cycle", required: [], properties: {} } }), /answers only speck-atomic-entailment/);
  await assert.rejects(processor.infer({ prompt: "no operands", temperature: 0, timeoutMs: 1_000, contract: entailmentRequest("a", "b").contract }), /premise and a hypothesis/);
});

test("a judgment-only processor never fills a role, is never chosen by default or as a validator, and is reached once qualified", async () => {
  const sidecar = await stubSidecar();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-nli-"));
  const writer: ConfiguredModelProcessor = { id: "writer", provider: "ollama", model: "writer-model", baseUrl: "http://127.0.0.1:9", tier: 1, contextSize: 4096, specialties: ["general"], enabled: true };
  // Listed first, so any selection that ignored its kind would land on it.
  const processors = validateModelProcessors([nliDescriptor(sidecar.url), writer]);
  assert.throws(() => validateModelRoles({ intake: "nli-checker" }, processors), /intake role cannot be filled by nli-checker: it is a judgment-only processor; use it as the checker/);
  const roles = validateModelRoles({}, processors);
  assert.equal(roles.worker, "writer", "the default role holder is a model that writes");
  const runtime = new SpeckRuntime({ databasePath: path.join(directory, "speck.sqlite"), genesisRuntimePath: directory, modelRuntime: { processors, roles } });
  try {
    assert.equal(runtime.modelRegistry.select().id, "writer");
    assert.deepEqual(runtime.independentProcessors("writer", "speck-completion-validation"), []);
    assert.equal(runtime.qualifiedProcessor("writer", "atomic-entailment"), null, "not yet measured");
    const answers = [0, 1, 2].flatMap(() => ATOMIC_ENTAILMENT_CORPUS.map((pair) => ({ pair, proposition: pair.label, opposite: opposed(pair.label) })));
    runtime.processorCompetence.recordQualification("nli:test/nli-model", scoreQualification("atomic-entailment", answers, 3, 20));
    assert.equal(runtime.qualifiedProcessor("writer", "atomic-entailment"), "nli-checker");
    // Through the runtime, as the hypothesis checks call it.
    const worker = await runtime.createWorker("check");
    const judged = await runtime.inferForWorker({ workerId: worker.id, processorId: "nli-checker", contextScope: "minimal", ...entailmentRequest("p", "h") });
    assert.equal(judged.response.structured?.label, "contradiction");
  } finally {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
    await sidecar.close();
  }
});

test("the checker role names the checker; its verdicts still count only once it is qualified and independent of the producer", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-checker-"));
  const ollama = (id: string, model: string): ConfiguredModelProcessor => ({ id, provider: "ollama", model, baseUrl: "http://127.0.0.1:9", tier: 1, contextSize: 4096, specialties: ["general"], enabled: true });
  const processors = validateModelProcessors([ollama("writer", "writer-model"), ollama("other", "other-model"), nliDescriptor("http://127.0.0.1:9")]);
  assert.throws(() => validateModelRoles({ checker: "missing" }, processors), /checker role references unavailable processor missing/);
  const roles = validateModelRoles({ worker: "writer", checker: "nli-checker" }, processors);
  assert.equal(roles.checker, "nli-checker", "a judgment-only processor may take the checker seat");
  const runtime = new SpeckRuntime({ databasePath: path.join(directory, "speck.sqlite"), genesisRuntimePath: directory, modelRuntime: { processors, roles } });
  const qualified = (model: string, latencyMs: number) => runtime.processorCompetence.recordQualification(model, scoreQualification("atomic-entailment",
    [0, 1, 2].flatMap(() => ATOMIC_ENTAILMENT_CORPUS.map((pair) => ({ pair, proposition: pair.label, opposite: opposed(pair.label) }))), 3, latencyMs));
  try {
    // Another model is qualified, but the configured checker is not: void.
    qualified("ollama:other-model", 10);
    assert.equal(runtime.qualifiedProcessor("writer", "atomic-entailment"), null);
    qualified("nli:test/nli-model", 20);
    assert.equal(runtime.qualifiedProcessor("writer", "atomic-entailment"), "nli-checker", "the configured seat, though another is cheaper");
    // With the seat empty, the cheapest qualified independent model checks.
    delete runtime.config.modelRuntime.roles.checker;
    assert.equal(runtime.qualifiedProcessor("writer", "atomic-entailment"), "other");
    // A configured checker never checks its own model's output.
    runtime.config.modelRuntime.roles.checker = "writer";
    qualified("ollama:writer-model", 5);
    assert.equal(runtime.qualifiedProcessor("writer", "atomic-entailment"), null);
  } finally {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the brain configuration the interface reads shows the checker seat, who checks now, and each processor's qualification", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-brains-"));
  const processors = validateModelProcessors([{ id: "writer", provider: "ollama", model: "writer-model", baseUrl: "http://127.0.0.1:9", tier: 1, contextSize: 4096, specialties: ["general"], enabled: true }, nliDescriptor("http://127.0.0.1:9")]);
  const runtime = new SpeckRuntime({ databasePath: path.join(directory, "speck.sqlite"), genesisRuntimePath: directory, modelRuntime: { processors, roles: validateModelRoles({ worker: "writer", checker: "nli-checker" }, processors) } });
  try {
    let shown = brainConfig(runtime).brains;
    assert.deepEqual(shown.checker, { configured: "nli-checker", effective: "" }, "unqualified: checks are void");
    assert.equal(shown.qualifications["nli-checker"]?.atomicEntailment, null);
    runtime.processorCompetence.recordQualification("nli:test/nli-model", scoreQualification("atomic-entailment",
      [0, 1, 2].flatMap(() => ATOMIC_ENTAILMENT_CORPUS.map((pair) => ({ pair, proposition: pair.label, opposite: opposed(pair.label) }))), 3, 20));
    shown = brainConfig(runtime).brains;
    assert.equal(shown.checker.effective, "nli-checker");
    assert.equal(shown.qualifications["nli-checker"]?.atomicEntailment?.qualified, true);
    assert.equal(shown.builtIn.find((brain: { id: string }) => brain.id === "nli-checker")?.kind, "checker");
  } finally {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
