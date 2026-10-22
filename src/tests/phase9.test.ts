import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { routeEscalation, TierScheduler } from "../models/escalation.js";
import type { ModelProcessorDescriptor, ModelProcessorSnapshot } from "../models/types.js";
import { loadConfig } from "../config.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase9-"));
  const runtime = new SpeckRuntime({ databasePath: path.join(directory, "speck.sqlite"), ...overrides });
  return { directory, runtime };
}

function descriptor(id: string, tier: 1 | 2 | 3 | 4, specialties = ["general", "planning"]): ModelProcessorDescriptor {
  return { id, provider: "ollama", model: id, tier, contextSize: 4096 * tier, specialties, enabled: true };
}

function snapshot(id: string, tier: 1 | 2 | 3 | 4, reliability: number, specialties = ["general"]): ModelProcessorSnapshot {
  return {
    ...descriptor(id, tier, specialties), calls: 2, successes: reliability * 2,
    failures: (1 - reliability) * 2, contractFailures: 0, transportFailures: (1 - reliability) * 2,
    historicalReliability: reliability, available: true, lastError: null, lastFailureKind: null
  };
}

async function activeImpasse(runtime: SpeckRuntime, workerId: Parameters<SpeckRuntime["getWorker"]>[0]) {
  const worker = await runtime.completeCycle(workerId, { validAction: false });
  return worker.impasses[0]!;
}

test("routing selects the smallest suitable higher tier and uses calibrated reliability within it", () => {
  const route = routeEscalation({
    processors: [snapshot("base", 1, 0.9), snapshot("generic-7b", 2, 0.9), snapshot("planner-a", 2, 0.5, ["planning"]), snapshot("planner-b", 2, 0.6, ["planning"]), snapshot("huge", 4, 1, ["planning"])],
    fromTier: 1,
    specialty: "planning",
    calibration: {
      "planner-a": { processorId: "planner-a", samples: [], bias: 0, meanAbsoluteError: 0.1, reliability: 0.9, updatedAt: "now" },
      "planner-b": { processorId: "planner-b", samples: [], bias: 0, meanAbsoluteError: 0.4, reliability: 0.6, updatedAt: "now" }
    },
    config: loadConfig().modelEscalation
  });
  assert.equal(route.processor.id, "planner-a");
  assert.equal(route.toTier, 2);
});

test("a Worker temporarily consults a larger model then resumes its original assignment", async () => {
  const f = fixture();
  try {
    f.runtime.registerModelProcessor(descriptor("small-3b", 1), { infer: async () => ({ text: "small" }) });
    f.runtime.registerModelProcessor(descriptor("large-7b", 2), { infer: async () => ({ text: '{"confidence":0.85,"response":"inspect the dependency graph"}' }) });
    const worker = await f.runtime.createWorker("Resolve a planning impasse");
    await f.runtime.assignModelProcessor(worker.id, "small-3b");
    const impasseId = await activeImpasse(f.runtime, worker.id);
    const result = await f.runtime.consultOnImpasse({ workerId: worker.id, impasseId, specialty: "planning" });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.fromProcessorId, "small-3b");
    assert.equal(result.toProcessorId, "large-7b");
    assert.deepEqual(result.worker.modelAssignment, { processorId: "small-3b", tier: 1 });
    assert.equal(result.reflection.provenance.source, "large-7b");
    assert.ok(result.worker.workingMemory.includes(result.reflection.id));
    const impasse = f.runtime.mentalObjects.get(impasseId)!;
    assert.equal((impasse.data.consultations as unknown[]).length, 1);
    const events = f.runtime.listEvents(worker.id);
    assert.ok(events.some((event) => event.type === "model.escalated"));
    assert.ok(events.some((event) => event.type === "model.deescalated" && event.payload.resumedProcessorId === "small-3b"));
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a busy higher tier defers immediately instead of queueing another escalation", async () => {
  const f = fixture({ modelEscalation: { tierConcurrency: { 2: 1 } } });
  let unblock!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  try {
    f.runtime.registerModelProcessor(descriptor("small", 1), { infer: async () => ({ text: "small" }) });
    f.runtime.registerModelProcessor(descriptor("large", 2), { infer: async () => { started(); await gate; return { text: "resolved" }; } });
    const worker = await f.runtime.createWorker("Respect scarce model capacity");
    await f.runtime.assignModelProcessor(worker.id, "small");
    const impasseId = await activeImpasse(f.runtime, worker.id);
    const first = f.runtime.consultOnImpasse({ workerId: worker.id, impasseId });
    await began;
    assert.equal(f.runtime.tierScheduler.snapshot().find((entry) => entry.tier === 2)?.available, 0);
    const second = await f.runtime.consultOnImpasse({ workerId: worker.id, impasseId });
    assert.deepEqual(second, { status: "deferred", fromProcessorId: "small", toProcessorId: "large", reason: "tier-busy" });
    unblock();
    assert.equal((await first).status, "completed");
    assert.equal(f.runtime.tierScheduler.snapshot().find((entry) => entry.tier === 2)?.available, 1);
  } finally {
    unblock?.();
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("tier scheduler releases capacity exactly once", () => {
  const scheduler = new TierScheduler({ 3: 1 });
  const release = scheduler.tryAcquire(3)!;
  assert.equal(scheduler.tryAcquire(3), null);
  release(); release();
  assert.equal(scheduler.snapshot()[0]?.available, 1);
});

test("escalation requires an active impasse and can be independently ablated", async () => {
  const ordinary = fixture();
  const disabled = fixture({ modelEscalation: { enabled: false } });
  try {
    for (const runtime of [ordinary.runtime, disabled.runtime]) {
      runtime.registerModelProcessor(descriptor("small", 1), { infer: async () => ({ text: "small" }) });
      runtime.registerModelProcessor(descriptor("large", 2), { infer: async () => ({ text: "large" }) });
    }
    const noImpasse = await ordinary.runtime.createWorker("Do not escalate trivially");
    await ordinary.runtime.assignModelProcessor(noImpasse.id, "small");
    await assert.rejects(() => ordinary.runtime.consultOnImpasse({ workerId: noImpasse.id, impasseId: noImpasse.id as any }), /MentalObject|active Impasse/);
    const blocked = await disabled.runtime.createWorker("Escalation disabled");
    await disabled.runtime.assignModelProcessor(blocked.id, "small");
    const impasseId = await activeImpasse(disabled.runtime, blocked.id);
    await assert.rejects(() => disabled.runtime.consultOnImpasse({ workerId: blocked.id, impasseId }), /disabled/);
  } finally {
    ordinary.runtime.close(); disabled.runtime.close();
    fs.rmSync(ordinary.directory, { recursive: true, force: true });
    fs.rmSync(disabled.directory, { recursive: true, force: true });
  }
});
