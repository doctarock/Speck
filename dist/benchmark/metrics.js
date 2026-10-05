export function computeRunMetrics(execution, durationMs, primaryProcessorId) {
    const inputTokens = sum(execution.modelCalls.map((call) => call.inputTokens));
    const outputTokens = sum(execution.modelCalls.map((call) => call.outputTokens));
    const sizes = execution.modelCalls.map((call) => call.parametersBillions);
    const escalations = execution.modelCalls.filter((call) => call.processorId !== primaryProcessorId).length;
    return {
        ...execution.cognitive,
        durationMs,
        inputTokens,
        outputTokens,
        tokensToCompletion: inputTokens + outputTokens,
        modelCalls: execution.modelCalls.length,
        largestModelBillions: sizes.length ? Math.max(...sizes) : 0,
        averageModelBillions: sizes.length ? sum(sizes) / sizes.length : 0,
        toolCalls: execution.toolCalls.length,
        failedToolCalls: execution.toolCalls.filter((call) => !call.successful).length,
        escalations,
        estimatedCostUsd: sum(execution.modelCalls.map((call) => call.estimatedCostUsd)),
        proceduralFastPathRate: ratio(execution.cognitive.procedureHits, execution.cognitive.procedureHits + execution.modelCalls.length),
        knownAnswerHitRate: ratio(execution.cognitive.knownAnswerHits, execution.cognitive.knownAnswerHits + execution.modelCalls.length),
        memoryRetrievalUsefulness: ratio(execution.cognitive.usefulMemoryRetrievals, execution.cognitive.memoryRetrievals),
        escalationFrequency: ratio(escalations, execution.modelCalls.length)
    };
}
export function aggregateRuns(runs) {
    const valid = runs.filter((run) => run.valid);
    const durations = valid.map((run) => run.metrics.durationMs).sort((a, b) => a - b);
    return {
        runs: runs.length,
        validRuns: valid.length,
        invalidRuns: runs.length - valid.length,
        successRate: ratio(valid.filter((run) => run.success).length, valid.length),
        meanScore: average(valid.map((run) => run.score)),
        meanDurationMs: average(durations),
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        meanTokens: average(valid.map((run) => run.metrics.tokensToCompletion)),
        meanModelCalls: average(valid.map((run) => run.metrics.modelCalls)),
        meanToolCalls: average(valid.map((run) => run.metrics.toolCalls)),
        meanCostUsd: average(valid.map((run) => run.metrics.estimatedCostUsd)),
        smallModelCompletionRate: ratio(valid.filter((run) => run.success && run.metrics.escalations === 0).length, valid.length),
        escalationFrequency: average(valid.map((run) => run.metrics.escalationFrequency)),
        proceduralFastPathRate: average(valid.map((run) => run.metrics.proceduralFastPathRate)),
        knownAnswerHitRate: average(valid.map((run) => run.metrics.knownAnswerHitRate)),
        memoryRetrievalUsefulness: average(valid.map((run) => run.metrics.memoryRetrievalUsefulness))
    };
}
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function average(values) { return values.length ? sum(values) / values.length : 0; }
function ratio(numerator, denominator) { return denominator > 0 ? numerator / denominator : 0; }
function percentile(sorted, quantile) {
    if (sorted.length === 0)
        return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}
//# sourceMappingURL=metrics.js.map