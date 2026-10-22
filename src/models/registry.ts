import { ContextOverflowError } from "./providers.js";
import { contractInstruction, parseModelCompletion } from "./response.js";
import type {
  InferenceObservation, ModelProcessor, ModelProcessorDescriptor, ModelProcessorSnapshot, NativeToolCall, NativeToolDefinition,
  StructuredOutputContract, ValidatedModelResponse
} from "./types.js";
import { judgmentOnly } from "./types.js";

interface Entry {
  descriptor: ModelProcessorDescriptor;
  processor: ModelProcessor;
  calls: number;
  successes: number;
  failures: number;
  contractFailures: number;
  transportFailures: number;
  available: boolean;
  lastError: string | null;
  lastFailureKind: "contract" | "transport" | "context" | null;
}

export class ModelRegistry {
  private readonly entries = new Map<string, Entry>();
  // Receives every attempt; the runtime feeds processor competence from it.
  observer: ((observation: InferenceObservation) => void) | null = null;

  // Competence is held per model, not per processor id: pointing an id at a
  // different model starts its competence afresh.
  modelKey(id: string): string {
    const entry = this.entries.get(normalizeId(id));
    return entry ? `${entry.descriptor.provider}:${entry.descriptor.model}` : normalizeId(id);
  }

  processor(id: string): ModelProcessor | undefined { return this.entries.get(normalizeId(id))?.processor; }

  register(descriptor: ModelProcessorDescriptor, processor: ModelProcessor): void {
    const id = normalizeId(descriptor.id);
    if (!id) throw new TypeError("Model processor id is required");
    if (this.entries.has(id)) throw new TypeError(`Model processor "${id}" is already registered`);
    this.entries.set(id, {
      descriptor: { ...descriptor, id, specialties: [...new Set(descriptor.specialties.map((value) => value.toLowerCase()))] },
      processor, calls: 0, successes: 0, failures: 0, contractFailures: 0, transportFailures: 0,
      available: true, lastError: null, lastFailureKind: null
    });
  }

  upsert(descriptor: ModelProcessorDescriptor, processor: ModelProcessor): void {
    const id = normalizeId(descriptor.id);
    this.entries.delete(id);
    this.register({ ...descriptor, id }, processor);
  }

  has(id: string): boolean { return this.entries.has(normalizeId(id)); }

  remove(id: string): boolean { return this.entries.delete(normalizeId(id)); }

  list(): ModelProcessorSnapshot[] {
    return [...this.entries.values()].map(snapshot).sort((left, right) =>
      left.tier - right.tier || right.historicalReliability - left.historicalReliability || left.id.localeCompare(right.id)
    );
  }

  // The processors that write: every one but judgment-only processors, which
  // are reached only as qualified checkers (see judgmentOnly).
  generative(): ModelProcessorSnapshot[] {
    return this.list().filter((entry) => !judgmentOnly(entry));
  }

  select(input: { id?: string; specialty?: string; minimumContextSize?: number } = {}): ModelProcessorSnapshot {
    if (input.id) {
      const entry = this.entries.get(normalizeId(input.id));
      if (!entry || !entry.descriptor.enabled) throw new TypeError(`Model processor "${input.id}" is not configured`);
      return snapshot(entry);
    }
    const specialty = input.specialty?.trim().toLowerCase();
    const candidates = this.generative().filter((entry) => entry.enabled && entry.available
      && entry.contextSize >= (input.minimumContextSize ?? 0));
    candidates.sort((left, right) =>
      (specialty ? Number(right.specialties.includes(specialty)) - Number(left.specialties.includes(specialty)) : 0)
      || left.tier - right.tier
      || right.historicalReliability - left.historicalReliability
      || left.id.localeCompare(right.id)
    );
    const selected = candidates[0];
    if (!selected) throw new TypeError("No available model processor satisfies the request");
    return selected;
  }

  async supportsNativeTools(id: string): Promise<boolean> {
    const entry = this.entries.get(normalizeId(id));
    return entry?.processor.supportsNativeTools ? entry.processor.supportsNativeTools() : false;
  }

  async infer(input: {
    processorId?: string;
    specialty?: string;
    prompt: string;
    // With protocol "native" and tools, the processor's tool call (or its
    // absence) is converted into the contract's payload; the model never sees
    // the contract. The caller chooses the protocol (from competence).
    protocol?: "native" | "json";
    tools?: NativeToolDefinition[];
    system?: string;
    // Maps the native tool calls onto the contract's payload; by default the
    // first call becomes a tool intent.
    fromToolCalls?: (calls: NativeToolCall[]) => Record<string, unknown>;
    contract?: StructuredOutputContract;
    temperature?: number;
    timeoutMs?: number;
    maxAttempts?: number;
    signal?: AbortSignal;
    promptIncludesContract?: boolean;
    input?: Record<string, unknown>;
  }): Promise<ValidatedModelResponse> {
    const selected = this.select({
      ...(input.processorId ? { id: input.processorId } : {}),
      ...(input.specialty ? { specialty: input.specialty } : {})
    });
    const entry = this.entries.get(selected.id)!;
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 2));
    const native = input.protocol === "native" && Boolean(input.tools?.length);
    const observe = (outcome: InferenceObservation["outcome"], tokens: number | null, began: number) => {
      this.observer?.({
        processorId: selected.id, model: this.modelKey(selected.id), contract: input.contract?.name ?? null,
        protocol: native ? "native" : "json", outcome, tokens, latencyMs: Math.round(performance.now() - began)
      });
    };
    const basePrompt = input.contract && !input.promptIncludesContract && !native
      ? `${input.prompt}\n\n${contractInstruction(input.contract)}`
      : input.prompt;
    let prompt = basePrompt;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      entry.calls += 1;
      let completion;
      const began = performance.now();
      try {
        completion = await entry.processor.infer({
          prompt,
          temperature: Math.min(1.5, Math.max(0, input.temperature ?? 0.2)),
          timeoutMs: Math.max(1, Math.floor(input.timeoutMs ?? 120_000)),
          ...(input.contract ? { contract: input.contract } : {}),
          ...(native ? { tools: input.tools!, ...(input.system ? { system: input.system } : {}) } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.input ? { input: input.input } : {})
        });
      } catch (error) {
        // An overflow is Speck's prompt not fitting the window it configured:
        // neither a model failure nor an unavailable processor, and retrying
        // the same prompt cannot help.
        if (error instanceof ContextOverflowError) {
          observe("context", error.used, began);
          entry.failures += 1;
          entry.lastFailureKind = "context";
          entry.lastError = error.message;
          throw error;
        }
        observe("transport", null, began);
        entry.failures += 1;
        entry.transportFailures += 1;
        entry.lastFailureKind = "transport";
        entry.lastError = error instanceof Error ? error.message : String(error);
        lastError = error;
        if (attempt < maxAttempts) prompt = basePrompt;
        continue;
      }
      try {
        const payload = !native ? completion.text
          : input.fromToolCalls ? JSON.stringify(input.fromToolCalls(completion.toolCalls ?? []))
          : nativeToolPayload(completion.toolCalls);
        const parsed = parseModelCompletion(payload, input.contract);
        observe("usable", tokensOf(completion), began);
        entry.successes += 1;
        entry.available = true;
        entry.lastError = null;
        entry.lastFailureKind = null;
        return {
          processorId: selected.id, tier: selected.tier, text: parsed.text,
          structured: parsed.structured, confidence: parsed.confidence, attempts: attempt,
          inputTokens: completion.inputTokens ?? null, outputTokens: completion.outputTokens ?? null,
          toolCalling: native ? "native" : "json"
        };
      } catch (error) {
        observe("contract", tokensOf(completion), began);
        entry.failures += 1;
        entry.contractFailures += 1;
        entry.lastFailureKind = "contract";
        entry.lastError = error instanceof Error ? error.message : String(error);
        lastError = error;
        if (attempt < maxAttempts) {
          prompt = native
            ? `${basePrompt}\n\nThe previous tool call was not usable: ${entry.lastError}.`
            : `${basePrompt}\n\nYour previous reply was not usable: ${entry.lastError}. Reply again with the same meaning in the required JSON form.`;
        }
      }
    }
    // A structurally invalid completion does not mean that the processor is
    // unavailable. Only failures to reach or run the processor affect live
    // availability.
    entry.available = entry.lastFailureKind !== "transport";
    throw new Error(`Model processor "${selected.id}" failed${input.contract ? ` contract "${input.contract.name}"` : ""} after ${maxAttempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

function tokensOf(completion: { inputTokens?: number; outputTokens?: number }): number | null {
  return completion.inputTokens === undefined && completion.outputTokens === undefined
    ? null : (completion.inputTokens ?? 0) + (completion.outputTokens ?? 0);
}

// The first native tool call becomes Speck's tool-intent payload; a reply with
// no tool call means no tool needs to run. One operation is taken per cycle.
export function nativeToolPayload(calls: readonly NativeToolCall[] | undefined): string {
  const call = calls?.[0];
  return JSON.stringify(call ? { intent: call.name, arguments: call.arguments } : { intent: "none", arguments: {} });
}

function snapshot(entry: Entry): ModelProcessorSnapshot {
  return {
    ...entry.descriptor,
    calls: entry.calls,
    successes: entry.successes,
    failures: entry.failures,
    contractFailures: entry.contractFailures,
    transportFailures: entry.transportFailures,
    historicalReliability: entry.successes + entry.transportFailures === 0
      ? 0.5 : entry.successes / (entry.successes + entry.transportFailures),
    available: entry.available,
    lastError: entry.lastError,
    lastFailureKind: entry.lastFailureKind
  };
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
