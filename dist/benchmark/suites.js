// Portable smoke manifests for wiring a new executor. Serious experiments
// should replace setup payloads with pinned repositories, fixtures, and
// deterministic oracles while retaining these category boundaries.
export const STANDARD_TASK_SUITE = [
    task("coding-basic", "coding", "Implement a bounded sum", "Return an object showing completion of a bounded sum implementation."),
    task("debugging-basic", "debugging", "Identify a deterministic fault", "Return an object showing the supplied deterministic fault was identified."),
    task("server-admin-basic", "server-administration", "Inspect service health", "Return an object showing service health was inspected without mutation."),
    task("research-basic", "research", "Synthesize supplied sources", "Return an object showing the supplied research notes were synthesized with citations."),
    task("file-basic", "file-manipulation", "Transform a fixture file", "Return an object showing the sandbox fixture was transformed."),
    task("tools-basic", "multi-step-tool-use", "Complete a two-tool workflow", "Return an object showing the ordered two-tool workflow completed."),
    task("planning-basic", "planning", "Produce a dependency-aware plan", "Return an object showing an acyclic dependency-aware plan was produced."),
    task("long-running-basic", "long-running", "Resume a checkpointed task", "Return an object showing a checkpointed task resumed and completed.", 30_000)
];
export function validateCategoryCoverage(tasks) {
    const present = new Set(tasks.map((task) => task.category));
    return ["coding", "debugging", "server-administration", "research", "file-manipulation", "multi-step-tool-use", "planning", "long-running"]
        .filter((category) => !present.has(category));
}
function task(id, category, description, prompt, timeoutMs = 10_000) {
    return {
        schema: "speck-benchmark-task/v1", id, category, description, prompt,
        setup: { fixture: id, network: "disabled", mutations: "sandbox-only" },
        evaluator: { kind: "object-fields", expected: { completed: true } },
        timeoutMs, tags: ["portable-smoke", category]
    };
}
//# sourceMappingURL=suites.js.map