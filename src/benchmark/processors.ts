// A processor for a model named on the command line (moved 2026-10-20 from the
// archived src/benchmark/compare.ts; used by the qualification probe).

import type { ConfiguredModelProcessor } from "../models/types.js";

// The parameter count a model's name states ("qwen3:4b"); 0 when the name is silent.
export function parametersInName(model: string): number {
  const stated = /(?:^|[:\-_/])(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model);
  return stated ? Number(stated[1]) * 1e9 : 0;
}

export const NLI_SIDECAR_URL = "http://127.0.0.1:8765";

// A model is named as Ollama names it, as a llama.cpp server's address with an
// optional label ("http://localhost:8001#Ling"), or as an NLI cross-encoder
// served by the sidecar in sidecars/nli ("nli:NAME", optionally "@http://host:port").
export function processorFor(model: string, configured: readonly ConfiguredModelProcessor[], baseUrl: string): ConfiguredModelProcessor {
  const existing = configured.find((processor) => processor.model === model);
  if (existing) return { ...existing, enabled: true };
  if (model.startsWith("nli:")) {
    const [name = "", address = NLI_SIDECAR_URL] = model.slice("nli:".length).split("@");
    return {
      id: `nli-${name}`.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
      provider: "nli", model: name, baseUrl: address, tier: 1, contextSize: 512,
      hardware: "local", specialties: ["atomic-entailment"], enabled: true
    } as ConfiguredModelProcessor;
  }
  if (/^https?:\/\//i.test(model)) {
    const [address = model, label = ""] = model.split("#");
    return {
      id: (label || address).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
      provider: "llama.cpp", model, baseUrl: address, tier: 1, contextSize: 32_768,
      hardware: "remote", specialties: ["general"], enabled: true
    } as ConfiguredModelProcessor;
  }
  return {
    id: model.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase(),
    provider: "ollama", model, baseUrl, tier: 1, contextSize: 32_768, runtimeContextSize: 4_096,
    hardware: "local", specialties: ["general", "tool-use"], enabled: true
  } as ConfiguredModelProcessor;
}
