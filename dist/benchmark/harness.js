import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { aggregateRuns, computeRunMetrics } from "./metrics.js";
import { stableHash, stableJson, validateBenchmarkDesign, validateModelAccounting } from "./validation.js";
export const BENCHMARK_HARNESS_VERSION = "1.0.0";
export class BenchmarkHarness {
    executor;
    constructor(executor) {
        this.executor = executor;
    }
    async run(input) {
        validateBenchmarkDesign(input.tasks, input.variants);
        const repetitions = positiveInteger(input.repetitions ?? 1, "repetitions");
        const seed = integer(input.seed ?? 3407, "seed");
        const experimentId = input.experimentId?.trim() || randomUUID();
        const startedAt = new Date().toISOString();
        const taskHashes = Object.fromEntries(input.tasks.map((task) => [task.id, stableHash(task)]));
        const variantHashes = Object.fromEntries(input.variants.map((variant) => [variant.id, stableHash(variant)]));
        const schedule = seededShuffle(input.tasks.flatMap((task) => input.variants.flatMap((variant) => Array.from({ length: repetitions }, (_, repetition) => ({ task, variant, repetition, seed: trialSeed(seed, task.id, repetition) })))), seed);
        const runs = [];
        for (const trial of schedule)
            runs.push(await this.runTrial({ ...trial, experimentId, taskHash: taskHashes[trial.task.id], variantHash: variantHashes[trial.variant.id] }));
        return {
            schema: "speck-benchmark-report/v1",
            harnessVersion: BENCHMARK_HARNESS_VERSION,
            experimentId,
            seed,
            repetitions,
            startedAt,
            completedAt: new Date().toISOString(),
            taskHashes,
            variantHashes,
            runs,
            aggregates: aggregateReport(runs),
            comparisons: compareVariants(runs)
        };
    }
    async runTrial(input) {
        const controller = new AbortController();
        const startedAt = new Date().toISOString();
        const started = performance.now();
        let execution = null;
        let error = null;
        try {
            execution = await withTimeout(this.executor.execute({
                experimentId: input.experimentId, task: input.task, variant: input.variant,
                repetition: input.repetition, seed: input.seed, signal: controller.signal
            }), input.task.timeoutMs, controller);
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        const durationMs = performance.now() - started;
        const invalidReasons = execution ? validateModelAccounting(input.variant, execution) : [];
        const evaluation = execution && invalidReasons.length === 0
            ? evaluate(input.task.evaluator, execution.output)
            : { success: false, score: 0, reason: error ?? (invalidReasons.join("; ") || "no execution") };
        return {
            schema: "speck-benchmark-run/v1", harnessVersion: BENCHMARK_HARNESS_VERSION,
            runId: randomUUID(), experimentId: input.experimentId, taskId: input.task.id, taskHash: input.taskHash,
            category: input.task.category, variantId: input.variant.id, variantHash: input.variantHash,
            comparisonGroup: input.variant.comparisonGroup, architecture: input.variant.architecture,
            primaryProcessor: input.variant.primaryProcessor, repetition: input.repetition, seed: input.seed,
            startedAt, completedAt: new Date().toISOString(), valid: invalidReasons.length === 0,
            invalidReasons, success: evaluation.success, score: evaluation.score,
            evaluationReason: evaluation.reason, error,
            metrics: execution ? computeRunMetrics(execution, durationMs, input.variant.primaryProcessor.id) : emptyMetrics(durationMs),
            execution
        };
    }
}
export function evaluate(evaluator, output) {
    if (evaluator.kind === "exact") {
        const success = stableJson(output) === stableJson(evaluator.expected);
        return { success, score: Number(success), reason: success ? "exact match" : "exact mismatch" };
    }
    if (evaluator.kind === "contains-all") {
        const actual = evaluator.caseSensitive ? String(output) : String(output).toLowerCase();
        const expected = evaluator.caseSensitive ? evaluator.expected : evaluator.expected.map((value) => value.toLowerCase());
        const matched = expected.filter((value) => actual.includes(value)).length;
        return { success: matched === expected.length, score: expected.length ? matched / expected.length : 1, reason: `${matched}/${expected.length} required fragments` };
    }
    const record = output && typeof output === "object" && !Array.isArray(output) ? output : {};
    const entries = Object.entries(evaluator.expected);
    const matched = entries.filter(([key, value]) => stableJson(record[key]) === stableJson(value)).length;
    return { success: matched === entries.length, score: entries.length ? matched / entries.length : 1, reason: `${matched}/${entries.length} expected fields` };
}
function aggregateReport(runs) {
    const groups = new Map();
    for (const run of runs) {
        for (const key of [`variant:${run.variantId}`, `variant:${run.variantId}/category:${run.category}`, `variant:${run.variantId}/task:${run.taskId}`]) {
            groups.set(key, [...(groups.get(key) ?? []), run]);
        }
    }
    return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, members]) => [key, aggregateRuns(members)]));
}
function compareVariants(runs) {
    const groups = new Map();
    for (const run of runs)
        groups.set(run.comparisonGroup, [...(groups.get(run.comparisonGroup) ?? []), run]);
    return [...groups.entries()].flatMap(([comparisonGroup, members]) => {
        const byVariant = new Map();
        for (const run of members)
            byVariant.set(run.variantId, [...(byVariant.get(run.variantId) ?? []), run]);
        const baselineEntry = [...byVariant.entries()].find(([, variantRuns]) => variantRuns[0]?.architecture === "minimal-agent");
        if (!baselineEntry)
            return [];
        const [baselineVariantId, baselineRuns] = baselineEntry;
        const baseline = aggregateRuns(baselineRuns);
        return [...byVariant.entries()].filter(([, variantRuns]) => variantRuns[0]?.architecture === "speck").map(([candidateVariantId, candidateRuns]) => {
            const candidate = aggregateRuns(candidateRuns);
            return {
                comparisonGroup, baselineVariantId, candidateVariantId,
                baselineValidRuns: baseline.validRuns, candidateValidRuns: candidate.validRuns,
                delta: {
                    successRate: candidate.successRate - baseline.successRate,
                    meanScore: candidate.meanScore - baseline.meanScore,
                    meanDurationMs: candidate.meanDurationMs - baseline.meanDurationMs,
                    meanTokens: candidate.meanTokens - baseline.meanTokens,
                    meanModelCalls: candidate.meanModelCalls - baseline.meanModelCalls,
                    meanCostUsd: candidate.meanCostUsd - baseline.meanCostUsd,
                    smallModelCompletionRate: candidate.smallModelCompletionRate - baseline.smallModelCompletionRate
                }
            };
        });
    });
}
function withTimeout(operation, timeoutMs, controller) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            controller.abort(new Error(`Benchmark timed out after ${timeoutMs}ms`));
            reject(new Error(`Benchmark timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        operation.then((value) => { clearTimeout(timeout); resolve(value); }, (error) => { clearTimeout(timeout); reject(error); });
    });
}
function trialSeed(seed, taskId, repetition) {
    let value = seed ^ repetition;
    for (let index = 0; index < taskId.length; index += 1)
        value = Math.imul(value ^ taskId.charCodeAt(index), 16777619);
    return value >>> 0;
}
function seededShuffle(values, seed) {
    const result = [...values];
    let state = seed >>> 0;
    for (let index = result.length - 1; index > 0; index -= 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const target = state % (index + 1);
        [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
}
function emptyMetrics(durationMs) {
    return {
        durationMs, inputTokens: 0, outputTokens: 0, tokensToCompletion: 0, modelCalls: 0,
        largestModelBillions: 0, averageModelBillions: 0, toolCalls: 0, failedToolCalls: 0,
        escalations: 0, estimatedCostUsd: 0, impasses: 0, successfulImpasseRecoveries: 0,
        procedureHits: 0, knownAnswerHits: 0, memoryRetrievals: 0, usefulMemoryRetrievals: 0,
        contextTokens: 0, repeatedStateCount: 0, llmCallsAvoided: 0, tokensAvoided: 0,
        proceduralFastPathRate: 0, knownAnswerHitRate: 0, memoryRetrievalUsefulness: 0, escalationFrequency: 0
    };
}
function positiveInteger(value, name) {
    if (!Number.isInteger(value) || value <= 0)
        throw new RangeError(`${name} must be a positive integer`);
    return value;
}
function integer(value, name) {
    if (!Number.isInteger(value))
        throw new RangeError(`${name} must be an integer`);
    return value;
}
//# sourceMappingURL=harness.js.map