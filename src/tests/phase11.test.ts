import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

function fixture(overrides: ConstructorParameters<typeof SpeckRuntime>[0] = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase11-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, ...overrides });
  return { directory, databasePath, runtime };
}

const tasks = [
  { id: "code", objective: "Inspect implementation", dependencies: [], priority: 80, completionCriteria: ["findings supplied"], constraints: [] },
  { id: "tests", objective: "Inspect tests", dependencies: [], priority: 70, completionCriteria: ["coverage supplied"], constraints: [] },
  { id: "synthesis", objective: "Synthesize findings", dependencies: ["code", "tests"], priority: 90, completionCriteria: ["summary supplied"], constraints: [] }
];

test("a planner decomposes one objective into isolated dependency-aware Workers", async () => {
  const f = fixture();
  try {
    const planner = await f.runtime.createWorker("Review repository");
    const created = await f.runtime.createParallelPlan({ plannerWorkerId: planner.id, subtasks: tasks });
    assert.equal(created.workers.length, 3);
    assert.deepEqual(created.workers.map((worker) => worker.status), ["ready", "ready", "waiting"]);
    assert.equal(new Set(created.workers.map((worker) => worker.id)).size, 3);
    assert.ok(created.workers.every((worker) => worker.coordination?.planId === created.plan.id));
    assert.ok(created.workers.every((worker) => worker.workingMemory !== planner.workingMemory));
    const plan = f.runtime.getParallelPlan(planner.id, created.plan.id).plan;
    assert.deepEqual(plan.subtasks.map((task) => task.status), ["ready", "ready", "blocked"]);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("planner rejects unknown and cyclic dependencies before creating any child", async () => {
  const f = fixture();
  try {
    const planner = await f.runtime.createWorker("Reject invalid plan");
    await assert.rejects(() => f.runtime.createParallelPlan({ plannerWorkerId: planner.id, subtasks: [
      { id: "a", objective: "A", dependencies: ["b"], priority: 1, completionCriteria: [], constraints: [] },
      { id: "b", objective: "B", dependencies: ["a"], priority: 1, completionCriteria: [], constraints: [] }
    ] }), /cycle/);
    assert.equal(f.runtime.listWorkers().length, 1);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("typed worker messages are recipient-owned and carry worker provenance", async () => {
  const f = fixture();
  try {
    const planner = await f.runtime.createWorker("Coordinate review");
    const { plan, workers } = await f.runtime.createParallelPlan({ plannerWorkerId: planner.id, subtasks: tasks.slice(0, 2) });
    const message = await f.runtime.sendWorkerMessage({
      senderWorkerId: workers[0]!.id, recipientWorkerId: workers[1]!.id, planId: plan.id,
      type: "request-evidence", payload: { question: "Which paths lack coverage?" }
    });
    assert.equal(message.workerId, workers[1]!.id);
    assert.equal(message.provenance.kind, "worker");
    assert.equal(message.provenance.source, workers[0]!.id);
    assert.equal(f.runtime.getCognitiveState(workers[0]!.id).inbox.length, 0);
    assert.equal(f.runtime.getCognitiveState(workers[1]!.id).inbox.length, 1);
    assert.match(f.runtime.buildContext({ workerId: workers[1]!.id }).text, /WORKER INBOX/);
    assert.match(f.runtime.buildContext({ workerId: workers[1]!.id }).text, /Which paths lack coverage/);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("shared evidence is copied with provenance instead of sharing mutable state", async () => {
  const f = fixture();
  try {
    const planner = await f.runtime.createWorker("Coordinate evidence");
    const { plan, workers } = await f.runtime.createParallelPlan({ plannerWorkerId: planner.id, subtasks: tasks.slice(0, 2) });
    const original = await f.runtime.recordEvidence({ workerId: workers[0]!.id, content: "module has no retry test", source: "test inspection", reliability: 0.9 });
    const copy = await f.runtime.shareEvidence({ sourceWorkerId: workers[0]!.id, targetWorkerId: workers[1]!.id, planId: plan.id, evidenceId: original.id });
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.workerId, workers[1]!.id);
    assert.equal(copy.data.sourceEvidenceId, original.id);
    assert.equal(copy.data.sourceWorkerId, workers[0]!.id);
    assert.ok(f.runtime.getWorker(workers[1]!.id)!.evidence.includes(copy.id));
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("structured reports copy evidence to the planner and unlock dependencies", async () => {
  const f = fixture();
  try {
    const planner = await f.runtime.createWorker("Review repository");
    const { plan, workers } = await f.runtime.createParallelPlan({ plannerWorkerId: planner.id, subtasks: tasks });
    const codeEvidence = await f.runtime.recordEvidence({ workerId: workers[0]!.id, content: "implementation finding", source: "inspection", reliability: 1 });
    await f.runtime.reportSubtask({ workerId: workers[0]!.id, planId: plan.id, subtaskId: "code", status: "completed", summary: "code reviewed", evidenceIds: [codeEvidence.id] });
    assert.equal(f.runtime.getWorker(workers[2]!.id)!.status, "waiting");
    const testsEvidence = await f.runtime.recordEvidence({ workerId: workers[1]!.id, content: "test finding", source: "inspection", reliability: 1 });
    const report = await f.runtime.reportSubtask({ workerId: workers[1]!.id, planId: plan.id, subtaskId: "tests", status: "completed", summary: "tests reviewed", evidenceIds: [testsEvidence.id] });
    assert.deepEqual(report.unblockedWorkerIds, [workers[2]!.id]);
    assert.equal(f.runtime.getWorker(workers[2]!.id)!.status, "ready");
    assert.equal(f.runtime.getWorker(planner.id)!.evidence.length, 2);
    assert.ok(report.sharedEvidence.every((entry) => entry.workerId === planner.id));
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("aggregation fails closed until all subtasks resolve then returns structured results", async () => {
  const f = fixture();
  try {
    const planner = await f.runtime.createWorker("Parallel inspection");
    const independent = tasks.slice(0, 2);
    const { plan, workers } = await f.runtime.createParallelPlan({ plannerWorkerId: planner.id, subtasks: independent });
    await assert.rejects(() => f.runtime.aggregateParallelPlan({ plannerWorkerId: planner.id, planId: plan.id }), /unresolved/);
    await f.runtime.reportSubtask({ workerId: workers[0]!.id, planId: plan.id, subtaskId: "code", status: "completed", summary: "implementation clean" });
    await f.runtime.reportSubtask({ workerId: workers[1]!.id, planId: plan.id, subtaskId: "tests", status: "completed", summary: "tests clean" });
    const aggregated = await f.runtime.aggregateParallelPlan({ plannerWorkerId: planner.id, planId: plan.id });
    assert.equal(aggregated.result.successful, true);
    assert.equal(aggregated.result.subtaskResults.length, 2);
    assert.match(aggregated.artifact.content, /code:completed/);
    assert.equal(f.runtime.getParallelPlan(planner.id, plan.id).plan.status, "completed");
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("plans, assignments, messages, and aggregation survive restart", async () => {
  const f = fixture();
  let restored: SpeckRuntime | undefined;
  try {
    const planner = await f.runtime.createWorker("Persistent parallel work");
    const one = [tasks[0]!];
    const { plan, workers } = await f.runtime.createParallelPlan({ plannerWorkerId: planner.id, subtasks: one });
    await f.runtime.sendWorkerMessage({ senderWorkerId: planner.id, recipientWorkerId: workers[0]!.id, planId: plan.id, type: "request-analysis" });
    await f.runtime.reportSubtask({ workerId: workers[0]!.id, planId: plan.id, subtaskId: "code", status: "completed", summary: "durable result" });
    await f.runtime.aggregateParallelPlan({ plannerWorkerId: planner.id, planId: plan.id });
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    assert.equal(restored.getParallelPlan(planner.id, plan.id).plan.status, "completed");
    assert.equal(restored.getWorker(workers[0]!.id)?.coordination?.subtaskId, "code");
    assert.equal(restored.getCognitiveState(workers[0]!.id).inbox.length, 1);
    assert.equal(restored.listEvents(planner.id).filter((event) => event.type === "plan.aggregated").length, 1);
  } finally { restored?.close(); f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});
