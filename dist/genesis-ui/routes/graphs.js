// The workspace and memory graphs shown by the interface.
import { errorMessage } from "../presentation.js";
import { collectWorkspaceEntries } from "../files.js";
export function registerGraphsRoutes(ctx) {
    const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
    app.get("/api/workspace/graph", async (_req, res) => {
        try {
            const entries = await collectWorkspaceEntries(workspaceRoot);
            res.json({
                ok: true,
                entries,
                summary: entries.reduce((counts, entry) => {
                    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
                    return counts;
                }, {})
            });
        }
        catch (error) {
            res.status(500).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.get("/api/memory/graph", (_req, res) => {
        const workerLabels = new Map(runtime.listWorkers().map((worker) => [worker.id, worker.objective.description]));
        const allMemories = runtime.mentalObjects.listAll()
            .filter((object) => object.status !== "archived" && object.memoryRoles.length > 0);
        const memories = allMemories
            .sort((left, right) => Date.parse(right.lastAccessedAt) - Date.parse(left.lastAccessedAt))
            .slice(0, 240)
            .reverse();
        const visibleIds = new Set(memories.map((memory) => memory.id));
        const edges = memories.flatMap((memory) => memory.associations
            .filter((edge) => visibleIds.has(edge.targetId))
            .map((edge) => ({
            source: memory.id, target: edge.targetId, kind: edge.kind,
            strength: edge.strength, lastCoactivatedAt: edge.lastCoactivatedAt
        })));
        const nodes = memories.map((memory) => ({
            id: memory.id, workerId: memory.workerId,
            workerLabel: memory.workerId ? workerLabels.get(memory.workerId) ?? "Unknown worker" : "Global memory",
            kind: memory.kind, content: memory.content, roles: memory.memoryRoles,
            activation: memory.activation.total, confidence: memory.confidence, importance: memory.importance,
            status: memory.status, inWorkingMemory: memory.workspace.inWorkingMemory,
            provenance: { kind: memory.provenance.kind, source: memory.provenance.source },
            createdAt: memory.createdAt, lastAccessedAt: memory.lastAccessedAt
        }));
        res.json({ ok: true, nodes, edges, truncated: allMemories.length > memories.length, limit: 240 });
    });
}
//# sourceMappingURL=graphs.js.map