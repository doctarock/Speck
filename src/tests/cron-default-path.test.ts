// Scheduled messages are answered on Speck's default path (2026-10-22: since
// the pipeline was archived, due jobs were queued as workers nothing ran).

import assert from "node:assert/strict";
import test from "node:test";
import { enqueueDueCronJobs, type CronAnswer } from "../genesis-ui/cron.js";
import type { GenesisCronJob, GenesisUiState } from "../genesis-ui/state.js";

const job = (id: string, nextRunAt: number): GenesisCronJob => ({
  id, name: id, every: "1h", everyMs: 3_600_000, message: `message for ${id}`, brainId: "", enabled: true,
  createdAt: 0, updatedAt: 0, nextRunAt, lastRunAt: null, lastStatus: "idle"
});

function uiState(jobs: GenesisCronJob[]): GenesisUiState {
  return { archivedWorkerIds: [], queuePaused: false, app: {}, toolApprovals: {}, memoryAdmission: {} as never, components: {}, cronJobs: jobs, cronEvents: [] };
}

test("a due job is answered and its reply recorded; a job not yet due is left; a failure is recorded", async () => {
  const state = uiState([job("due", 0), job("later", Date.now() + 60_000), job("broken", 0)]);
  const asked: string[] = [];
  const answer: CronAnswer = async (_runtime, _state, due) => {
    asked.push(due.message);
    if (due.id === "broken") throw new Error("model unavailable");
    return { reply: `reply to ${due.message}`, path: "plain" };
  };
  let saves = 0;
  await enqueueDueCronJobs({} as never, state, async () => { saves += 1; }, answer);
  assert.deepEqual(asked, ["message for due", "message for broken"]);
  const [due, later, broken] = state.cronJobs;
  assert.equal(due!.lastStatus, "completed");
  assert.ok(due!.nextRunAt > Date.now(), "the next run is scheduled");
  assert.equal(later!.lastStatus, "idle");
  assert.equal(broken!.lastStatus, "failed");
  assert.deepEqual(state.cronEvents.map((event) => [event.type, event.jobId]), [["cron.completed", "due"], ["cron.failed", "broken"]]);
  assert.equal(state.cronEvents[0]!.reply, "reply to message for due");
  assert.ok(saves >= 2, "saved before answering and after");
});
