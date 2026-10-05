export function validateSubtasks(input, maximum) {
    if (input.length === 0)
        throw new TypeError("A parallel plan requires at least one subtask");
    if (input.length > maximum)
        throw new RangeError(`A parallel plan may contain at most ${maximum} subtasks`);
    const normalized = input.map((entry, index) => ({
        id: String(entry.id || `subtask-${index + 1}`).trim(),
        objective: String(entry.objective ?? "").trim(),
        dependencies: [...new Set((entry.dependencies ?? []).map(String).map((value) => value.trim()).filter(Boolean))],
        priority: boundedPriority(entry.priority ?? 0),
        completionCriteria: (entry.completionCriteria ?? []).map(String).map((value) => value.trim()).filter(Boolean),
        constraints: (entry.constraints ?? []).map(String).map((value) => value.trim()).filter(Boolean)
    }));
    if (normalized.some((entry) => !entry.id || !entry.objective))
        throw new TypeError("Every subtask requires an id and objective");
    const ids = new Set(normalized.map((entry) => entry.id));
    if (ids.size !== normalized.length)
        throw new TypeError("Subtask ids must be unique within a plan");
    for (const entry of normalized) {
        if (entry.dependencies.includes(entry.id))
            throw new TypeError(`Subtask ${entry.id} cannot depend on itself`);
        for (const dependency of entry.dependencies) {
            if (!ids.has(dependency))
                throw new TypeError(`Subtask ${entry.id} has unknown dependency ${dependency}`);
        }
    }
    assertAcyclic(normalized);
    return normalized;
}
export function readParallelPlan(object) {
    if (object.kind !== "artifact" || object.data.schema !== "speck.parallel-plan.v1")
        return null;
    return object.data;
}
export function dependenciesSatisfied(plan, subtaskId) {
    const task = plan.subtasks.find((entry) => entry.id === subtaskId);
    if (!task)
        throw new TypeError(`Unknown subtask ${subtaskId}`);
    return task.dependencies.every((dependency) => plan.subtasks.find((entry) => entry.id === dependency)?.status === "completed");
}
function assertAcyclic(subtasks) {
    const dependencies = new Map(subtasks.map((entry) => [entry.id, entry.dependencies]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
        if (visiting.has(id))
            throw new TypeError(`Subtask dependency graph contains a cycle at ${id}`);
        if (visited.has(id))
            return;
        visiting.add(id);
        for (const dependency of dependencies.get(id) ?? [])
            visit(dependency);
        visiting.delete(id);
        visited.add(id);
    };
    for (const id of dependencies.keys())
        visit(id);
}
function boundedPriority(value) {
    const priority = Number(value);
    if (!Number.isFinite(priority) || priority < 0 || priority > 100)
        throw new RangeError("Subtask priority must be between 0 and 100");
    return priority;
}
//# sourceMappingURL=planner.js.map