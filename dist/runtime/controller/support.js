// Small helpers the controller's collaborators share.
export function actor(source) {
    return { kind: "runtime", source: `speck-controller:${source}` };
}
// Shortcut S8 (docs/COGNITIVE_SHORTCUTS.md).
export function roleProcessor(runtime, role) {
    const roles = runtime.config.modelRuntime.roles;
    // The writer's seat falls back to the worker's.
    const configured = role === "writer" ? roles.writer && runtime.modelRegistry.has(roles.writer) ? roles.writer : roles.worker : roles[role];
    return configured && runtime.modelRegistry.has(configured) ? configured : runtime.modelRegistry.generative().find((processor) => processor.enabled)?.id ?? "";
}
export function activeSharedMemories(runtime) {
    return runtime.mentalObjects.listAll()
        .filter((object) => object.workerId === null && object.status !== "archived" && Boolean(object.data.sharedMemory)
        && (object.memoryRoles.includes("semantic") || object.memoryRoles.includes("episodic")))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
// A reply that completes the request is validated as a completion; one that
// waits (provisionally, or blocked on the user) is validated as a wait; an
// empty reply makes no progress.
export function deriveAction(value) {
    const reply = typeof value.reply === "string" ? value.reply.trim() : "";
    const action = !reply ? "continue" : value.state === "blocked" ? "question" : value.state === "provisional" ? "provisional" : "complete";
    return { action, response: reply };
}
export function resultSummary(worker) {
    const value = worker.worldState["genesis.resultSummary"]?.value;
    return typeof value === "string" ? value : "";
}
export function statusResult(worker) {
    return worker.status === "completed" ? "completed" : worker.status === "failed" ? "failed" : "waiting";
}
//# sourceMappingURL=support.js.map