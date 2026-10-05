export function createStandardVariants(processor, input = {}) {
    if (!processor || !processor.id.trim() || !processor.provider.trim())
        throw new TypeError("Benchmark processor requires id and provider");
    if (!Number.isInteger(processor.tier) || processor.tier < 0)
        throw new RangeError("Benchmark processor tier must be a non-negative integer");
    if (!Number.isFinite(processor.parametersBillions) || processor.parametersBillions < 0)
        throw new RangeError("Benchmark processor size must be non-negative");
    const comparisonGroup = input.comparisonGroup ?? `model:${processor.id}`;
    const allowedProcessors = input.allowedProcessors ?? [processor];
    const base = input.baseConfig ?? {};
    const make = (id, architecture, ablations, config) => ({
        schema: "speck-benchmark-variant/v1", id, comparisonGroup, architecture,
        primaryProcessor: { ...processor }, allowedProcessors: allowedProcessors.map((entry) => ({ ...entry })), allowEscalation: input.allowEscalation ?? false,
        config, ablations
    });
    return [
        make(`${processor.id}:minimal`, "minimal-agent", ["all-speck-cognition"], {}),
        make(`${processor.id}:speck-full`, "speck", [], base),
        make(`${processor.id}:minus-base-activation`, "speck", ["base-activation"], merge(base, { memoryActivation: { baseLevelEnabled: false } })),
        make(`${processor.id}:minus-spreading`, "speck", ["spreading-activation"], merge(base, { memoryActivation: { spreadingActivationEnabled: false } })),
        make(`${processor.id}:minus-procedures`, "speck", ["procedures"], merge(base, { procedures: { enabled: false } })),
        make(`${processor.id}:minus-belief-revision`, "speck", ["belief-revision"], merge(base, { beliefRevision: { enabled: false } })),
        make(`${processor.id}:minus-predictions`, "speck", ["predictive-loop"], merge(base, { predictiveLoop: { enabled: false } })),
        make(`${processor.id}:minus-metacognition`, "speck", ["metacognition"], merge(base, { metacognition: { enabled: false } })),
        make(`${processor.id}:minus-impasse-detection`, "speck", ["impasse-detection"], merge(base, { metacognition: { impasseDetectionEnabled: false } })),
        make(`${processor.id}:minus-escalation`, "speck", ["model-escalation"], merge(base, { modelEscalation: { enabled: false } })),
        make(`${processor.id}:minus-background`, "speck", ["background-cognition"], merge(base, { backgroundCognition: { enabled: false } })),
        make(`${processor.id}:minus-coordination`, "speck", ["parallel-coordination"], merge(base, { coordination: { enabled: false } }))
    ];
}
function merge(base, patch) {
    const result = { ...base, ...patch };
    for (const key of Object.keys(patch)) {
        const left = base[key];
        const right = patch[key];
        if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
            result[key] = { ...left, ...right };
        }
    }
    return result;
}
//# sourceMappingURL=ablations.js.map