// TypeScript counterpart of ACA steps/compare.rs, adapted from embedding
// distance to deterministic structured conditions for operational outcomes.
export function comparePrediction(prediction, observation, previousErrors, config, comparedAt = new Date().toISOString()) {
    validatePredictionSpec(prediction);
    const conditions = prediction.conditions.map((condition) => compareCondition(condition, observation));
    const totalWeight = prediction.conditions.reduce((sum, condition) => sum + normalizeWeight(condition.weight), 0);
    const weightedError = conditions.reduce((sum, result) => sum + result.error * normalizeWeight(result.condition.weight), 0);
    const errorMagnitude = totalWeight > 0 ? weightedError / totalWeight : 1;
    const precision = precisionFor(previousErrors.slice(-config.precisionWindow), config);
    const precisionWeightedSurprise = errorMagnitude * precision;
    return {
        errorMagnitude,
        precision,
        precisionWeightedSurprise,
        epistemicValue: 1 / precision,
        verdict: conditions.some((entry) => entry.observed === undefined && !entry.matched)
            ? "uncertain"
            : errorMagnitude >= config.highErrorThreshold ? "contradicted" : "confirmed",
        conditions,
        comparedAt
    };
}
export function precisionFor(previousErrors, config) {
    const values = previousErrors.filter((value) => Number.isFinite(value)).slice(-config.precisionWindow);
    if (values.length < 2)
        return config.defaultPrecision;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return 1 / (Math.sqrt(variance) + config.precisionEpsilon);
}
export function validatePredictionSpec(spec) {
    if (!spec.description.trim())
        throw new TypeError("Prediction description is required");
    if (!spec.sourceChannel.trim())
        throw new TypeError("Prediction source channel is required");
    if (!Number.isFinite(spec.confidence) || spec.confidence < 0 || spec.confidence > 1) {
        throw new RangeError("Prediction confidence must be between 0 and 1");
    }
    if (!spec.conditions.length)
        throw new TypeError("Prediction requires at least one condition");
    for (const condition of spec.conditions) {
        if (!condition.path.trim())
            throw new TypeError("Prediction condition path is required");
        if (!["equals", "not-equals", "exists", "includes", "gte", "lte"].includes(condition.operator)) {
            throw new TypeError(`Unknown prediction operator: ${String(condition.operator)}`);
        }
        if (!Number.isFinite(normalizeWeight(condition.weight)) || normalizeWeight(condition.weight) <= 0) {
            throw new RangeError("Prediction condition weight must be positive");
        }
    }
}
function compareCondition(condition, observation) {
    const observed = resolvePath(observation, condition.path);
    let matched = false;
    switch (condition.operator) {
        case "exists":
            matched = condition.value === false ? observed === undefined : observed !== undefined;
            break;
        case "equals":
            matched = stableValue(observed) === stableValue(condition.value);
            break;
        case "not-equals":
            matched = stableValue(observed) !== stableValue(condition.value);
            break;
        case "includes":
            matched = includes(observed, condition.value);
            break;
        case "gte":
            matched = typeof observed === "number" && typeof condition.value === "number" && observed >= condition.value;
            break;
        case "lte":
            matched = typeof observed === "number" && typeof condition.value === "number" && observed <= condition.value;
            break;
    }
    return { condition: { ...condition }, matched, observed, error: matched ? 0 : 1 };
}
function resolvePath(value, path) {
    if (path === "$" || path.trim() === "")
        return value;
    let current = value;
    for (const segment of path.replace(/^\$\.?/, "").split(".").filter(Boolean)) {
        if (!current || typeof current !== "object" || Array.isArray(current))
            return undefined;
        current = current[segment];
    }
    return current;
}
function includes(observed, expected) {
    if (typeof observed === "string")
        return observed.includes(String(expected ?? ""));
    if (Array.isArray(observed))
        return observed.some((entry) => stableValue(entry) === stableValue(expected));
    return false;
}
function stableValue(value) {
    if (!value || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableValue).join(",")}]`;
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => `${JSON.stringify(key)}:${stableValue(nested)}`).join(",")}}`;
}
function normalizeWeight(weight) {
    return weight ?? 1;
}
//# sourceMappingURL=compare.js.map