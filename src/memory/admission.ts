export interface MemoryAdmissionPolicy {
  rawPrompts: boolean;
  ordinaryConversation: boolean;
  intakeRouting: boolean;
  reasoningCycles: boolean;
  validatorResponses: boolean;
  ordinaryCompletions: boolean;
  predictionEpisodes: boolean;
}

export const DEFAULT_MEMORY_ADMISSION_POLICY: MemoryAdmissionPolicy = {
  rawPrompts: false,
  ordinaryConversation: false,
  intakeRouting: false,
  reasoningCycles: false,
  validatorResponses: false,
  ordinaryCompletions: false,
  predictionEpisodes: false
};

export function normalizeMemoryAdmissionPolicy(value: unknown): MemoryAdmissionPolicy {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.keys(DEFAULT_MEMORY_ADMISSION_POLICY).map((key) => [key, input[key] === true])) as unknown as MemoryAdmissionPolicy;
}
