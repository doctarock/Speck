export class EmbeddingClient {
    async embed(config, texts, purpose) {
        if (!texts.length)
            return [];
        const prefixed = texts.map((text) => `${purpose === "query" ? "search_query" : "search_document"}: ${text}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
            const headers = { "content-type": "application/json" };
            if (config.apiKeyEnv) {
                const key = process.env[config.apiKeyEnv];
                if (key)
                    headers.authorization = `Bearer ${key}`;
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
            if (!response.ok)
                throw new Error(`Embedding service returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
            const body = await response.json();
            const raw = config.provider === "ollama"
                ? body.embeddings
                : Array.isArray(body.data) ? body.data.map((item) => isRecord(item) ? item.embedding : undefined) : undefined;
            if (!Array.isArray(raw) || raw.length !== texts.length)
                throw new TypeError("Embedding service returned an invalid vector count");
            const vectors = raw.map((entry) => normalizeVector(entry));
            const dimensions = vectors[0]?.length ?? 0;
            if (!dimensions || vectors.some((vector) => vector.length !== dimensions))
                throw new TypeError("Embedding service returned inconsistent dimensions");
            return vectors;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
function normalizeVector(value) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
        throw new TypeError("Embedding service returned a non-numeric vector");
    }
    const magnitude = Math.sqrt(value.reduce((sum, item) => sum + Number(item) ** 2, 0));
    if (!magnitude)
        throw new TypeError("Embedding service returned a zero vector");
    return value.map((item) => Number(item) / magnitude);
}
function trimUrl(value) {
    return value.replace(/\/+$/, "");
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=embedding.js.map