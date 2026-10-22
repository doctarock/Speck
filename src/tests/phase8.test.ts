import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { calibrateConfidence, recordCalibration } from "../metacognition/calibration.js";
import { loadConfig } from "../config.js";
import type { ModelProcessorDescriptor } from "../models/types.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase8-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, ...overrides });
  return { directory, databasePath, runtime };
}

const descriptor: ModelProcessorDescriptor = {
  id: "overconfident-small", provider: "ollama", model: "test", tier: 1,
  contextSize: 4096, specialties: ["general"], enabled: true
};

test("ACA rolling calibration is neutral until evidence and corrects learned overconfidence", () => {
  const config = { ...loadConfig().metacognition, calibrationWindow: 2 };
  assert.equal(calibrateConfidence(0.9, undefined, config.calibrationMinimumSamples), 0.9);
  const first = recordCalibration({ processorId: "small", reportedConfidence: 0.9, reward: 0.1, at: "2026-01-01T00:00:00Z", config });
  assert.equal(calibrateConfidence(0.9, first, config.calibrationMinimumSamples), 0.9);
  const second = recordCalibration({ processorId: "small", reportedConfidence: 0.8, reward: 0.2, at: "2026-01-02T00:00:00Z", current: first, config });
  assert.ok(Math.abs(second.bias - 0.7) < 1e-9);
  assert.ok(Math.abs(calibrateConfidence(0.9, second, config.calibrationMinimumSamples) - 0.2) < 1e-9);
  const third = recordCalibration({ processorId: "small", reportedConfidence: 0.5, reward: 0.5, at: "2026-01-03T00:00:00Z", current: second, config });
  assert.equal(third.samples.length, 2, "the rolling calibration window must remain bounded");
});

test("processor calibration persists and is applied to later model reflections", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Calibrate the attached model");
    await f.runtime.recordModelOutcome({ workerId: worker.id, processorId: descriptor.id, reportedConfidence: 0.9, reward: 0.1 });
    await f.runtime.recordModelOutcome({ workerId: worker.id, processorId: descriptor.id, reportedConfidence: 0.9, reward: 0.1 });
    f.runtime.registerModelProcessor(descriptor, { infer: async () => ({ text: '{"confidence":0.9,"response":"answer"}' }) });
    const result = await f.runtime.inferForWorker({ workerId: worker.id, processorId: descriptor.id });
    assert.ok(Math.abs(result.response.confidence - 0.1) < 1e-9);
    assert.equal((result.object.data.modelResponse as Record<string, unknown>).reportedConfidence, 0.9);
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    const profile = restored.getWorker(worker.id)?.confidence.calibration?.[descriptor.id];
    assert.equal(profile?.samples.length, 2);
    assert.ok(Math.abs((profile?.reliability ?? 0) - 0.2) < 1e-9);
  } finally {
    restored?.close();
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("unchanged cognitive state produces one durable loop impasse", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Notice a loop");
    await f.runtime.completeCycle(worker.id);
    await f.runtime.completeCycle(worker.id);
    const stuck = await f.runtime.completeCycle(worker.id);
    assert.equal(stuck.status, "impasse");
    assert.equal(stuck.impasses.length, 1);
    const impasse = f.runtime.mentalObjects.get(stuck.impasses[0]!)!;
    assert.equal(impasse.kind, "impasse");
    assert.ok((impasse.data.reasons as string[]).includes("loop-detected"));
    assert.equal((impasse.data.responses as string[]).at(-2), "increase-model-tier", "escalation must follow cheaper remedies");
    const again = await f.runtime.completeCycle(worker.id);
    assert.equal(again.impasses.length, 1, "an active impasse must suppress duplicate alerts");
    assert.equal(f.runtime.listEvents(worker.id).filter((event) => event.type === "impasse-detected").length, 1);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("repeated action failures and explicit blockers are recognized deterministically", async () => {
  const repeated = fixture();
  const explicit = fixture();
  try {
    const first = await repeated.runtime.createWorker("Stop retrying the same broken command");
    for (let index = 0; index < 3; index += 1) {
      await repeated.runtime.completeCycle(first.id, { action: "deploy", error: "permission denied" });
    }
    const repeatedImpasse = repeated.runtime.getCognitiveState(first.id).impasses[0]!;
    assert.ok((repeatedImpasse.data.reasons as string[]).includes("repeated-failure"));

    const second = await explicit.runtime.createWorker("Recognize unavailable work");
    const blocked = await explicit.runtime.completeCycle(second.id, { validAction: false, resourceAvailable: false });
    const explicitImpasse = explicit.runtime.mentalObjects.get(blocked.impasses[0]!)!;
    assert.deepEqual(explicitImpasse.data.reasons, ["no-valid-action", "required-resource-unavailable"]);
    assert.ok((explicitImpasse.data.responses as string[]).includes("wait-for-dependency"));
  } finally {
    repeated.runtime.close(); explicit.runtime.close();
    fs.rmSync(repeated.directory, { recursive: true, force: true });
    fs.rmSync(explicit.directory, { recursive: true, force: true });
  }
});

test("a multi-state periodic loop is detected before either state reaches the repetition threshold", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Detect A-B cycling");
    for (const value of ["A", "B", "A", "B"]) {
      await f.runtime.setWorldState({ workerId: worker.id, key: "step", value, epistemicStatus: "observed" });
      await f.runtime.completeCycle(worker.id);
    }
    const current = f.runtime.getWorker(worker.id)!;
    const impasse = f.runtime.mentalObjects.get(current.impasses[0]!)!;
    assert.ok((impasse.data.reasons as string[]).includes("loop-detected"));
    assert.equal(current.metacognition?.repeatedStateCount, 2);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("real progress resets stagnation and prevents false impasses", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Keep moving");
    for (let index = 0; index < 12; index += 1) await f.runtime.completeCycle(worker.id, { madeProgress: true });
    const current = f.runtime.getWorker(worker.id)!;
    assert.equal(current.impasses.length, 0);
    assert.equal(current.metacognition?.cyclesWithoutProgress, 0);
    assert.equal(current.metacognition?.repeatedStateCount, 0);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("impasses survive restart, enter context, and can be explicitly resolved", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Recover from a blocker");
    const stuck = await f.runtime.completeCycle(worker.id, { validAction: false });
    const impasseId = stuck.impasses[0]!;
    assert.match(f.runtime.buildContext({ workerId: worker.id }).text, /ACTIVE IMPASSE/);
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    assert.equal(restored.getWorker(worker.id)?.metacognition?.activeImpasseId, impasseId);
    const resolved = await restored.resolveImpasse({ workerId: worker.id, impasseId, resolution: "new information arrived" });
    assert.equal(resolved.worker.status, "ready");
    assert.equal(resolved.worker.metacognition?.activeImpasseId, null);
    assert.equal(resolved.impasse.data.status, "resolved");
  } finally {
    restored?.close();
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("metacognition and impasse detection are independently ablatable", async () => {
  const assessmentOff = fixture({ metacognition: { enabled: false } });
  const impasseOff = fixture({ metacognition: { impasseDetectionEnabled: false } });
  try {
    const first = await assessmentOff.runtime.createWorker("No assessment");
    const second = await impasseOff.runtime.createWorker("Assessment without intervention");
    for (let index = 0; index < 5; index += 1) {
      await assessmentOff.runtime.completeCycle(first.id, { validAction: false });
      await impasseOff.runtime.completeCycle(second.id, { validAction: false });
    }
    assert.equal(assessmentOff.runtime.getWorker(first.id)?.metacognition?.cycleHistory.length, 0);
    assert.equal(impasseOff.runtime.getWorker(second.id)?.metacognition?.cycleHistory.length, 5);
    assert.equal(impasseOff.runtime.getWorker(second.id)?.impasses.length, 0);
  } finally {
    assessmentOff.runtime.close(); impasseOff.runtime.close();
    fs.rmSync(assessmentOff.directory, { recursive: true, force: true });
    fs.rmSync(impasseOff.directory, { recursive: true, force: true });
  }
});

test("a failure repeated across cycles that made progress is not a loop", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Answer across several user turns");
    await f.runtime.completeCycle(worker.id, { action: "wait-rejected", error: "more data needed" });
    await f.runtime.completeCycle(worker.id, { action: "wait-rejected", error: "more data needed" });
    await f.runtime.completeCycle(worker.id, { madeProgress: true, action: "uncertain-reply" });
    const after = await f.runtime.completeCycle(worker.id, { action: "wait-rejected", error: "more data needed" });
    const reasons = after.impasses.flatMap((id) => f.runtime.mentalObjects.get(id)!.data.reasons as string[]);
    assert.ok(!reasons.includes("repeated-failure"), reasons.join(", "));
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a hypothesis the evidence has rejected is not an open conflict", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Learn a rule from examples");
    const hypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "remainder by 3 decides the label", confidence: 0.5 });
    const supporting = await f.runtime.recordEvidence({ workerId: worker.id, content: "A24 → Red", source: "user message", reliability: 0.8 });
    const refuting = await f.runtime.recordEvidence({ workerId: worker.id, content: "A63 → Blue", source: "user message", reliability: 0.8 });
    await f.runtime.reviseHypothesesFromEvidence({ workerId: worker.id, evidenceId: supporting.id, relations: [{ hypothesisId: hypothesis.id, direction: "supports" }] });
    await f.runtime.reviseHypothesesFromEvidence({ workerId: worker.id, evidenceId: refuting.id, relations: [{ hypothesisId: hypothesis.id, direction: "contradicts", decisive: true }] });
    const cycle = await f.runtime.completeCycle(worker.id, { action: "wait-rejected", error: "more data needed" });
    const reasons = cycle.impasses.flatMap((id) => f.runtime.mentalObjects.get(id)!.data.reasons as string[]);
    assert.ok(!reasons.includes("conflicting-evidence"));
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
