// Scheduled messages: their routes, and enqueueing the ones that are due.
import { errorMessage } from "./presentation.js";
import { createReadyWorker } from "./tasks.js";
export function registerCronRoutes(app, runtime, state, saveState) {
    app.get("/api/cron/list", (_req, res) => res.json({ ok: true, jobs: state.cronJobs }));
    app.post("/api/cron/add", async (req, res) => {
        try {
            const every = String(req.body?.every ?? "").trim();
            const everyMs = parseDuration(every);
            const now = Date.now();
            const job = {
                id: `cron_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                name: String(req.body?.name ?? "Scheduled task").trim() || "Scheduled task",
                every, everyMs, message: String(req.body?.message ?? "").trim(),
                brainId: String(req.body?.brainId ?? "worker").trim() || "worker",
                enabled: true, createdAt: now, updatedAt: now, nextRunAt: now + everyMs, lastRunAt: null, lastStatus: "scheduled"
            };
            if (!job.message)
                throw new TypeError("message is required");
            state.cronJobs.push(job);
            await saveState();
            res.status(201).json({ ok: true, job, brain: { id: job.brainId, label: job.brainId }, staggered: { applied: false, nextRunAtMs: job.nextRunAt } });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/cron/toggle", async (req, res) => {
        const job = state.cronJobs.find((candidate) => candidate.id === String(req.body?.id ?? req.body?.jobId ?? ""));
        if (!job)
            return res.status(404).json({ ok: false, error: "Scheduled job not found" });
        job.enabled = req.body?.enabled === undefined ? !job.enabled : req.body.enabled === true;
        job.updatedAt = Date.now();
        if (job.enabled)
            job.nextRunAt = Date.now() + job.everyMs;
        await saveState();
        return res.json({ ok: true, job, message: `Scheduled job ${job.enabled ? "enabled" : "disabled"}.` });
    });
    app.post("/api/cron/remove", async (req, res) => {
        const id = String(req.body?.id ?? req.body?.jobId ?? "");
        const index = state.cronJobs.findIndex((candidate) => candidate.id === id);
        if (index < 0)
            return res.status(404).json({ ok: false, error: "Scheduled job not found" });
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
export async function enqueueDueCronJobs(runtime, state, saveState) {
    const now = Date.now();
    let changed = false;
    for (const job of state.cronJobs.filter((candidate) => candidate.enabled && candidate.nextRunAt <= now)) {
        const worker = await createReadyWorker(runtime, job.message, `cron:${job.id}`, job.brainId);
        job.lastRunAt = now;
        job.lastStatus = "queued";
        job.nextRunAt = now + job.everyMs;
        job.updatedAt = now;
        state.cronEvents.push({ ts: now, type: "cron.queued", jobId: job.id, taskId: worker.id, job: { ...job } });
        changed = true;
    }
    if (state.cronEvents.length > 200)
        state.cronEvents = state.cronEvents.slice(-200);
    if (changed)
        await saveState();
}
export function parseDuration(value) {
    const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(value);
    if (!match)
        throw new TypeError("every must use a duration such as 30s, 5m, 1h, or 1d");
    const amount = Number(match[1]);
    const scale = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()];
    return Math.max(1_000, Math.floor(amount * scale));
}
//# sourceMappingURL=cron.js.map