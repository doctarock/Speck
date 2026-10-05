import { effectiveStrength } from "./edges.js";
// Direct TypeScript translation of ACA aca-graph/src/activation.rs.
export const DEFAULT_REFERENCE_LOG_CAPACITY = 64;
export const DEFAULT_SUPPRESSION_TAU_MS = 2_000;
export function computeBaseLevel(referenceLog, decayD, now) {
    if (referenceLog.length === 0)
        return Number.NEGATIVE_INFINITY;
    const sum = referenceLog.reduce((total, reference) => {
        const deltaMs = Math.max(1, now.getTime() - new Date(reference).getTime());
        const deltaUnits = deltaMs / 1_000;
        return total + Math.pow(deltaUnits, -decayD);
    }, 0);
    return Math.log(sum);
}
export function computeSpreadingActivation(targetId, activeSources, now, decayRatePerMs, inhibitionEnabled = true) {
    if (activeSources.length === 0)
        return 0;
    const uniformWeight = 1 / activeSources.length;
    return activeSources.reduce((total, edges) => total + uniformWeight * edges
        .filter((edge) => edge.targetId === targetId)
        .reduce((sum, edge) => {
        const negative = edge.kind === "inhibitory" || edge.kind === "contradicts";
        if (negative && !inhibitionEnabled)
            return sum;
        return sum + (negative ? -1 : 1) * effectiveStrength(edge, now, decayRatePerMs);
    }, 0), 0);
}
export function sampleNoise(random, maxNoise) {
    if (maxNoise <= 0)
        return 0;
    return -maxNoise + random() * maxNoise * 2;
}
export function recomputeActivation(input) {
    const elapsedMs = Math.max(0, input.now.getTime() - new Date(input.state.lastComputedAt).getTime());
    const suppression = input.state.suppression * Math.exp(-elapsedMs / DEFAULT_SUPPRESSION_TAU_MS);
    const baseLevel = computeBaseLevel(input.state.references, input.state.decay, input.now);
    const spreading = computeSpreadingActivation(input.targetId, input.activeSources, input.now, input.edgeDecayRatePerMs, input.inhibitionEnabled);
    const noise = sampleNoise(input.random ?? Math.random, input.maxNoise);
    return {
        ...input.state,
        baseLevel,
        spreading,
        noise,
        suppression,
        total: baseLevel + spreading + noise - suppression,
        lastComputedAt: input.now.toISOString()
    };
}
export function applyIgnoreSuppression(state, amount) {
    return { ...state, suppression: state.suppression + amount };
}
export function clearsRetrievalThreshold(totalActivation, threshold) {
    return totalActivation > threshold;
}
export function recordReference(state, at, capacity = DEFAULT_REFERENCE_LOG_CAPACITY) {
    return { ...state, references: [...state.references, at.toISOString()].slice(-Math.max(1, capacity)) };
}
//# sourceMappingURL=activation.js.map