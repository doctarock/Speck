import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

function fixture(workingMemoryCapacity = 7) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase1-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, workingMemoryCapacity });
  return { directory, databasePath, runtime };
}

test("persistent cognition survives multiple cycles and restart without chat history", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Diagnose a service");
    const episode = await f.runtime.recordMemory({
      workerId: worker.id, type: "episodic", content: "Health check returned HTTP 500"
    });
    await f.runtime.recordMemory({
      workerId: worker.id, type: "semantic", content: "The service uses nginx"
    });
    await f.runtime.admitToWorkingMemory(worker.id, episode.id);
    await f.runtime.createCommitment({ workerId: worker.id, content: "Preserve the current config", priority: "high" });
    await f.runtime.setWorldState({
      workerId: worker.id, key: "service.health", value: 500, epistemicStatus: "observed"
    });
    const hypothesis = await f.runtime.proposeHypothesis({
      workerId: worker.id, content: "The upstream process is unavailable", confidence: 0.4
    });
    await f.runtime.recordEvidence({
      workerId: worker.id, content: "nginx reports connection refused", source: "error-log",
      reliability: 0.95, supports: [hypothesis.id]
    });
    await f.runtime.completeCycle(worker.id, { madeProgress: true });
    await f.runtime.completeCycle(worker.id, { madeProgress: false });
    const expected = f.runtime.getCognitiveState(worker.id);
    assert.equal(expected.worker.progress.cycle, 2);
    assert.equal(expected.episodicMemory.length, 1);
    assert.equal(expected.semanticMemory.length, 1);
    assert.equal(expected.commitments.length, 1);
    assert.equal(expected.evidence.length, 1);
    assert.equal(expected.hypotheses.length, 1);
    assert.equal(expected.worldState["service.health"]?.epistemicStatus, "observed");
    assert.doesNotMatch(JSON.stringify(expected), /transcript|chatHistory|messages/i);

    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    await restored.initialize();
    assert.deepEqual(restored.getCognitiveState(worker.id), expected);
  } finally {
    restored?.close();
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("working memory is bounded and removes the evicted working role", async () => {
  const f = fixture(2);
  try {
    const worker = await f.runtime.createWorker("Bound attention");
    const memories = [];
    for (const content of ["one", "two", "three"]) {
      memories.push(await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content }));
    }
    for (const memory of memories) await f.runtime.admitToWorkingMemory(worker.id, memory.id);
    const cognition = f.runtime.getCognitiveState(worker.id);
    assert.deepEqual(cognition.worker.workingMemory, [memories[1]!.id, memories[2]!.id]);
    assert.equal(f.runtime.mentalObjects.get(memories[0]!.id)?.memoryRoles.includes("working"), false);
    assert.equal(f.runtime.mentalObjects.get(memories[2]!.id)?.memoryRoles.includes("working"), true);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("observed, inferred, assumed, and unknown world state remain distinct", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Track epistemic state");
    for (const epistemicStatus of ["observed", "inferred", "assumed", "unknown"] as const) {
      await f.runtime.setWorldState({ workerId: worker.id, key: epistemicStatus, value: true, epistemicStatus });
    }
    const world = f.runtime.getWorker(worker.id)!.worldState;
    assert.deepEqual(Object.values(world).map((entry) => entry.epistemicStatus), ["observed", "inferred", "assumed", "unknown"]);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("commitment lifecycle is explicit and evidence remains separate from hypotheses", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Keep concepts separate");
    const commitment = await f.runtime.createCommitment({ workerId: worker.id, content: "Verify after mutation" });
    const updated = await f.runtime.updateCommitment(worker.id, commitment.id, "completed");
    const hypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "Configuration is invalid" });
    const evidence = await f.runtime.recordEvidence({
      workerId: worker.id, content: "nginx -t failed", source: "tool", supports: [hypothesis.id]
    });
    const cognition = f.runtime.getCognitiveState(worker.id);
    assert.equal(updated.data.status, "completed");
    assert.equal(cognition.hypotheses[0]?.kind, "hypothesis");
    assert.equal(cognition.evidence[0]?.kind, "evidence");
    assert.notEqual(evidence.id, hypothesis.id);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("legacy Mental Objects hydrate safely through the Phase 3 migration", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Migrate state");
    const memory = await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "legacy object" });
    f.runtime.close();

    const raw = new Database(f.databasePath);
    const row = raw.prepare("SELECT object_json FROM mental_objects WHERE id = ?").get(memory.id) as { object_json: string };
    const legacy = JSON.parse(row.object_json) as Record<string, unknown>;
    delete legacy.memoryRoles;
    delete legacy.associations;
    delete legacy.workspace;
    const legacyActivation = legacy.activation as Record<string, unknown>;
    delete legacyActivation.noise;
    raw.prepare("UPDATE mental_objects SET object_json = ? WHERE id = ?").run(JSON.stringify(legacy), memory.id);
    raw.pragma("user_version = 1");
    raw.close();

    restored = new SpeckRuntime({ databasePath: f.databasePath });
    await restored.initialize();
    assert.deepEqual(restored.mentalObjects.get(memory.id)?.memoryRoles, []);
    assert.deepEqual(restored.mentalObjects.get(memory.id)?.associations, []);
    assert.equal(restored.mentalObjects.get(memory.id)?.activation.noise, 0);
    assert.deepEqual(restored.mentalObjects.get(memory.id)?.workspace, {
      attentionScore: null, inWorkingMemory: false, broadcastCount: 0, lastBroadcastAt: null
    });
    assert.equal(restored.database.connection.pragma("user_version", { simple: true }), 5);
  } finally {
    restored?.close();
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
