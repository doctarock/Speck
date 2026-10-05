// The task queue: listing, enqueueing, dispatch, answers, stopping, and history.
import { toGenesisTask, toGenesisHistoryEvent, genesisEventType, errorMessage } from "../presentation.js";
import { createReadyWorker, recordConversationContinuation, processNextWorker, transitionToward, requireWorker } from "../tasks.js";
export function registerTasksRoutes(ctx) {
    const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
    app.get("/api/tasks/list", (_req, res) => {
        const tasks = runtime.listWorkers().filter((worker) => !archived.has(worker.id)).map(toGenesisTask);
        res.json({
            ok: true,
            queued: tasks.filter((task) => task.status === "queued"),
            waiting: tasks.filter((task) => task.status === "waiting_for_user"),
            inProgress: tasks.filter((task) => task.status === "in_progress"),
            // Cancelled tasks are closed, not deleted: they stay findable under Done.
            done: tasks.filter((task) => task.status === "completed" || task.status === "closed"),
            failed: tasks.filter((task) => task.status === "failed"),
            repairMonitor: { active: [], reviews: [], recent: [] },
            queue: { paused: state.queuePaused }
        });
    });
    app.post("/api/tasks/enqueue", async (req, res) => {
        try {
            const worker = await createReadyWorker(runtime, String(req.body?.message ?? ""), req.body?.sessionId, req.body?.requestedBrainId);
            res.status(201).json({ ok: true, task: toGenesisTask(worker) });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/tasks/triage", (_req, res) => {
        const selected = runtime.modelRegistry.generative()[0];
        res.json({
            ok: true,
            triage: {
                mode: "queue",
                reason: "Speck persists requests as Workers before execution.",
                replyText: "The request has been admitted to Speck's persistent worker queue.",
                selectedBrainId: selected?.id ?? "worker",
                selectedBrainLabel: selected?.id ?? "Speck Worker",
                plannedTasks: []
            }
        });
    });
    app.post("/api/tasks/dispatch-next", async (_req, res) => {
        try {
            const worker = await processNextWorker(runtime, state, archived);
            res.json({ ok: true, task: worker ? toGenesisTask(worker) : null, message: worker ? "Task dispatched." : "No task is ready." });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/tasks/answer", async (req, res) => {
        try {
            const worker = requireWorker(runtime, req.body?.taskId);
            const answer = String(req.body?.answer ?? "").trim();
            if (!answer)
                throw new TypeError("answer is required");
            await recordConversationContinuation(runtime, worker, answer, "Main");
            const updated = await transitionToward(runtime, runtime.getWorker(worker.id), "ready", "User answered through the Genesis GUI");
            res.json({ ok: true, task: toGenesisTask(updated) });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/tasks/abort", async (req, res) => taskStop(req.body?.taskId, "Task aborted through the Genesis GUI", res));
    app.post("/api/tasks/remove", async (req, res) => taskStop(req.body?.taskId, "Task archived through the Genesis GUI", res, true));
    async function taskStop(taskId, reason, res, archive = false) {
        try {
            const worker = requireWorker(runtime, taskId);
            let updated = worker;
            if (!["completed", "failed", "suspended"].includes(worker.status)) {
                updated = await runtime.transitionWorker(worker.id, "suspended", { kind: "user", source: "genesis-gui" }, reason);
            }
            if (archive) {
                archived.add(worker.id);
                await saveState();
            }
            res.json({ ok: true, task: toGenesisTask(updated), removed: archive });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    }
    app.get("/api/tasks/history", (req, res) => {
        try {
            const worker = requireWorker(runtime, req.query.taskId);
            const events = runtime.listEvents(worker.id, 0, Math.max(1, Number(req.query.limit ?? 100)));
            res.json({ ok: true, task: toGenesisTask(worker), events: events.map(toGenesisHistoryEvent) });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/tasks/events", (req, res) => {
        const sinceTs = Number(req.query.sinceTs ?? 0);
        const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50)));
        const events = runtime.listEvents(undefined, 0, 1000)
            .filter((event) => Date.parse(event.occurredAt) > sinceTs && event.workerId && !archived.has(event.workerId))
            .slice(-limit)
            .map((event) => ({
            type: genesisEventType(event.type), eventSeq: event.sequence, ts: Date.parse(event.occurredAt), event,
            task: event.workerId ? runtime.getWorker(event.workerId) : null
        }))
            .map((entry) => ({ ...entry, task: entry.task ? toGenesisTask(entry.task) : null }));
        res.json({ ok: true, events });
    });
    app.get("/api/tasks/reshape-issues", (_req, res) => res.json({ ok: true, issues: [], summary: { total: 0 } }));
    app.post("/api/tasks/reshape-issues/reset", (_req, res) => res.json({ ok: true, issues: [] }));
}
//# sourceMappingURL=tasks.js.map