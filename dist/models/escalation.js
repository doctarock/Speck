export function routeEscalation(input) {
    const specialty = input.specialty?.trim().toLowerCase();
    const candidates = input.processors.filter((processor) => processor.enabled && processor.available
        && processor.tier > input.fromTier
        && processor.tier <= input.config.maximumTier
        && processor.contextSize >= (input.minimumContextSize ?? 0));
    candidates.sort((left, right) => (specialty ? Number(right.specialties.includes(specialty)) - Number(left.specialties.includes(specialty)) : 0)
        || left.tier - right.tier
        || effectiveReliability(right, input.calibration) - effectiveReliability(left, input.calibration)
        || modelCost(left) - modelCost(right)
        || left.id.localeCompare(right.id));
    const processor = candidates[0];
    if (!processor)
        throw new TypeError("No available higher-tier processor satisfies the escalation request");
    return {
        processor,
        fromTier: input.fromTier,
        toTier: processor.tier,
        reliability: effectiveReliability(processor, input.calibration),
        reason: `smallest available tier above ${input.fromTier}`
    };
}
export class TierScheduler {
    capacities;
    inFlight = new Map();
    constructor(capacities) {
        this.capacities = capacities;
    }
    tryAcquire(tier) {
        const capacity = Math.max(1, Math.floor(this.capacities[tier] ?? 1));
        const current = this.inFlight.get(tier) ?? 0;
        if (current >= capacity)
            return null;
        this.inFlight.set(tier, current + 1);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.inFlight.set(tier, Math.max(0, (this.inFlight.get(tier) ?? 1) - 1));
        };
    }
    snapshot() {
        return Object.entries(this.capacities).map(([tierValue, capacityValue]) => {
            const tier = Number(tierValue);
            const capacity = Math.max(1, Math.floor(capacityValue));
            const inFlight = this.inFlight.get(tier) ?? 0;
            return { tier, capacity, inFlight, available: Math.max(0, capacity - inFlight) };
        }).sort((a, b) => a.tier - b.tier);
    }
}
function effectiveReliability(processor, profiles) {
    return profiles?.[processor.id]?.reliability ?? processor.historicalReliability;
}
function modelCost(processor) {
    return (processor.costPerMillionInputTokens ?? 0) + (processor.costPerMillionOutputTokens ?? 0);
}
//# sourceMappingURL=escalation.js.map