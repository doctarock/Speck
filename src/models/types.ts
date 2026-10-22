export type ModelTier = 1 | 2 | 3 | 4;
export type ModelProviderKind = "ollama" | "openai-compatible" | "llama.cpp" | "genesis" | "nli";

// A judgment-only processor (an NLI cross-encoder) answers one class of
// judgment and nothing else: it never fills a role, validates a reply or is
// chosen by default, and is reached only as a qualified checker.
export function judgmentOnly(descriptor: { provider: ModelProviderKind }): boolean {
  return descriptor.provider === "nli";
}

export interface JsonContractProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  enum?: Array<string | number | boolean>;
  // A list's items, and an object's own fields: declared, they are sent in
  // the schema the model's output is held to (from the developed version,
  // 2026-10-21: a list of objects declared only in prose came back without
  // the fields its description asked for).
  items?: JsonContractProperty;
  properties?: Record<string, JsonContractProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface StructuredOutputContract {
  name: string;
  description?: string;
  required: string[];
  properties: Record<string, JsonContractProperty>;
  additionalProperties?: boolean;
}

// A function definition in the provider's native tool-calling format (the
// JSON-schema "function" object used by Ollama and OpenAI-compatible APIs).
export interface NativeToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string | string[]; enum?: Array<string | number | boolean> }>;
    required: string[];
  };
}

export interface NativeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelRequest {
  prompt: string;
  temperature: number;
  contract?: StructuredOutputContract;
  timeoutMs: number;
  signal?: AbortSignal;
  // Present only when the processor supports native tool calling.
  system?: string;
  tools?: NativeToolDefinition[];
  // The judgment's operands as fields, for a processor that does not read a
  // prompt (an NLI cross-encoder takes a premise and a hypothesis).
  input?: Record<string, unknown>;
}

export interface ProcessorCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: NativeToolCall[];
}

export interface ModelProcessor {
  infer(request: ModelRequest): Promise<ProcessorCompletion>;
  supportsNativeTools?(): Promise<boolean>;
  // The context window to allocate when none is configured, as learned from
  // processor competence.
  setContextWindow?(tokens: number): void;
}

// One inference attempt as the registry saw it, for competence learning.
export interface InferenceObservation {
  processorId: string;
  model: string;
  contract: string | null;
  protocol: "native" | "json";
  outcome: "usable" | "contract" | "transport" | "context";
  tokens: number | null;
  latencyMs: number;
}

export interface ModelProcessorDescriptor {
  id: string;
  provider: ModelProviderKind;
  model: string;
  tier: ModelTier;
  parameters?: number;
  contextSize: number;
  speedTokensPerSecond?: number;
  costPerMillionInputTokens?: number;
  costPerMillionOutputTokens?: number;
  hardware?: string;
  specialties: string[];
  enabled: boolean;
}

export interface ModelProcessorSnapshot extends ModelProcessorDescriptor {
  calls: number;
  successes: number;
  failures: number;
  contractFailures: number;
  transportFailures: number;
  historicalReliability: number;
  available: boolean;
  lastError: string | null;
  lastFailureKind: "contract" | "transport" | "context" | null;
}

export interface ValidatedModelResponse {
  processorId: string;
  tier: ModelTier;
  text: string;
  structured: Record<string, unknown> | null;
  confidence: number;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalling?: "native" | "json";
}

export interface ConfiguredModelProcessor extends ModelProcessorDescriptor {
  baseUrl: string;
  apiKeyEnv?: string;
  // Context window actually allocated at run time (Ollama num_ctx). It may be
  // smaller than the model's trained contextSize to bound memory use.
  runtimeContextSize?: number;
  // Tool-calling protocol. "auto" uses the provider's native format when a
  // verification call shows it works; it is the default for Ollama, which
  // also reports the capability. OpenAI-compatible processors default to json.
  toolCalling?: "auto" | "native" | "json";
}
