import type { ModelProcessor, ModelProcessorDescriptor, ModelRequest, ModelTier, ProcessorCompletion } from "./types.js";

type Capability = (input?: any) => any;

export async function registerGenesisBrainProcessors(input: {
  registry: { upsert(descriptor: ModelProcessorDescriptor, processor: ModelProcessor): void };
  listBrains: Capability;
  generate: Capability;
}): Promise<number> {
  const brains = await input.listBrains({ includeDisabled: true });
  if (!Array.isArray(brains)) return 0;
  for (const brain of brains) {
    const id = `genesis.${normalizeId(String(brain.id ?? brain.model ?? "brain"))}`;
    const descriptor: ModelProcessorDescriptor = {
      id,
      provider: "genesis",
      model: String(brain.model ?? brain.id ?? ""),
      tier: inferTier(brain),
      ...(Number.isFinite(Number(brain.parameters)) ? { parameters: Number(brain.parameters) } : {}),
      contextSize: positiveInteger(brain.contextSize, 8_192),
      ...(Number.isFinite(Number(brain.speedTokensPerSecond)) ? { speedTokensPerSecond: Number(brain.speedTokensPerSecond) } : {}),
      ...(String(brain.hardware ?? "").trim() ? { hardware: String(brain.hardware).trim() } : {}),
      specialties: String(brain.specialty ?? "general").split(/[,\s]+/).filter(Boolean),
      enabled: brain.enabled !== false
    };
    input.registry.upsert(descriptor, new GenesisBrainProcessor(String(brain.id ?? ""), input.generate));
  }
  return brains.length;
}

class GenesisBrainProcessor implements ModelProcessor {
  constructor(private readonly brainId: string, private readonly generate: Capability) {}

  async infer(request: ModelRequest): Promise<ProcessorCompletion> {
    const result = await this.generate({
      brainId: this.brainId,
      prompt: request.prompt,
      timeoutMs: request.timeoutMs,
      options: { temperature: request.temperature },
      ...(request.contract ? { format: "json" } : {}),
      ...(request.signal ? { signal: request.signal } : {})
    });
    if (!result?.ok) throw new Error(String(result?.stderr ?? result?.error ?? "Genesis brain generation failed"));
    if (typeof result.text !== "string" || !result.text.trim()) throw new TypeError("Genesis brain returned no text");
    return { text: result.text };
  }
}

function inferTier(brain: any): ModelTier {
  const explicit = Number(brain?.tier);
  if ([1, 2, 3, 4].includes(explicit)) return explicit as ModelTier;
  const text = `${brain?.model ?? ""} ${brain?.description ?? ""}`;
  const billions = Number(text.match(/(\d+(?:\.\d+)?)\s*b\b/i)?.[1] ?? 0);
  if (billions >= 32) return 4;
  if (billions >= 14) return 3;
  if (billions >= 7) return 2;
  return 1;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "brain";
}
