import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InvalidTransitionError } from "../errors.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-test-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath });
  return {
    runtime, databasePath,
    cleanup() {
      runtime.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("a worker is created and persisted without an LLM", async () => {
  const f = fixture();
  try {
    await f.runtime.initialize();
    const worker = await f.runtime.createWorker("Prove persistence", ["offline"]);
    assert.equal(worker.status, "created");
    assert.deepEqual(f.runtime.getWorker(worker.id), worker);
    assert.equal(f.runtime.config.databasePath, f.databasePath);
  } finally { f.cleanup(); }
});

test("restart restores worker state exactly", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    await f.runtime.initialize();
    const created = await f.runtime.createWorker("Survive restart");
    const expected = await f.runtime.transitionWorker(created.id, "ready");
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    await restored.initialize();
    assert.deepEqual(restored.getWorker(created.id), expected);
  } finally {
    restored?.close();
    f.cleanup();
  }
});

test("events retain global ordering and provenance", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Trace events", [], { kind: "user", source: "test", actorId: "tester" });
    await f.runtime.transitionWorker(worker.id, "ready", { kind: "runtime", source: "test-state-machine" }, "accepted");
    const events = f.runtime.listEvents(worker.id);
    assert.deepEqual(events.map((event) => event.type), ["worker.created", "worker.transitioned"]);
    assert.ok(events[0]!.sequence < events[1]!.sequence);
    assert.equal(events[0]!.provenance.actorId, "tester");
    assert.equal(events[0]!.provenance.eventId, events[0]!.id);
    assert.equal(events[1]!.provenance.source, "test-state-machine");
  } finally { f.cleanup(); }
});

test("multiple workers remain isolated", async () => {
  const f = fixture();
  try {
    const a = await f.runtime.createWorker("A");
    const b = await f.runtime.createWorker("B");
    await f.runtime.createMentalObject({ workerId: a.id, kind: "observation", content: "Only A sees this" });
    assert.equal(f.runtime.mentalObjects.listForWorker(a.id).length, 1);
    assert.equal(f.runtime.mentalObjects.listForWorker(b.id).length, 0);
    assert.deepEqual(f.runtime.listEvents(b.id).map((event) => event.workerId), [b.id]);
  } finally { f.cleanup(); }
});

test("invalid state transitions are rejected without mutation", async () => {
  const f = fixture();
  try {
    const worker = await f.runtime.createWorker("Reject invalid transitions");
    await assert.rejects(() => f.runtime.transitionWorker(worker.id, "completed"), InvalidTransitionError);
    assert.deepEqual(f.runtime.getWorker(worker.id), worker);
    assert.equal(f.runtime.listEvents(worker.id).length, 1);
  } finally { f.cleanup(); }
});

test("an interrupted worker is recovered on restart", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const created = await f.runtime.createWorker("Recover me");
    await f.runtime.transitionWorker(created.id, "ready");
    const executing = await f.runtime.transitionWorker(created.id, "executing");
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    const { recovered } = await restored.initialize();
    assert.equal(recovered.length, 1);
    const worker = restored.getWorker(created.id)!;
    assert.equal(worker.status, "ready");
    assert.equal(worker.recovery.interruptedFrom, executing.status);
    assert.equal(restored.listEvents(created.id).at(-1)?.type, "worker.recovered");
  } finally {
    restored?.close();
    f.cleanup();
  }
});

test("event handlers observe persisted event order", async () => {
  const f = fixture();
  try {
    const seen: number[] = [];
    f.runtime.eventBus.on("*", (event) => { seen.push(event.sequence); });
    const worker = await f.runtime.createWorker("Ordered dispatch");
    await f.runtime.transitionWorker(worker.id, "ready");
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
    assert.equal(seen.length, 2);
  } finally { f.cleanup(); }
});
