import type { EmbeddingRuntimeConfig } from "../config.js";

export interface EncodedEmbedding {
  provider: EmbeddingRuntimeConfig["provider"] | "feature-hash";
  model: string;
  dimensions: number;
  vector: number[];
  generatedAt: string;
  fallback: boolean;
}

// Encoder vectors memoised for the process. A vector is a pure function of
// the encoder, the purpose and the text, so a memoised one can never be
// stale; only texts not yet embedded are requested. From the developed
// version (failed work, docs/experiments/amplification/), 2026-10-21.
export const embeddingOptions = { memo: true };
const VECTORS = new Map<string, number[]>();
const MEMO_LIMIT = 50_000;

export class EmbeddingClient {
  async embed(config: EmbeddingRuntimeConfig, texts: readonly string[], purpose: "query" | "document"): Promise<number[][]> {
    if (!texts.length) return [];
    if (!embeddingOptions.memo) return this.embedLive(config, texts, purpose);
    const keyOf = (text: string) => `${config.provider}:${config.model}\u0000${purpose}\u0000${text}`;
    const missing = [...new Set(texts.filter((text) => !VECTORS.has(keyOf(text))))];
    const fresh = missing.length ? await this.embedLive(config, missing, purpose) : [];
    if (VECTORS.size + missing.length > MEMO_LIMIT) VECTORS.clear();
    missing.forEach((text, index) => VECTORS.set(keyOf(text), fresh[index]!));
    return texts.map((text) => VECTORS.get(keyOf(text)) ?? fresh[missing.indexOf(text)]!);
  }

  private async embedLive(config: EmbeddingRuntimeConfig, texts: readonly string[], purpose: "query" | "document"): Promise<number[][]> {
    if (!texts.length) return [];
    const prefixed = texts.map((text) => `${purpose === "query" ? "search_query" : "search_document"}: ${text}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKeyEnv) {
        const key = process.env[config.apiKeyEnv];
        if (key) headers.authorization = `Bearer ${key}`;
      }
      const url = config.provider === "ollama"
        ? `${trimUrl(config.baseUrl)}/api/embed`
        : `${trimUrl(config.baseUrl).replace(/\/v1$/i, "")}/v1/embeddings`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, input: prefixed, ...(config.provider === "ollama" && config.device === "cpu" ? { options: { num_gpu: 0 } } : {}) }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Embedding service returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = await response.json() as Record<string, unknown>;
      const raw = config.provider === "ollama"
        ? body.embeddings
        : Array.isArray(body.data) ? body.data.map((item) => isRecord(item) ? item.embedding : undefined) : undefined;
      if (!Array.isArray(raw) || raw.length !== texts.length) throw new TypeError("Embedding service returned an invalid vector count");
      const vectors = raw.map((entry) => normalizeVector(entry));
      const dimensions = vectors[0]?.length ?? 0;
      if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) throw new TypeError("Embedding service returned inconsistent dimensions");
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new TypeError("Embedding service returned a non-numeric vector");
  }
  const magnitude = Math.sqrt(value.reduce((sum, item) => sum + Number(item) ** 2, 0));
  if (!magnitude) throw new TypeError("Embedding service returned a zero vector");
  return value.map((item) => Number(item) / magnitude);
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
