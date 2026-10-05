// Planning: when intake routes a task to the planner, it is split into
// subtasks run as a parallel plan. The planner supplies the decomposition and
// its ordering only; identifiers, priorities and bookkeeping are Speck's.
import { validateSubtasks } from "../../coordination/planner.js";
import { planContract } from "./contracts.js";
import { actor, roleProcessor } from "./support.js";
export class Planning {
    runtime;
    view;
    recollection;
    constructor(runtime, view, recollection) {
        this.runtime = runtime;
        this.view = view;
        this.recollection = recollection;
    }
    // The plan's result, or null when no usable plan was made (the objective
    // then falls back to direct execution rather than failing the turn).
    async plan(worker) {
        await this.runtime.importSharedMemories({
            workerId: worker.id,
            query: worker.objective.description,
            role: "planner",
            limit: 8,
            actor: actor("shared-memory:planner")
        });
        const processorId = roleProcessor(this.runtime, "planner");
        await this.recollection.recall(worker, "planner");
        let inferred;
        try {
            inferred = await this.runtime.inferForWorker({
                workerId: worker.id, ...(processorId ? { processorId } : {}), contract: planContract,
                instruction: `Split the objective into 2 to 8 subtasks that can each be carried out on its own.\nObjective: ${worker.objective.description}${this.view.conversationInstruction(worker)}`,
                actor: actor("planner")
            });
        }
        catch {
            return null;
        }
        let subtasks;
        try {
            subtasks = validateSubtasks(normalizeSubtasks(inferred.response.structured?.subtasks), this.runtime.config.coordination.maximumSubtasks);
        }
        catch {
            return null;
        }
        if (subtasks.length < 2)
            return null;
        await this.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: [inferred.object.id], actor: actor("planner") });
        await this.runtime.createCommitment({
            workerId: worker.id,
            content: `Execute and aggregate ${subtasks.length} planned subtasks for: ${worker.objective.description}`,
            priority: "high", actor: actor("planner")
        });
        let current = this.runtime.getWorker(worker.id);
        if (current.status === "orienting")
            current = await this.runtime.transitionWorker(current.id, "planning", actor("planner"), "Creating parallel plan");
        const created = await this.runtime.createParallelPlan({ plannerWorkerId: current.id, objective: current.objective.description, subtasks, actor: actor("planner") });
        current = await this.runtime.transitionWorker(current.id, "waiting", actor("planner"), "Waiting for planned subtasks");
        return { status: "planned", worker: current, summary: `Plan created with ${subtasks.length} subtasks.`, planId: created.plan.id };
    }
}
// Shortcut S16 (docs/COGNITIVE_SHORTCUTS.md).
export function normalizeSubtasks(value) {
    if (!Array.isArray(value))
        throw new TypeError("subtasks must be an array");
    const items = value.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new TypeError("invalid subtask");
        return raw;
    });
    const ids = items.map((_, index) => `task-${index + 1}`);
    // A dependency may be given as a 1-based position or as an identifier the
    // model attached to an earlier subtask; both name the same subtask.
    const byOwnId = new Map(items.flatMap((item, index) => item.id === undefined ? [] : [[String(item.id).trim(), ids[index]]]));
    const resolve = (reference) => {
        const text = String(reference).trim();
        const position = /^\d+$/.test(text) ? Number(text) : NaN;
        const resolved = byOwnId.get(text) ?? (position >= 1 && position <= ids.length ? ids[position - 1] : undefined);
        if (!resolved)
            throw new TypeError(`unresolvable subtask dependency ${text}`);
        return resolved;
    };
    return items.map((item, index) => {
        const references = item.after ?? item.dependencies ?? [];
        return {
            id: ids[index],
            objective: String(item.objective ?? "").trim(),
            dependencies: (Array.isArray(references) ? references : [references]).map(resolve),
            priority: 50,
            completionCriteria: [],
            constraints: []
        };
    });
}
//# sourceMappingURL=planning.js.map