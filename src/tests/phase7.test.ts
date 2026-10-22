import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reviseHypothesis } from "../belief/revision.js";
import { loadConfig } from "../config.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import { createMentalObjectId } from "../types/ids.js";
import type { MentalObject } from "../types/model.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase7-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, ...overrides });
  return { directory, databasePath, runtime };
}

test("ACA confidence revision is bounded, reliability-weighted, and applies an evidence edge once", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Test confidence math");
    const hypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "cause A", confidence: 0.4 });
    const config = loadConfig().beliefRevision;
    const first = reviseHypothesis({
      hypothesis, evidenceId: hypothesis.id, relation: { hypothesisId: hypothesis.id, direction: "supports", strength: 0.5 },
      reliability: 0.5, source: "test", at: "2026-01-01T00:00:00.000Z", config
    });
    assert.equal(first.hypothesis.confidence, 0.45);
    assert.equal(first.revision?.delta, 0.05);
    const repeated = reviseHypothesis({
      hypothesis: first.hypothesis, evidenceId: hypothesis.id, relation: { hypothesisId: hypothesis.id, direction: "supports" },
      reliability: 1, source: "test", at: "2026-01-02T00:00:00.000Z", config
    });
    assert.equal(repeated.revision, null);
    assert.equal(repeated.hypothesis.confidence, 0.45);
    const ceiling = reviseHypothesis({
      hypothesis: { ...hypothesis, confidence: 0.95 }, evidenceId: createMentalObjectId(),
      relation: { hypothesisId: hypothesis.id, direction: "supports" }, reliability: 1,
      source: "test", at: "2026-01-03T00:00:00.000Z", config
    });
    const floor = reviseHypothesis({
      hypothesis: { ...hypothesis, confidence: 0.1 }, evidenceId: createMentalObjectId(),
      relation: { hypothesisId: hypothesis.id, direction: "contradicts" }, reliability: 1,
      source: "test", at: "2026-01-03T00:00:00.000Z", config
    });
    assert.equal(ceiling.hypothesis.confidence, 1);
    assert.equal(floor.hypothesis.confidence, 0.05);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("new evidence automatically changes durable hypothesis ranking", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Rank possible causes");
    const lower = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "certificate mismatch", confidence: 0.4 });
    const higher = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "firewall issue", confidence: 0.5 });
    assert.equal(f.runtime.rankHypotheses(worker.id)[0]?.id, higher.id);
    const evidence = await f.runtime.recordEvidence({
      workerId: worker.id, content: "certificate path differs", source: "nginx inspection",
      reliability: 1, supports: [lower.id], actor: { kind: "tool", source: "inspect_nginx" }
    });
    const ranked = f.runtime.rankHypotheses(worker.id);
    assert.equal(ranked[0]?.id, lower.id);
    assert.ok(Math.abs((ranked[0]?.confidence ?? 0) - 0.6) < 1e-9);
    assert.equal(ranked[0]?.data.status, "supported");
    assert.deepEqual(ranked[0]?.data.supportingEvidence, [evidence.id]);
    assert.equal(f.runtime.getWorker(worker.id)?.hypotheses[0], lower.id);
    assert.ok(evidence.associations.some((edge) => edge.targetId === lower.id && edge.kind === "supports"));
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("corroboration confirms beliefs and sustained independent contradiction demotes them", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Revise a belief");
    const hypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "upstream is down", confidence: 0.7 });
    await f.runtime.recordEvidence({ workerId: worker.id, content: "connection refused", source: "probe", reliability: 1, supports: [hypothesis.id] });
    assert.equal(f.runtime.mentalObjects.get(hypothesis.id)?.data.status, "confirmed");
    assert.ok(f.runtime.getWorker(worker.id)?.beliefs.includes(hypothesis.id));
    for (let index = 0; index < 4; index += 1) {
      await f.runtime.recordEvidence({
        workerId: worker.id, content: `successful upstream probe ${index}`, source: `probe-${index}`,
        reliability: 1, contradicts: [hypothesis.id]
      });
    }
    const revised = f.runtime.mentalObjects.get(hypothesis.id)!;
    assert.ok(Math.abs(revised.confidence - 0.1) < 1e-9);
    assert.equal(revised.data.status, "rejected");
    assert.equal(f.runtime.getWorker(worker.id)?.beliefs.includes(hypothesis.id), false);
    assert.equal((revised.data.revisionHistory as unknown[]).length, 5);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("model-authored evidence is never equivalent to tool evidence", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Respect evidence provenance");
    const modelHypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "model claim", confidence: 0.4 });
    const toolHypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "tool claim", confidence: 0.4 });
    const modelEvidence = await f.runtime.recordEvidence({
      workerId: worker.id, content: "the model thinks so", source: "reasoner", reliability: 1,
      supports: [modelHypothesis.id], actor: { kind: "model", source: "reasoner" }
    });
    const toolEvidence = await f.runtime.recordEvidence({
      workerId: worker.id, content: "the probe demonstrated it", source: "probe", reliability: 1,
      supports: [toolHypothesis.id], actor: { kind: "tool", source: "probe" }
    });
    assert.equal(modelEvidence.data.claimedReliability, 1);
    assert.equal(modelEvidence.data.reliability, 0.4);
    assert.equal(toolEvidence.data.reliability, 1);
    assert.ok(Math.abs((f.runtime.mentalObjects.get(modelHypothesis.id)?.confidence ?? 0) - 0.48) < 1e-9);
    assert.ok(Math.abs((f.runtime.mentalObjects.get(toolHypothesis.id)?.confidence ?? 0) - 0.6) < 1e-9);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("existing tool evidence can be related later without double-applying revision", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Attach observed evidence");
    const hypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "service healthy", confidence: 0.5 });
    const evidence = await f.runtime.recordEvidence({
      workerId: worker.id, content: "health returned 200", source: "tool:health", reliability: 0.9,
      actor: { kind: "tool", source: "health" }
    });
    const first = await f.runtime.reviseHypothesesFromEvidence({
      workerId: worker.id, evidenceId: evidence.id,
      relations: [{ hypothesisId: hypothesis.id, direction: "supports" }],
      actor: { kind: "model", source: "relation-proposer" }
    });
    const repeated = await f.runtime.reviseHypothesesFromEvidence({
      workerId: worker.id, evidenceId: evidence.id,
      relations: [{ hypothesisId: hypothesis.id, direction: "supports" }]
    });
    assert.equal(first.revisions.length, 1);
    assert.equal(repeated.revisions.length, 0);
    assert.equal(f.runtime.mentalObjects.get(hypothesis.id)?.confidence, 0.68);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("revision history, event provenance, beliefs, and ranking survive restart", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Persist belief revision");
    const hypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "config invalid", confidence: 0.8 });
    const evidence = await f.runtime.recordEvidence({
      workerId: worker.id, content: "validator failed", source: "nginx -t", reliability: 1,
      supports: [hypothesis.id], actor: { kind: "tool", source: "nginx_test", correlationId: "belief-cycle" }
    });
    const before = f.runtime.getCognitiveState(worker.id);
    const revisionEvent = f.runtime.listEvents(worker.id).find((event) => event.type === "belief.revised");
    assert.equal(revisionEvent?.correlationId, "belief-cycle");
    assert.equal((before.hypotheses[0] as MentalObject).data.revisionHistory instanceof Array, true);
    assert.ok(before.beliefs.some((belief) => belief?.id === hypothesis.id));
    assert.ok(before.evidence.some((entry) => entry?.id === evidence.id));
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    await restored.initialize();
    assert.deepEqual(restored.getCognitiveState(worker.id), before);
  } finally {
    restored?.close();
    if (f.runtime.database.connection.open) f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("belief revision is ablatable while evidence remains first-class", async () => {
  const f = fixture({ beliefRevision: { enabled: false } });
  try {
    const worker = await f.runtime.createWorker("Ablate revision");
    const hypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "unchanged", confidence: 0.5 });
    const evidence = await f.runtime.recordEvidence({
      workerId: worker.id, content: "support", source: "test", reliability: 1, supports: [hypothesis.id]
    });
    const unchanged = f.runtime.mentalObjects.get(hypothesis.id)!;
    assert.equal(unchanged.confidence, 0.5);
    assert.equal(unchanged.data.status, "proposed");
    assert.deepEqual(evidence.data.supports, [hypothesis.id]);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("conflicting evidence relations are rejected without partial mutation", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Reject contradictory bookkeeping");
    const hypothesis = await f.runtime.proposeHypothesis({ workerId: worker.id, content: "one claim" });
    await assert.rejects(() => f.runtime.recordEvidence({
      workerId: worker.id, content: "ambiguous", source: "test",
      supports: [hypothesis.id], contradicts: [hypothesis.id]
    }), /both support and contradict/);
    assert.equal(f.runtime.getWorker(worker.id)?.evidence.length, 0);
    assert.equal(f.runtime.mentalObjects.get(hypothesis.id)?.confidence, 0.5);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
