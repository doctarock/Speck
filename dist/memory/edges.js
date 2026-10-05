// Direct TypeScript translation of ACA aca-graph/src/edges.rs.
export const DEFAULT_HEBBIAN_INCREMENT = 0.15;
export const DEFAULT_MAX_EDGE_STRENGTH = 1;
export function reinforceEdge(edges, targetId, kind, at, increment = DEFAULT_HEBBIAN_INCREMENT, maxStrength = DEFAULT_MAX_EDGE_STRENGTH) {
    const existingIndex = edges.findIndex((edge) => edge.targetId === targetId && edge.kind === kind);
    if (existingIndex < 0) {
        return [...edges, { targetId, kind, strength: Math.min(increment, maxStrength), lastCoactivatedAt: at.toISOString() }];
    }
    return edges.map((edge, index) => index === existingIndex ? {
        ...edge,
        strength: Math.min(edge.strength + increment, maxStrength),
        lastCoactivatedAt: at.toISOString()
    } : edge);
}
export function effectiveStrength(edge, now, decayRatePerMs) {
    const elapsedMs = Math.max(0, now.getTime() - new Date(edge.lastCoactivatedAt).getTime());
    return edge.strength * Math.exp(-decayRatePerMs * elapsedMs);
}
//# sourceMappingURL=edges.js.map