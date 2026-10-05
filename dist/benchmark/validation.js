import { createHash } from "node:crypto";
import { BENCHMARK_CATEGORIES } from "./types.js";
export function validateBenchmarkDesign(tasks, variants) {
    if (tasks.length === 0)
        throw new TypeError("Benchmark requires at least one task");
    if (variants.length < 2)
        throw new TypeError("Benchmark requires at least two variants");
    unique(tasks.map((task) => task.id), "task ids");
    unique(variants.map((variant) => variant.id), "variant ids");
    for (const task of tasks) {
        if (task.schema !== "speck-benchmark-task/v1" || !BENCHMARK_CATEGORIES.includes(task.category))
            throw new TypeError(`Invalid benchmark task ${task.id}`);
        if (!task.id.trim() || !task.description.trim() || !task.prompt.trim())
            throw new TypeError("Benchmark tasks require id, description, and prompt");
        if (!Number.isFinite(task.timeoutMs) || task.timeoutMs <= 0)
            throw new RangeError(`Task ${task.id} requires a positive timeout`);
    }
    for (const variant of variants) {
        if (variant.schema !== "speck-benchmark-variant/v1")
            throw new TypeError(`Invalid benchmark variant ${variant.id}`);
        if (!variant.allowedProcessors.some((processor) => processor.id === variant.primaryProcessor.id))
            throw new TypeError(`Variant ${variant.id} must allow its primary processor`);
        unique(variant.allowedProcessors.map((processor) => processor.id), `allowed processor ids in ${variant.id}`);
        for (const processor of variant.allowedProcessors) {
            if (!processor.id.trim() || !processor.provider.trim() || processor.tier < 0 || processor.parametersBillions < 0)
                throw new TypeError(`Variant ${variant.id} has invalid processor metadata`);
        }
    }
    const groups = new Map();
    for (const variant of variants)
        groups.set(variant.comparisonGroup, [...(groups.get(variant.comparisonGroup) ?? []), variant]);
    for (const [group, members] of groups) {
        const baseline = members.find((variant) => variant.architecture === "minimal-agent");
        const speck = members.find((variant) => variant.architecture === "speck");
        if (!baseline || !speck)
            throw new TypeError(`Comparison group ${group} requires minimal-agent and Speck variants`);
        if (baseline.primaryProcessor.id !== speck.primaryProcessor.id)
            throw new TypeError(`Comparison group ${group} must use the same primary processor`);
    }
}
export function validateModelAccounting(variant, execution) {
    const reasons = [];
    if (execution.observedModelCallCount !== execution.modelCalls.length)
        reasons.push("observed model-call count does not match attributed calls");
    const allowed = new Map(variant.allowedProcessors.map((processor) => [processor.id, processor]));
    for (const call of execution.modelCalls) {
        const descriptor = allowed.get(call.processorId);
        if (!descriptor) {
            reasons.push(`undeclared processor used: ${call.processorId}`);
            continue;
        }
        if (descriptor.provider !== call.provider || descriptor.tier !== call.tier || descriptor.parametersBillions !== call.parametersBillions) {
            reasons.push(`processor metadata mismatch: ${call.processorId}`);
        }
        if (call.processorId !== variant.primaryProcessor.id && !variant.allowEscalation)
            reasons.push(`unpermitted escalation: ${call.processorId}`);
        for (const [field, value] of Object.entries({ inputTokens: call.inputTokens, outputTokens: call.outputTokens, durationMs: call.durationMs, estimatedCostUsd: call.estimatedCostUsd })) {
            if (!Number.isFinite(value) || value < 0)
                reasons.push(`invalid ${field} for processor ${call.processorId}`);
        }
    }
    return [...new Set(reasons)];
}
export function stableHash(value) {
    return createHash("sha256").update(stableJson(value)).digest("hex");
}
export function stableJson(value) {
    return JSON.stringify(sort(value));
}
function sort(value) {
    if (Array.isArray(value))
        return value.map(sort);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sort(nested)]));
}
function unique(values, label) {
    if (new Set(values).size !== values.length)
        throw new TypeError(`${label} must be unique`);
}
//# sourceMappingURL=validation.js.map