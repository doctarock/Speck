// Chooses the tools the Tool Caller is shown for one message (see
// src/cognition/toolbelt.ts). Each tool's card and its baseline similarity to
// no-tool messages are encoded once and kept until the registered tools
// change; each message costs one encoding.
import { cosine, selectToolbelt, standardised, toolCard, TOOLBELT_REFERENCE } from "../../cognition/toolbelt.js";
import { EmbeddingClient } from "../../memory/embedding.js";
export class Toolbelt {
    config;
    encoder;
    cache = null;
    // encoder replaces the configured one (tests, probes).
    constructor(config, encoder = null) {
        this.config = config;
        this.encoder = encoder;
    }
    // The toolbelt for a topic, or null when the encoder is unavailable: the
    // caller then shows every tool, as before there was a toolbelt.
    async select(input) {
        if (!input.tools.length)
            return { tools: [], reasons: {}, relevance: new Map() };
        const encode = this.encoder ?? this.configuredEncoder();
        if (!encode)
            return null;
        try {
            const cards = input.tools.map(toolCard);
            const key = cards.join("\u0000");
            if (this.cache?.key !== key) {
                const vectors = await encode(cards, "document");
                const references = await encode([...TOOLBELT_REFERENCE], "query");
                const baselines = vectors.map((vector) => {
                    const scores = references.map((reference) => cosine(vector, reference));
                    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
                    return { mean, sd: Math.sqrt(scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length) };
                });
                this.cache = { key, vectors, baselines };
            }
            const [topic] = await encode([input.topic], "query");
            if (!topic)
                return null;
            const { vectors, baselines } = this.cache;
            const relevance = new Map(input.tools.map((tool, index) => [tool.name, standardised(cosine(topic, vectors[index]), baselines[index])]));
            return { ...selectToolbelt({ tools: input.tools, relevance, topic: input.topic, ...(input.usedTools ? { usedTools: input.usedTools } : {}) }), relevance };
        }
        catch {
            return null;
        }
    }
    configuredEncoder() {
        const config = this.config();
        if (!config.enabled)
            return null;
        const client = new EmbeddingClient();
        return (texts, purpose) => client.embed(config, texts, purpose);
    }
}
//# sourceMappingURL=toolbelt.js.map