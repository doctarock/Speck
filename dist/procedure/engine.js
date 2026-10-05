import { comparePrediction } from "../prediction/compare.js";
export function normalizeTrigger(value) {
    return value.trim().toLowerCase().replace(/[.,!?;:]+$/g, "").replace(/\s+/g, " ");
}
export function procedureSignature(trigger, steps, preconditions) {
    return JSON.stringify({ trigger: normalizeTrigger(trigger), steps, preconditions });
}
export function readProcedure(object) {
    return object.kind === "procedure" && object.data.schema === "speck-procedure/v1"
        ? object.data : null;
}
export function readKnownAnswer(object) {
    return object.kind === "known-answer" && object.data.schema === "speck-known-answer/v1"
        ? object.data : null;
}
export function findCompiledProcedure(objects, trigger) {
    const key = normalizeTrigger(trigger);
    const matches = objects.filter((object) => {
        const procedure = readProcedure(object);
        return object.status === "active" && procedure?.status === "compiled" && procedure.trigger.value === key;
    });
    return matches.length === 1 ? matches[0] : null;
}
export function findKnownAnswer(objects, query, minimumConfidence) {
    const key = normalizeTrigger(query);
    const matches = objects.filter((object) => {
        const answer = readKnownAnswer(object);
        return object.status === "active" && object.confidence >= minimumConfidence && answer?.keys.includes(key);
    }).sort((a, b) => b.confidence - a.confidence || b.lastAccessedAt.localeCompare(a.lastAccessedAt) || a.id.localeCompare(b.id));
    if (matches.length > 1 && matches[0].confidence === matches[1].confidence
        && readKnownAnswer(matches[0]).answer !== readKnownAnswer(matches[1]).answer)
        return null;
    return matches[0] ?? null;
}
export function conditionsMatch(conditions, actual) {
    if (!conditions.length)
        return true;
    return comparePrediction({ description: "procedure guard", confidence: 1, sourceChannel: "procedure", conditions: [...conditions] }, actual, [], {
        enabled: true, precisionWindow: 1, precisionEpsilon: 0.001, defaultPrecision: 1,
        highErrorThreshold: 0.6, pressureGain: 0, pressureRelief: 0,
        focusedPressureThreshold: 1, conservativePressureThreshold: 1, progressGain: 0
    }).conditions.every((condition) => condition.matched);
}
// ACA/ACT-R utility update: U(n) = U(n-1) + alpha * (reward - U(n-1)).
export function applyProcedureFeedback(definition, successful, input, config) {
    const reward = successful ? 1 : 0;
    const successCount = definition.successCount + Number(successful);
    const failureCount = definition.failureCount + Number(!successful);
    const utility = definition.utility + config.utilityLearningRate * (reward - definition.utility);
    const total = successCount + failureCount;
    const status = failureCount >= config.deprecationFailureCount && successCount / total < config.deprecationSuccessRate
        ? "deprecated" : definition.status;
    return {
        ...definition,
        status,
        successCount,
        failureCount,
        utility,
        executionHistory: [...definition.executionHistory, { ...input, successful }].slice(-config.executionHistoryCapacity)
    };
}
//# sourceMappingURL=engine.js.map