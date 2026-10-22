import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { comparePrediction, precisionFor } from "../prediction/compare.js";
import type { PredictionSpec } from "../prediction/types.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { ToolDefinition } from "../tools/types.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase6-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, ...overrides });
  return { directory, databasePath, runtime };
}

function tool(name: string): ToolDefinition {
  return {
    name, description: name, intents: [name], inputSchema: {}, risk: "read-only",
    sideEffects: [], requiredPermissions: [], source: "test"
  };
}

const httpPrediction: PredictionSpec = {
  description: "health endpoint returns HTTP 200",
  confidence: 0.8,
  sourceChannel: "http:health",
  conditions: [{ path: "data.status", operator: "equals", value: 200 }]
};

test("structured comparison is deterministic and precision follows ACA rolling inverse variance", () => {
  const config = loadConfig().predictiveLoop;
  const confirmed = comparePrediction(httpPrediction, { data: { status: 200 } }, [], config, "2026-01-01T00:00:00.000Z");
  const contradicted = comparePrediction(httpPrediction, { data: { status: 500 } }, [], config, "2026-01-01T00:00:00.000Z");
  assert.equal(confirmed.errorMagnitude, 0);
  assert.equal(confirmed.verdict, "confirmed");
  assert.equal(contradicted.errorMagnitude, 1);
  assert.equal(contradicted.verdict, "contradicted");
  assert.equal(precisionFor([], config), 1);
  assert.ok(precisionFor([0.5, 0.5, 0.5], config) > precisionFor([0.1, 0.9, 0.2], config));
  const expectedMissing = comparePrediction({
    description: "error field is absent", confidence: 1, sourceChannel: "test",
    conditions: [{ path: "error", operator: "exists", value: false }]
  }, {}, [], config);
  assert.equal(expectedMissing.verdict, "confirmed");
});

test("generic observation comparison persists discrepancy and alters cognition without a model", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Check service health");
    const prediction = await f.runtime.createPrediction({ workerId: worker.id, spec: httpPrediction });
    const observation = await f.runtime.createMentalObject({
      workerId: worker.id, kind: "observation", content: "health returned 500", data: { status: 500 }, memoryRoles: ["episodic"]
    });
    const result = await f.runtime.comparePredictionToObservation({
      workerId: worker.id, predictionId: prediction.id, observationId: observation.id
    });
    assert.equal(result.comparison.errorMagnitude, 1);
    assert.equal(result.worker.operationalState.mode, "focused");
    assert.equal(result.worker.operationalState.pressure, 0.35);
    assert.equal(result.worker.progress.lastProgressAt, null);
    assert.equal((result.prediction.data.prediction as any).status, "resolved");
    assert.equal((result.observation.data.predictionComparison as any).verdict, "contradicted");
    assert.equal(result.observation.importance, 1);
    const context = f.runtime.buildContext({ workerId: worker.id });
    assert.match(context.text, /RECENT PREDICTION ERRORS/);
    // Pressure drives Speck's own mode and attention; it is not model-facing context.
    assert.doesNotMatch(context.text, /pressure=/);
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    await restored.initialize();
    assert.equal((restored.mentalObjects.get(prediction.id)?.data.prediction as any).comparison.errorMagnitude, 1);
    assert.equal(restored.getWorker(worker.id)?.operationalState.pressure, 0.35);
  } finally {
    restored?.close();
    if (f.runtime.database.connection.open) f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("precision histories remain isolated by source channel", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Compare independent sources");
    for (const status of [200, 500]) {
      const prediction = await f.runtime.createPrediction({ workerId: worker.id, spec: httpPrediction });
      const observation = await f.runtime.createMentalObject({
        workerId: worker.id, kind: "observation", content: `health ${status}`, data: { status }
      });
      await f.runtime.comparePredictionToObservation({
        workerId: worker.id, predictionId: prediction.id, observationId: observation.id
      });
    }
    const independent = await f.runtime.createPrediction({
      workerId: worker.id,
      spec: { ...httpPrediction, sourceChannel: "http:independent" }
    });
    const observation = await f.runtime.createMentalObject({
      workerId: worker.id, kind: "observation", content: "independent 200", data: { status: 200 }
    });
    const result = await f.runtime.comparePredictionToObservation({
      workerId: worker.id, predictionId: independent.id, observationId: observation.id
    });
    assert.equal(result.comparison.precision, 1);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("expected tool outcomes create progress while unexpected outcomes create pressure and salience", async () => {
  const f = fixture();
  try {
    f.runtime.toolRegistry.register(tool("healthy_check"), async () => ({ ok: true, text: "healthy" }));
    f.runtime.toolRegistry.register(tool("broken_check"), async () => { throw new Error("HTTP 500"); });
    const worker = await f.runtime.createWorker("Check both services");
    const success = await f.runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "healthy_check", arguments: {}, expectedOutcome: "health check succeeds" }
    });
    const afterSuccess = f.runtime.getWorker(worker.id)!;
    assert.equal((success.outcome.data.predictionComparison as any).errorMagnitude, 0);
    assert.equal(afterSuccess.progress.score, 1);
    assert.ok(afterSuccess.progress.lastProgressAt);
    assert.equal(afterSuccess.operationalState.pressure, 0);

    const failure = await f.runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "broken_check", arguments: {}, expectedOutcome: "health check succeeds" }
    });
    const afterFailure = f.runtime.getWorker(worker.id)!;
    assert.equal((failure.outcome.data.predictionComparison as any).errorMagnitude, 1);
    assert.equal(afterFailure.progress.score, 1);
    assert.equal(afterFailure.operationalState.mode, "focused");
    assert.equal(failure.outcome.importance, 1);
    const competition = await f.runtime.competeForWorkingMemory({
      workerId: worker.id, candidateIds: [failure.outcome.id]
    });
    assert.ok(competition.candidates[0]!.rawScore >= 1);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("repeated discrepancy escalates operational pressure deterministically", async () => {
  const f = fixture();
  try {
    f.runtime.toolRegistry.register(tool("broken_check"), async () => { throw new Error("still broken"); });
    const worker = await f.runtime.createWorker("Diagnose persistent failure");
    for (let index = 0; index < 3; index += 1) {
      await f.runtime.executeToolIntent({
        workerId: worker.id,
        intent: { intent: "broken_check", arguments: {}, expectedOutcome: "check succeeds" }
      });
    }
    const updated = f.runtime.getWorker(worker.id)!;
    assert.equal(updated.operationalState.pressure, 1);
    assert.equal(updated.operationalState.mode, "conservative");
    assert.equal(updated.progress.score, 0);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("unknown tool outcomes produce uncertainty and conservative operation", async () => {
  const f = fixture({ toolRuntime: { timeoutMs: 10 } });
  try {
    f.runtime.toolRegistry.register(tool("slow_check"), async () => await new Promise(() => {}));
    const worker = await f.runtime.createWorker("Check uncertain service");
    const result = await f.runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "slow_check", arguments: {}, expectedOutcome: "check succeeds" }
    });
    assert.equal((result.outcome.data.predictionComparison as any).verdict, "uncertain");
    assert.equal(f.runtime.getWorker(worker.id)?.operationalState.mode, "conservative");
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("restart recovery converts pending tool predictions into cognitive uncertainty", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Recover uncertain action");
    const prediction = await f.runtime.createPrediction({
      workerId: worker.id,
      spec: {
        description: "external action succeeds", confidence: 0.8, sourceChannel: "tool:external_action",
        conditions: [{ path: "actualOutcome", operator: "equals", value: "succeeded" }]
      }
    });
    f.runtime.mentalObjects.update({
      ...prediction,
      data: { ...prediction.data, toolExecution: { executionId: "interrupted", status: "pending", tool: "external_action" } }
    });
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    const recovery = await restored.initialize();
    assert.equal(recovery.recoveredToolExecutions, 1);
    assert.equal((restored.mentalObjects.get(prediction.id)?.data.prediction as any).comparison.verdict, "uncertain");
    assert.equal(restored.getWorker(worker.id)?.operationalState.mode, "conservative");
  } finally {
    restored?.close();
    if (f.runtime.database.connection.open) f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("the predictive loop is independently ablatable without disabling tools", async () => {
  const f = fixture({ predictiveLoop: { enabled: false } });
  try {
    f.runtime.toolRegistry.register(tool("healthy_check"), async () => ({ ok: true }));
    const worker = await f.runtime.createWorker("Run without predictions");
    await assert.rejects(() => f.runtime.createPrediction({ workerId: worker.id, spec: httpPrediction }), /disabled/);
    const result = await f.runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "healthy_check", arguments: {}, expectedOutcome: "check succeeds" }
    });
    assert.equal(result.outcome.data.predictionComparison, undefined);
    assert.equal(f.runtime.getWorker(worker.id)?.progress.score, 0);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
