import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundScheduler } from "../background/scheduler.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { ProcedureDefinition } from "../procedure/types.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase12-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, ...overrides });
  return { directory, databasePath, runtime };
}

test("foreground work defers a background slice without starting a job", async () => {
  const scheduler = new BackgroundScheduler();
  const release = scheduler.beginForeground();
  let calls = 0;
  const result = await scheduler.runSlice([{ run: async () => ({ kind: "consolidation", workerId: "worker", examined: 0, changed: ++calls, createdIds: [] }) }], {
    enabled: true, maximumOperations: 1, timeBudgetMs: 100
  });
  release();
  assert.equal(result.status, "deferred");
  assert.equal(result.processed, 0);
  assert.equal(calls, 0);
});

test("background execution is cooperatively bounded by its operation budget", async () => {
  const f = fixture({ backgroundCognition: { maximumOperationsPerSlice: 1, timeBudgetMs: 1_000 } });
  try {
    await f.runtime.createWorker("Bound background work");
    const result = await f.runtime.runBackgroundCognition();
    assert.equal(result.status, "deferred");
    assert.equal(result.processed, 1);
    assert.equal(result.remaining, 5);
    assert.equal(result.reason, "operation budget exhausted");
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("repeated strong episodes consolidate and synthesize patterns without model inference", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Learn environment patterns");
    for (let index = 0; index < 3; index += 1) {
      await f.runtime.createMentalObject({
        workerId: worker.id, kind: "observation", content: "Server web service is nginx",
        data: { consolidationKey: "server.web-service", semanticContent: "Server web service is nginx", patternKey: "nginx-success" },
        confidence: 0.9, memoryRoles: ["episodic"], actor: { kind: "external", source: `probe-${index}` }
      });
    }
    const beforeCalls = f.runtime.telemetry.snapshot().counters["model.calls"] ?? 0;
    const result = await f.runtime.runBackgroundCognition({ workerId: worker.id });
    const objects = f.runtime.mentalObjects.listForWorker(worker.id);
    const fact = objects.find((object) => object.data.schema === "speck-consolidation/v1");
    const pattern = objects.find((object) => object.data.schema === "speck-pattern/v1");
    assert.equal(result.status, "completed");
    assert.equal(fact?.kind, "fact");
    assert.equal(fact?.data.episodeCount, 3);
    assert.equal(pattern?.kind, "artifact");
    assert.equal(pattern?.data.occurrences, 3);
    assert.ok(objects.every((object) => object.data.embedding && typeof object.data.embedding === "object"));
    assert.equal(f.runtime.telemetry.snapshot().counters["model.calls"] ?? 0, beforeCalls);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("one weak observation cannot become semantic certainty and contradictions are explicit", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Maintain epistemic boundaries");
    await f.runtime.createMentalObject({ workerId: worker.id, kind: "observation", content: "server uses caddy", confidence: 0.2, memoryRoles: ["episodic"], actor: { kind: "external", source: "weak" } });
    await f.runtime.runBackgroundCognition({ workerId: worker.id });
    assert.equal(f.runtime.mentalObjects.listForWorker(worker.id).some((object) => object.data.schema === "speck-consolidation/v1"), false);
    for (let index = 0; index < 3; index += 1) {
      await f.runtime.createMentalObject({ workerId: worker.id, kind: "observation", content: "nginx", data: { consolidationKey: "server", semanticContent: "nginx" }, confidence: 1, memoryRoles: ["episodic"], actor: { kind: "external", source: `nginx-${index}` } });
    }
    await f.runtime.runBackgroundCognition({ workerId: worker.id });
    for (let index = 0; index < 3; index += 1) {
      await f.runtime.createMentalObject({ workerId: worker.id, kind: "observation", content: "caddy", data: { consolidationKey: "server", semanticContent: "caddy" }, confidence: 1, memoryRoles: ["episodic"], actor: { kind: "external", source: `caddy-${index}` } });
    }
    await f.runtime.runBackgroundCognition({ workerId: worker.id });
    const contradiction = f.runtime.mentalObjects.listForWorker(worker.id).find((object) => object.data.schema === "speck-consolidation-contradiction/v1");
    assert.equal(contradiction?.kind, "error");
    assert.ok(contradiction?.data.existingId);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("background review compiles eligible unambiguous procedures", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Compile queued competence");
    const definition: ProcedureDefinition = {
      schema: "speck-procedure/v1", trigger: { kind: "exact-normalized", value: "health check" },
      preconditions: [], steps: [{ kind: "answer", text: "healthy" }], validators: [], failureRoutes: ["reasoning-fallback"],
      status: "candidate", verifiedSuccesses: 3, creditedEpisodeIds: [], successCount: 0, failureCount: 0, utility: 0.5, executionHistory: []
    };
    const procedure = await f.runtime.createMentalObject({
      workerId: worker.id, kind: "procedure", content: "Procedure for: health check",
      data: { ...definition, signature: "health-check-v1" }, confidence: 1, memoryRoles: ["procedural"]
    });
    await f.runtime.runBackgroundCognition({ workerId: worker.id });
    assert.equal(f.runtime.mentalObjects.get(procedure.id)?.data.status, "compiled");
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("calibration windows and decayed associations receive bounded maintenance", async () => {
  const f = fixture({ metacognition: { calibrationWindow: 2 }, backgroundCognition: { associationPruneThreshold: 0.01 } });
  try {
    const worker = await f.runtime.createWorker("Maintain learned state");
    const left = await f.runtime.createMentalObject({ workerId: worker.id, kind: "fact", content: "left" });
    const right = await f.runtime.createMentalObject({ workerId: worker.id, kind: "fact", content: "right" });
    await f.runtime.reinforceAssociation({ workerId: worker.id, sourceId: left.id, targetId: right.id, at: new Date("2000-01-01T00:00:00.000Z") });
    const current = f.runtime.getWorker(worker.id)!;
    const samples = [0, 1, 2].map((index) => ({ reportedConfidence: 0.9, reward: index === 2 ? 1 : 0, bias: index === 2 ? -0.1 : 0.9, sourceObjectId: null, recordedAt: `2026-01-0${index + 1}T00:00:00.000Z` }));
    f.runtime.workers.update({ ...current, confidence: { ...current.confidence, calibration: { model: { processorId: "model", samples, bias: 99, meanAbsoluteError: 99, reliability: 0, updatedAt: "old" } } }, revision: current.revision + 1 }, current.revision);
    await f.runtime.runBackgroundCognition({ workerId: worker.id });
    const maintained = f.runtime.getWorker(worker.id)!;
    assert.equal(maintained.confidence.calibration?.model?.samples.length, 2);
    assert.ok((maintained.confidence.calibration?.model?.bias ?? 0) < 1);
    assert.equal(f.runtime.mentalObjects.get(left.id)?.associations.length, 0);
    assert.ok(f.runtime.listEvents(worker.id).some((event) => event.type === "background.maintenance"));
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("background cognition can be independently disabled", async () => {
  const f = fixture({ backgroundCognition: { enabled: false } });
  try {
    await f.runtime.createWorker("Ablate maintenance");
    const result = await f.runtime.runBackgroundCognition();
    assert.equal(result.status, "disabled");
    assert.equal(result.processed, 0);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});
