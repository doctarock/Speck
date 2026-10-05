export const DEFAULT_MEMORY_ADMISSION_POLICY = {
    rawPrompts: false,
    ordinaryConversation: false,
    intakeRouting: false,
    reasoningCycles: false,
    validatorResponses: false,
    ordinaryCompletions: false,
    predictionEpisodes: false
};
export function normalizeMemoryAdmissionPolicy(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.fromEntries(Object.keys(DEFAULT_MEMORY_ADMISSION_POLICY).map((key) => [key, input[key] === true]));
}
//# sourceMappingURL=admission.js.map