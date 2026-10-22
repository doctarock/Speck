// The reply a processed task gives is chosen by its status: a waiting task's
// question, not a result summary left from an earlier message of the same
// task (smoke-d, 2026-10-20: every reply after "12 + 12 = 24" repeated it).

import assert from "node:assert/strict";
import test from "node:test";
import { replyFor } from "../genesis-ui/presentation.js";
import { withFixture } from "./support/controller-fixture.js";

test("a waiting task replies with its question, not a stale result summary", async () => {
  await withFixture("direct", async (f) => {
    const set = (workerId: string, key: string, value: unknown) => f.runtime.setWorldState({ workerId: workerId as never, key, value, epistemicStatus: "observed", confidence: 1, actor: { kind: "runtime", source: "test" } });
    let worker = await f.runtime.createWorker("Work out the rule.");
    await set(worker.id, "genesis.resultSummary", "12 + 12 = 24");
    await set(worker.id, "genesis.questionForUser", "Ochre");
    worker = await f.runtime.transitionWorker(worker.id, "ready");
    worker = await f.runtime.transitionWorker(worker.id, "orienting");
    worker = await f.runtime.transitionWorker(worker.id, "executing");
    worker = await f.runtime.transitionWorker(worker.id, "waiting");
    assert.equal(replyFor(f.runtime.getWorker(worker.id)!), "Ochre");
    worker = await f.runtime.transitionWorker(worker.id, "ready");
    worker = await f.runtime.transitionWorker(worker.id, "orienting");
    worker = await f.runtime.transitionWorker(worker.id, "executing");
    worker = await f.runtime.transitionWorker(worker.id, "completed");
    assert.equal(replyFor(f.runtime.getWorker(worker.id)!), "12 + 12 = 24", "a completed task replies with its result");
  });
});
