import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import {
  applyCrowdingNormalization, attentionScore, decideAdmissionWithHysteresis, rankCandidates,
  type CoalitionCandidate
} from "../context/competition.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { MentalObject } from "../types/model.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase3-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, ...overrides });
  return { directory, databasePath, runtime };
}

function setActivation(runtime: SpeckRuntime, object: MentalObject, total: number): MentalObject {
  const updated = { ...object, activation: { ...object.activation, total } };
  runtime.mentalObjects.update(updated);
  return updated;
}

test("ACA attention scoring, crowding, ranking, and hysteresis are preserved", () => {
  assert.equal(attentionScore(1, 0.5), 1.5);
  const candidates: CoalitionCandidate[] = [
    { id: "mo_b" as CoalitionCandidate["id"], score: 5, rawScore: 5 },
    { id: "mo_a" as CoalitionCandidate["id"], score: 4, rawScore: 4 }
  ];
  const crowded = applyCrowdingNormalization(candidates, 0.1);
  assert.ok(Math.abs(crowded[0]!.score - 5 / 1.4) < 1e-9);
  assert.ok(Math.abs(crowded[1]!.score - 4 / 1.5) < 1e-9);
  assert.deepEqual(applyCrowdingNormalization(candidates, 0), candidates);
  assert.deepEqual(rankCandidates([
    { ...candidates[0]!, score: 1 }, { ...candidates[1]!, score: 1 }
  ]).map((candidate) => candidate.id), ["mo_a", "mo_b"]);

  const sustained = { id: "mo_old" as CoalitionCandidate["id"], score: 0.3, rawScore: 0.3 };
  const newcomer = { id: "mo_new" as CoalitionCandidate["id"], score: 0.3, rawScore: 0.3 };
  assert.deepEqual(
    decideAdmissionWithHysteresis([sustained, newcomer], new Set([sustained.id]), 4, 0.5).map((candidate) => candidate.id),
    [sustained.id]
  );
});

test("competition persists bounded Working Memory and learns ACA broadcast edges", async () => {
  const f = fixture({
    workingMemoryCapacity: 2,
    contextEngine: {
      crowdingEnabled: false, ignitionThreshold: -100,
      importanceWeight: 0, confidenceWeight: 0
    }
  });
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Select the strongest context");
    const strongest = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "strongest" }), 3);
    const second = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "semantic", content: "second" }), 2);
    const loser = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "loser" }), 1);
    const result = await f.runtime.competeForWorkingMemory({ workerId: worker.id });
    assert.deepEqual(result.worker.workingMemory, [strongest.id, second.id]);
    assert.deepEqual(result.newlyAdmitted, [strongest.id, second.id]);
    assert.deepEqual(result.released, []);
    const persistedStrongest = f.runtime.mentalObjects.get(strongest.id)!;
    const persistedSecond = f.runtime.mentalObjects.get(second.id)!;
    assert.equal(persistedStrongest.workspace.inWorkingMemory, true);
    assert.equal(persistedStrongest.workspace.broadcastCount, 1);
    assert.ok(persistedStrongest.associations.some((edge) => edge.targetId === second.id && edge.kind === "associative"));
    assert.ok(persistedSecond.associations.some((edge) => edge.targetId === strongest.id && edge.kind === "associative"));
    assert.ok(persistedStrongest.associations.some((edge) => edge.targetId === loser.id && edge.kind === "inhibitory"));

    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    await restored.initialize();
    assert.deepEqual(restored.getWorker(worker.id)?.workingMemory, [strongest.id, second.id]);
    assert.equal(restored.mentalObjects.get(strongest.id)?.workspace.broadcastCount, 1);
  } finally {
    restored?.close();
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("hysteresis sustains an existing focus until a newcomer clears ignition", async () => {
  const f = fixture({
    workingMemoryCapacity: 1,
    contextEngine: {
      crowdingEnabled: false, attentionThreshold: -10, ignitionThreshold: 0.5,
      importanceWeight: 0, confidenceWeight: 0,
      coalescenceLearningEnabled: false, lateralInhibitionLearningEnabled: false
    }
  });
  try {
    const worker = await f.runtime.createWorker("Avoid attentional thrashing");
    const current = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "current focus" }), 0.3);
    const weakNewcomer = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "weak newcomer" }), 0.4);
    await f.runtime.admitToWorkingMemory(worker.id, current.id);
    const sustained = await f.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: [weakNewcomer.id] });
    assert.deepEqual(sustained.worker.workingMemory, [current.id]);

    const strongNewcomer = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "strong newcomer" }), 2);
    const displaced = await f.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: [strongNewcomer.id] });
    assert.deepEqual(displaced.worker.workingMemory, [strongNewcomer.id]);
    assert.deepEqual(displaced.released, [current.id]);
    assert.equal(f.runtime.mentalObjects.get(current.id)?.workspace.inWorkingMemory, false);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("candidate ranking and hysteresis can be independently bypassed", async () => {
  const f = fixture({
    workingMemoryCapacity: 1,
    contextEngine: {
      candidateRankingEnabled: false,
      crowdingEnabled: false,
      hysteresisEnabled: false,
      attentionThreshold: -10,
      ignitionThreshold: 100,
      coalescenceLearningEnabled: false,
      lateralInhibitionLearningEnabled: false
    }
  });
  try {
    const worker = await f.runtime.createWorker("Bypass ranking extensions");
    const current = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "current" }), 0.3);
    const newcomer = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "newcomer", importance: 1 }), 0.4);
    await f.runtime.admitToWorkingMemory(worker.id, current.id);
    const result = await f.runtime.competeForWorkingMemory({
      workerId: worker.id,
      candidateIds: [newcomer.id],
      signals: { [newcomer.id]: { taskRelevance: 100 } }
    });
    assert.deepEqual(result.worker.workingMemory, [newcomer.id]);
    assert.equal(result.candidates[0]?.score, 0.4);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("context packets bundle related objects and never exceed their token budget", async () => {
  const f = fixture({
    workingMemoryCapacity: 2,
    contextEngine: {
      crowdingEnabled: false, ignitionThreshold: -100,
      importanceWeight: 0, confidenceWeight: 0
    }
  });
  try {
    const worker = await f.runtime.createWorker("Repair the TLS configuration", ["Do not restart before validation"]);
    const hypothesis = setActivation(f.runtime, await f.runtime.proposeHypothesis({ workerId: worker.id, content: "certificate mismatch", confidence: 0.8 }), 3);
    const evidence = setActivation(f.runtime, await f.runtime.recordEvidence({
      workerId: worker.id, content: "nginx reports the wrong certificate path", source: "nginx -t", supports: [hypothesis.id]
    }), 2);
    await f.runtime.setWorldState({ workerId: worker.id, key: "nginx.configValid", value: false, epistemicStatus: "observed" });
    await f.runtime.createCommitment({ workerId: worker.id, content: "Validate configuration before restart", priority: "high" });
    await f.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: [hypothesis.id, evidence.id] });

    const packet = f.runtime.buildContext({
      workerId: worker.id,
      expectedOutputContract: "Return one next action and its verification condition.",
      tokenBudget: 160
    });
    assert.ok(packet.estimatedTokens <= 160);
    assert.match(packet.text, /OBJECTIVE/);
    assert.match(packet.text, /EXPECTED OUTPUT CONTRACT/);
    assert.ok(packet.coalitions.some((coalition) => coalition.memberIds.length === 2));
    assert.ok(packet.includedObjectIds.includes(hypothesis.id));
    assert.ok(packet.includedObjectIds.includes(evidence.id));
    assert.equal(packet.text.includes("raw chat history"), false);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Phase 3 learning, bundling, and context construction are ablatable", async () => {
  const f = fixture({
    workingMemoryCapacity: 2,
    contextEngine: {
      crowdingEnabled: false, ignitionThreshold: -100,
      importanceWeight: 0, confidenceWeight: 0,
      coalescenceLearningEnabled: false,
      lateralInhibitionLearningEnabled: false,
      coalitionBundlingEnabled: false
    }
  });
  const disabled = fixture({ contextEngine: { contextBuilderEnabled: false } });
  try {
    const worker = await f.runtime.createWorker("Ablate context mechanisms");
    const first = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "first" }), 2);
    const second = setActivation(f.runtime, await f.runtime.recordMemory({ workerId: worker.id, type: "semantic", content: "second" }), 1);
    await f.runtime.competeForWorkingMemory({ workerId: worker.id });
    assert.deepEqual(f.runtime.mentalObjects.get(first.id)?.associations, []);
    assert.deepEqual(f.runtime.mentalObjects.get(second.id)?.associations, []);
    assert.equal(f.runtime.buildContext({ workerId: worker.id }).coalitions.length, 2);

    const disabledWorker = await disabled.runtime.createWorker("No context builder");
    assert.throws(() => disabled.runtime.buildContext({ workerId: disabledWorker.id }), /disabled/);
  } finally {
    f.runtime.close();
    disabled.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
    fs.rmSync(disabled.directory, { recursive: true, force: true });
  }
});

test("Phase 3 defaults retain ACA calibrated thresholds and capacity", () => {
  const config = loadConfig();
  assert.equal(config.workingMemoryCapacity, 4);
  assert.equal(config.contextEngine.attentionThreshold, -2);
  assert.equal(config.contextEngine.ignitionThreshold, -1.8);
  assert.equal(config.contextEngine.crowdingStrength, 0.05);
});
