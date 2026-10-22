// Scheduled messages: their routes, and enqueueing the ones that are due.

import { type Express } from "express";
import type { SpeckRuntime } from "../runtime/speck-runtime.js";

import { errorMessage } from "./presentation.js";
import path from "node:path";
import { respond } from "../speck/respond.js";
import { defaultPathDependencies } from "../speck/configure.js";
import { SessionStore } from "../speck/session.js";
import { admittedComponents } from "../speck/components/index.js";
import { GenesisUiState, GenesisCronJob } from "./state.js";

export function registerCronRoutes(app: Express, runtime: SpeckRuntime, state: GenesisUiState, saveState: () => Promise<void>) {
  app.get("/api/cron/list", (_req, res) => res.json({ ok: true, jobs: state.cronJobs }));
  app.post("/api/cron/add", async (req, res) => {
    try {
      const every = String(req.body?.every ?? "").trim();
      const everyMs = parseDuration(every);
      const now = Date.now();
      const job: GenesisCronJob = {
        id: `cron_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: String(req.body?.name ?? "Scheduled task").trim() || "Scheduled task",
        every, everyMs, message: String(req.body?.message ?? "").trim(),
        brainId: String(req.body?.brainId ?? "worker").trim() || "worker",
        enabled: true, createdAt: now, updatedAt: now, nextRunAt: now + everyMs, lastRunAt: null, lastStatus: "scheduled"
      };
      if (!job.message) throw new TypeError("message is required");
      state.cronJobs.push(job);
      await saveState();
      res.status(201).json({ ok: true, job, brain: { id: job.brainId, label: job.brainId }, staggered: { applied: false, nextRunAtMs: job.nextRunAt } });
    } catch (error) {
      res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });
  app.post("/api/cron/toggle", async (req, res) => {
    const job = state.cronJobs.find((candidate) => candidate.id === String(req.body?.id ?? req.body?.jobId ?? ""));
    if (!job) return res.status(404).json({ ok: false, error: "Scheduled job not found" });
    job.enabled = req.body?.enabled === undefined ? !job.enabled : req.body.enabled === true;
    job.updatedAt = Date.now();
    if (job.enabled) job.nextRunAt = Date.now() + job.everyMs;
    await saveState();
    return res.json({ ok: true, job, message: `Scheduled job ${job.enabled ? "enabled" : "disabled"}.` });
  });
  app.post("/api/cron/remove", async (req, res) => {
    const id = String(req.body?.id ?? req.body?.jobId ?? "");
    const index = state.cronJobs.findIndex((candidate) => candidate.id === id);
    if (index < 0) return res.status(404).json({ ok: false, error: "Scheduled job not found" });
    const [job] = state.cronJobs.splice(index, 1);
    await saveState();
    return res.json({ ok: true, job, message: "Scheduled job removed." });
  });
  app.get("/api/cron/events", (req, res) => {
    const sinceTs = Number(req.query.sinceTs ?? 0);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20)));
    res.json({ ok: true, events: state.cronEvents.filter((event) => Number(event.ts ?? 0) > sinceTs).slice(-limit) });
  });
}

// A due job's message is answered on Speck's default path, in a session of
// its own ("cron-<id>"), with the same component switches as chat; the reply
// is recorded with the job's events. (The worker queue it was once put on was
// archived on 2026-10-20 with the pipeline; until 2026-10-22 due jobs were
// queued and never answered.) The next run is set before answering, so a
// slow answer cannot run a job twice.
// How a due job's message is answered: Speck's default path (replaceable in tests).
export type CronAnswer = (runtime: SpeckRuntime, state: GenesisUiState, job: GenesisCronJob) => Promise<{ reply: string; path: string }>;

export const answerOnDefaultPath: CronAnswer = async (runtime, state, job) => {
  const sessions = new SessionStore(path.join(path.dirname(runtime.config.databasePath), "sessions"));
  const session = sessions.load(`cron-${job.id}`);
  const answered = await respond(session, job.message, { ...defaultPathDependencies(runtime.config, runtime.modelRegistry, runtime), components: admittedComponents(state.components) });
  sessions.save(session);
  return answered;
};

export async function enqueueDueCronJobs(runtime: SpeckRuntime, state: GenesisUiState, saveState: () => Promise<void>, answer: CronAnswer = answerOnDefaultPath) {
  const due = state.cronJobs.filter((candidate) => candidate.enabled && candidate.nextRunAt <= Date.now());
  if (!due.length) return;
  for (const job of due) {
    const started = Date.now();
    job.lastRunAt = started;
    job.lastStatus = "running";
    job.nextRunAt = started + job.everyMs;
    job.updatedAt = started;
  }
  await saveState();
  for (const job of due) {
    try {
      const answered = await answer(runtime, state, job);
      job.lastStatus = "completed";
      state.cronEvents.push({ ts: Date.now(), type: "cron.completed", jobId: job.id, reply: answered.reply, path: answered.path, job: { ...job } });
    } catch (error) {
      job.lastStatus = "failed";
      state.cronEvents.push({ ts: Date.now(), type: "cron.failed", jobId: job.id, error: error instanceof Error ? error.message : String(error), job: { ...job } });
    }
    job.updatedAt = Date.now();
  }
  if (state.cronEvents.length > 200) state.cronEvents = state.cronEvents.slice(-200);
  await saveState();
}

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(value);
  if (!match) throw new TypeError("every must use a duration such as 30s, 5m, 1h, or 1d");
  const amount = Number(match[1]);
  const scale = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  return Math.max(1_000, Math.floor(amount * scale));
}
