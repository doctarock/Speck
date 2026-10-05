// The Genesis interface: wires the route modules in src/genesis-ui/ to the
// runtime, and runs the task queue and background cognition schedulers.
import fs from "node:fs/promises";
import path from "node:path";
import { registerCronRoutes, enqueueDueCronJobs } from "./genesis-ui/cron.js";
import { broadcastSse } from "./genesis-ui/sse.js";
import { loadState } from "./genesis-ui/state.js";
import { inProgressWorkers, processNextWorker, queuedWorkers } from "./genesis-ui/tasks.js";
import { errorMessage, genesisEventType, toGenesisTask } from "./genesis-ui/presentation.js";
import { registerEventsRoutes } from "./genesis-ui/routes/events.js";
import { registerProfileRoutes } from "./genesis-ui/routes/profile.js";
import { registerRuntimeRoutes } from "./genesis-ui/routes/runtime.js";
import { registerGraphsRoutes } from "./genesis-ui/routes/graphs.js";
import { registerAppConfigRoutes } from "./genesis-ui/routes/app-config.js";
import { registerConfigRoutes } from "./genesis-ui/routes/config.js";
import { registerTasksRoutes } from "./genesis-ui/routes/tasks.js";
import { registerAgentRoutes } from "./genesis-ui/routes/agent.js";
import { registerInspectRoutes } from "./genesis-ui/routes/inspect.js";
export { canonicalizeVoiceMessage, isConversationCancellation, isConversationParking } from "./genesis-ui/tasks.js";
export async function registerGenesisUi(app, runtime, config, options) {
    const statePath = path.join(config.genesisRuntimePath, "genesis-ui-state.json");
    const workspaceRoot = path.join(config.genesisRuntimePath, "workspace");
    const inboxRoot = path.join(workspaceRoot, "inbox");
    const outboxRoot = path.join(workspaceRoot, "outbox");
    await Promise.all([
        fs.mkdir(inboxRoot, { recursive: true }),
        fs.mkdir(outboxRoot, { recursive: true })
    ]);
    const state = await loadState(statePath);
    runtime.memoryAdmissionPolicy = { ...state.memoryAdmission };
    const archived = new Set(state.archivedWorkerIds);
    const logClients = new Set();
    const eventClients = new Set();
    let processing = false;
    const saveState = async () => {
        state.archivedWorkerIds = [...archived];
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        const temporaryPath = `${statePath}.tmp`;
        await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await fs.rename(temporaryPath, statePath);
    };
    const broadcastLog = (line) => broadcastSse(logClients, { ts: Date.now(), line });
    const broadcastEvent = (event) => {
        const worker = event.workerId ? runtime.getWorker(event.workerId) : null;
        broadcastSse(eventClients, {
            type: genesisEventType(event.type),
            eventSeq: event.sequence,
            ts: Date.parse(event.occurredAt),
            event,
            ...(worker ? { task: toGenesisTask(worker) } : {})
        });
    };
    const unsubscribe = runtime.eventBus.on("*", (event) => {
        broadcastLog(`[speck] ${event.type}${event.workerId ? ` ${event.workerId}` : ""}`);
        broadcastEvent(event);
    });
    const ctx = { app, runtime, config, options, state, archived, saveState, broadcastLog, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot };
    registerEventsRoutes(ctx);
    registerProfileRoutes(ctx);
    registerRuntimeRoutes(ctx);
    registerGraphsRoutes(ctx);
    registerAppConfigRoutes(ctx);
    registerConfigRoutes(ctx);
    registerTasksRoutes(ctx);
    registerAgentRoutes(ctx);
    registerInspectRoutes(ctx);
    registerCronRoutes(app, runtime, state, saveState);
    const scheduler = setInterval(async () => {
        if (processing || state.queuePaused)
            return;
        processing = true;
        try {
            await enqueueDueCronJobs(runtime, state, saveState);
            await processNextWorker(runtime, state, archived);
        }
        catch (error) {
            broadcastLog(`[speck] queue error: ${errorMessage(error)}`);
        }
        finally {
            processing = false;
        }
    }, 1_000);
    scheduler.unref();
    const backgroundScheduler = setInterval(async () => {
        if (processing || queuedWorkers(runtime, archived).length > 0 || inProgressWorkers(runtime, archived).length > 0)
            return;
        processing = true;
        try {
            await runtime.runBackgroundCognition();
        }
        catch (error) {
            broadcastLog(`[speck] background cognition error: ${errorMessage(error)}`);
        }
        finally {
            processing = false;
        }
    }, 30_000);
    backgroundScheduler.unref();
    return {
        async close() {
            clearInterval(scheduler);
            clearInterval(backgroundScheduler);
            unsubscribe();
            for (const client of [...logClients, ...eventClients])
                client.end();
            await saveState();
        }
    };
}
//# sourceMappingURL=genesis-ui.js.map