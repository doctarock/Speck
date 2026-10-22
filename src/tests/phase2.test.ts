import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeBaseLevel, recordReference } from "../memory/activation.js";
import { effectiveStrength, reinforceEdge } from "../memory/edges.js";
import { ActivationGraph } from "../memory/graph.js";
import { recall, spreadActivationMultiHop } from "../memory/recall.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { MentalObject } from "../types/model.js";
import { createMentalObjectId } from "../types/ids.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase2-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, ...overrides });
  return { directory, databasePath, runtime };
}

function object(content: string, createdAt: string): MentalObject {
  return {
    id: createMentalObjectId(), workerId: null, kind: "observation", content, data: {},
    confidence: 0.5, importance: 0.5, memoryRoles: ["episodic"],
    activation: { baseLevel: 0, spreading: 0, noise: 0, suppression: 0, total: 0, decay: 0.5, references: [createdAt], lastComputedAt: createdAt },
    associations: [], provenance: { kind: "runtime", source: "test", actorId: null, eventId: null, correlationId: null, recordedAt: createdAt },
    workspace: { attentionScore: null, inWorkingMemory: false, broadcastCount: 0, lastBroadcastAt: null },
    status: "active", createdAt, lastAccessedAt: createdAt
  };
}

test("ACA base-level activation preserves recency, frequency, and bounded reinforcement", () => {
  const now = new Date("2026-01-01T00:00:10.000Z");
  const recent = ["2026-01-01T00:00:09.000Z"];
  const stale = ["2026-01-01T00:00:01.000Z"];
  assert.ok(computeBaseLevel(recent, 0.5, now) > computeBaseLevel(stale, 0.5, now));
  assert.ok(computeBaseLevel([...stale, ...recent], 0.5, now) > computeBaseLevel(recent, 0.5, now));
  let state = object("bounded", stale[0]!).activation;
  for (let index = 0; index < 80; index += 1) state = recordReference(state, new Date(now.getTime() + index), 64);
  assert.equal(state.references.length, 64);
});

test("ACA edge reinforcement clamps and edge strength decays lazily", () => {
  const target = createMentalObjectId();
  const at = new Date("2026-01-01T00:00:00.000Z");
  let edges = reinforceEdge([], target, "associative", at, 0.6, 1);
  edges = reinforceEdge(edges, target, "associative", at, 0.6, 1);
  assert.equal(edges[0]?.strength, 1);
  assert.ok(effectiveStrength(edges[0]!, new Date(at.getTime() + 1_000), 0.001) < 1);
  assert.equal(effectiveStrength(edges[0]!, new Date(at.getTime() + 1_000), 0), 1);
});

test("ACA multi-hop spread is fan-normalized and inhibition does not propagate", () => {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const source = object("source", at.toISOString());
  const intermediate = object("intermediate", at.toISOString());
  const dormant = object("dormant", at.toISOString());
  source.associations = reinforceEdge([], intermediate.id, "associative", at, 1, 1);
  intermediate.associations = reinforceEdge([], dormant.id, "associative", at, 1, 1);
  const graph = new ActivationGraph([source, intermediate, dormant]);
  const spread = spreadActivationMultiHop(graph, [source.id], 2, 0, at);
  assert.equal(spread.get(intermediate.id), 1);
  assert.equal(spread.get(dormant.id), 1);

  const wideTarget = object("wide target", at.toISOString());
  const decoyA = object("decoy a", at.toISOString());
  const decoyB = object("decoy b", at.toISOString());
  const wideSource = object("wide source", at.toISOString());
  wideSource.associations = [wideTarget, decoyA, decoyB].flatMap((target) =>
    reinforceEdge([], target.id, "associative", at, 0.9, 1)
  );
  const wideSpread = spreadActivationMultiHop(
    new ActivationGraph([wideSource, wideTarget, decoyA, decoyB]), [wideSource.id], 1, 0, at
  );
  assert.ok(Math.abs((wideSpread.get(wideTarget.id) ?? 0) - 0.3) < 1e-9);

  const inhibited = object("inhibited", at.toISOString());
  const downstream = object("downstream", at.toISOString());
  source.associations = reinforceEdge([], inhibited.id, "inhibitory", at, 0.8, 1);
  inhibited.associations = reinforceEdge([], downstream.id, "associative", at, 1, 1);
  const inhibitedSpread = spreadActivationMultiHop(new ActivationGraph([source, inhibited, downstream]), [source.id], 2, 0, at);
  assert.ok((inhibitedSpread.get(inhibited.id) ?? 0) < 0);
  assert.equal(inhibitedSpread.has(downstream.id), false);
  const inhibitionAblated = spreadActivationMultiHop(
    new ActivationGraph([source, inhibited, downstream]), [source.id], 2, 0, at, false
  );
  assert.equal(inhibitionAblated.has(inhibited.id), false);
  assert.equal(inhibitionAblated.has(downstream.id), false);
});

test("base activation, references, and associative edges are independently ablatable", async () => {
  const at = new Date("2026-01-01T00:00:00.000Z");
  const now = new Date("2026-01-01T00:01:40.000Z");
  const source = object("source", at.toISOString());
  const target = object("stale target", at.toISOString());
  source.associations = reinforceEdge([], target.id, "associative", at, 1, 1);
  const enabledGraph = new ActivationGraph([source, target]);
  assert.deepEqual(recall(enabledGraph, new Set([source.id]), new Set(), {
    maxHops: 1, edgeDecayRatePerMs: 0, retrievalThreshold: 0.5, maxNoise: 0
  }, now), []);
  const disabledSource = object("source", at.toISOString());
  const disabledTarget = object("stale target", at.toISOString());
  disabledSource.associations = reinforceEdge([], disabledTarget.id, "associative", at, 1, 1);
  const disabledGraph = new ActivationGraph([disabledSource, disabledTarget]);
  assert.deepEqual(recall(disabledGraph, new Set([disabledSource.id]), new Set(), {
    maxHops: 1, edgeDecayRatePerMs: 0, retrievalThreshold: 0.5, maxNoise: 0, baseLevelEnabled: false
  }, now), [disabledTarget.id]);

  const f = fixture({ memoryActivation: { referenceReinforcementEnabled: false, associativeEdgesEnabled: false } });
  try {
    const worker = await f.runtime.createWorker("Ablate reference and edges");
    const first = await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "first" });
    const second = await f.runtime.recordMemory({ workerId: worker.id, type: "semantic", content: "second" });
    const referenced = await f.runtime.reinforceMemoryReference(worker.id, first.id);
    assert.equal(referenced.activation.references.length, first.activation.references.length);
    const reinforced = await f.runtime.reinforceAssociation({ workerId: worker.id, sourceId: first.id, targetId: second.id });
    assert.deepEqual(reinforced.associations, []);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a dormant memory is recovered through a persisted two-hop association", async () => {
  const f = fixture({ memoryActivation: { hebbianIncrement: 1, edgeDecayRatePerMs: 0 } });
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Recover associated memory");
    const source = await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "current nginx failure" });
    const intermediate = await f.runtime.recordMemory({ workerId: worker.id, type: "semantic", content: "nginx uses a certificate" });
    const dormant = await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "certificate path was wrong last time" });
    f.runtime.mentalObjects.update({ ...dormant, status: "dormant" });
    await f.runtime.reinforceAssociation({ workerId: worker.id, sourceId: source.id, targetId: intermediate.id });
    await f.runtime.reinforceAssociation({ workerId: worker.id, sourceId: intermediate.id, targetId: dormant.id });
    await f.runtime.admitToWorkingMemory(worker.id, source.id);
    const future = new Date(Date.now() + 120_000);
    const result = await f.runtime.retrieveMemories({ workerId: worker.id, now: future });
    const recovered = result.candidates.find((candidate) => candidate.object.id === dormant.id);
    assert.ok(recovered, "the two-hop dormant memory should be among the recalled candidates");
    assert.ok(recovered.activation > Number.NEGATIVE_INFINITY);
    assert.ok(recovered.object.activation.spreading > 0);
    assert.equal(recovered.object.status, "dormant");

    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    await restored.initialize();
    assert.equal(restored.mentalObjects.get(source.id)?.associations[0]?.targetId, intermediate.id);
    assert.ok((restored.mentalObjects.get(dormant.id)?.activation.references.length ?? 0) >= 2);
  } finally {
    restored?.close();
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("spreading activation and domain anchors are independently ablatable", async () => {
  const disabled = fixture({ memoryActivation: { spreadingActivationEnabled: false } });
  const anchorsDisabled = fixture({ memoryActivation: { domainAnchorsEnabled: false } });
  try {
    const worker = await disabled.runtime.createWorker("Ablate spread");
    const source = await disabled.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "source" });
    const target = await disabled.runtime.recordMemory({ workerId: worker.id, type: "semantic", content: "target" });
    await disabled.runtime.reinforceAssociation({ workerId: worker.id, sourceId: source.id, targetId: target.id });
    await disabled.runtime.admitToWorkingMemory(worker.id, source.id);
    assert.equal((await disabled.runtime.retrieveMemories({ workerId: worker.id })).candidates.length, 0);

    const secondWorker = await anchorsDisabled.runtime.createWorker("Ablate anchors");
    const memory = await anchorsDisabled.runtime.recordMemory({ workerId: secondWorker.id, type: "semantic", content: "repository detail" });
    await assert.rejects(
      anchorsDisabled.runtime.linkMemoryToDomain({ workerId: secondWorker.id, objectId: memory.id, domain: "repository", key: "speck" }),
      /disabled/
    );
    await assert.rejects(
      anchorsDisabled.runtime.retrieveDomainMemories({ workerId: secondWorker.id, domain: "repository", key: "speck" }),
      /disabled/
    );
  } finally {
    disabled.runtime.close();
    anchorsDisabled.runtime.close();
    fs.rmSync(disabled.directory, { recursive: true, force: true });
    fs.rmSync(anchorsDisabled.directory, { recursive: true, force: true });
  }
});

test("generalized ACA memory clouds recall through domain-linked anchors", async () => {
  const f = fixture({ memoryActivation: { hebbianIncrement: 1, edgeDecayRatePerMs: 0, retrievalThreshold: -100 } });
  try {
    const worker = await f.runtime.createWorker("Use a repository memory cloud");
    const linked = await f.runtime.recordMemory({ workerId: worker.id, type: "episodic", content: "Speck build failed" });
    const related = await f.runtime.recordMemory({ workerId: worker.id, type: "semantic", content: "Run npm test from the Speck root" });
    await f.runtime.reinforceAssociation({ workerId: worker.id, sourceId: linked.id, targetId: related.id });
    const first = await f.runtime.linkMemoryToDomain({ workerId: worker.id, objectId: linked.id, domain: "repository", key: "speck" });
    const second = await f.runtime.linkMemoryToDomain({ workerId: worker.id, objectId: linked.id, domain: "repository", key: "speck" });
    assert.equal(first.anchor.id, second.anchor.id);
    const recalled = await f.runtime.retrieveDomainMemories({ workerId: worker.id, domain: "repository", key: "speck" });
    assert.ok(recalled.candidates.some((candidate) => candidate.object.id === related.id));
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
