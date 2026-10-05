// Long-term memory: recording and retrieving memories (shared across workers
// or local to one), reinforcing references and associations, domain links,
// embeddings, and grounding a user's stated facts in their past statements.
import { NotFoundError } from "../../errors.js";
import { recordReference } from "../../memory/activation.js";
import { findDomainAnchor, reinforceDomainLink, domainCloudAnchors } from "../../memory/domain-anchors.js";
import { reinforceEdge } from "../../memory/edges.js";
import { ActivationGraph } from "../../memory/graph.js";
import { recall } from "../../memory/recall.js";
import { EmbeddingClient } from "../../memory/embedding.js";
import { featureHashEmbedding, normalize } from "../../background/maintenance.js";
import { EDGE_KINDS } from "../../types/model.js";
import { groundFacts } from "../../memory/grounding.js";
import { isRecord, RuntimeService } from "../core.js";
export class MemoryService extends RuntimeService {
    runtime;
    embeddingClient = new EmbeddingClient();
    constructor(core, runtime) {
        super(core);
        this.runtime = runtime;
    }
    async recordSharedMemory(input) {
        if (input.type !== "episodic" && input.type !== "semantic")
            throw new TypeError(`Unknown memory type: ${String(input.type)}`);
        const content = input.content.trim();
        if (!content)
            throw new TypeError("Shared memory content is required");
        if (input.sourceWorkerId)
            this.workers.require(input.sourceWorkerId);
        const scope = input.scope ?? "global";
        if (!["global", "project", "domain", "session"].includes(scope))
            throw new TypeError(`Unknown shared memory scope: ${String(scope)}`);
        const scopeKey = String(input.scopeKey ?? "").trim() || null;
        if (scope !== "global" && !scopeKey)
            throw new TypeError(`${scope} shared memory requires a scope key`);
        const audience = [...new Set(input.audience ?? ["intake", "planner", "worker"])]
            .filter((role) => ["intake", "planner", "worker"].includes(role));
        if (!audience.length)
            throw new TypeError("Shared memory requires at least one audience role");
        const duplicate = this.mentalObjects.listAll().find((object) => object.workerId === null
            && object.status !== "archived"
            && object.memoryRoles.includes(input.type)
            && normalize(object.content) === normalize(content)
            && readSharedMemory(object)?.scope === scope
            && readSharedMemory(object)?.scopeKey === scopeKey);
        if (duplicate) {
            const definition = readSharedMemory(duplicate);
            const updated = {
                ...duplicate,
                data: { ...duplicate.data, sharedMemory: { ...definition, audience: [...new Set([...definition.audience, ...audience])] } },
                confidence: Math.max(duplicate.confidence, input.confidence ?? duplicate.confidence),
                importance: Math.max(duplicate.importance, input.importance ?? duplicate.importance),
                lastAccessedAt: new Date().toISOString()
            };
            this.mentalObjects.update(updated);
            this.telemetry.increment("shared_memory.reinforced");
            return updated;
        }
        const embedding = await this.encodeTexts([content], "document");
        const object = await this.runtime.createMentalObject({
            kind: input.type === "episodic" ? "observation" : "fact",
            content,
            data: {
                ...(input.data ?? {}),
                sharedMemory: {
                    schema: "speck.shared-memory.v1",
                    scope,
                    scopeKey,
                    audience,
                    sourceWorkerId: input.sourceWorkerId ?? null
                },
                embedding: embedding[0]
            },
            confidence: input.confidence ?? (input.type === "semantic" ? 0.8 : 0.7),
            importance: input.importance ?? 0.7,
            memoryRoles: [input.type],
            actor: input.actor ?? { kind: "runtime", source: "shared-memory" }
        });
        this.telemetry.increment("shared_memory.recorded");
        return object;
    }
    async retrieveSharedMemories(input) {
        const query = input.query.trim();
        if (!query)
            return [];
        if (input.role && !["intake", "planner", "worker"].includes(input.role))
            throw new TypeError(`Unknown shared memory audience: ${String(input.role)}`);
        const allowedScopes = input.scopes ?? [{ scope: "global" }];
        const queryEmbedding = (await this.encodeTexts([query], "query"))[0];
        const selected = this.mentalObjects.listAll()
            .filter((object) => object.workerId === null && (object.status === "active" || object.status === "dormant"))
            .map((object) => ({ object, definition: readSharedMemory(object) }))
            .filter((entry) => entry.definition !== null)
            .filter(({ definition }) => !input.role || definition.audience.includes(input.role))
            .filter(({ definition }) => !input.excludeSourceWorkerId || definition.sourceWorkerId !== input.excludeSourceWorkerId)
            .filter(({ definition }) => allowedScopes.some((allowed) => allowed.scope === definition.scope
            && (allowed.scope === "global" || String(allowed.scopeKey ?? "") === String(definition.scopeKey ?? ""))))
            .map(({ object }) => ({ object, score: semanticRetrievalScore(query, queryEmbedding, object) }))
            .filter((entry) => entry.score >= 0.15)
            .sort((left, right) => right.score - left.score
            || right.object.importance - left.object.importance
            || right.object.confidence - left.object.confidence
            || left.object.id.localeCompare(right.object.id))
            .slice(0, Math.max(0, Math.min(50, Math.floor(input.limit ?? 8))));
        this.telemetry.increment("shared_memory.retrievals");
        this.telemetry.increment("shared_memory.retrieved_objects", selected.length);
        return selected;
    }
    async importSharedMemories(input) {
        this.workers.require(input.workerId);
        const existing = this.mentalObjects.listForWorker(input.workerId);
        const importedSourceIds = new Set(existing.map((object) => isRecord(object.data.sharedMemoryImport)
            ? String(object.data.sharedMemoryImport.sourceId ?? "") : "").filter(Boolean));
        const selected = await this.retrieveSharedMemories({
            query: input.query,
            role: input.role,
            excludeSourceWorkerId: input.workerId,
            ...(input.limit === undefined ? {} : { limit: input.limit })
        });
        const imported = [];
        for (const { object: source, score } of selected) {
            if (importedSourceIds.has(source.id))
                continue;
            const copy = await this.runtime.createMentalObject({
                workerId: input.workerId,
                kind: source.kind,
                content: source.content,
                data: {
                    ...source.data,
                    sharedMemoryImport: {
                        schema: "speck.shared-memory-import.v1",
                        sourceId: source.id,
                        scope: readSharedMemory(source)?.scope ?? "global",
                        relevance: score
                    }
                },
                confidence: source.confidence,
                importance: source.importance,
                memoryRoles: [...source.memoryRoles],
                actor: input.actor ?? { kind: "runtime", source: "shared-memory-retrieval" }
            });
            imported.push(copy);
        }
        if (imported.length) {
            await this.runtime.competeForWorkingMemory({
                workerId: input.workerId,
                candidateIds: imported.map((object) => object.id),
                actor: input.actor ?? { kind: "runtime", source: "shared-memory-retrieval" }
            });
        }
        this.telemetry.increment("shared_memory.imported", imported.length);
        return imported;
    }
    async archiveSharedMemory(id, actor = {}) {
        const current = this.mentalObjects.get(id);
        if (!current || current.workerId !== null || !readSharedMemory(current))
            throw new NotFoundError("SharedMemory", id);
        const now = new Date().toISOString();
        const updated = { ...current, status: "archived", lastAccessedAt: now };
        const event = this.makeEvent(null, "shared-memory.archived", { objectId: id }, actor, now);
        const persisted = this.database.transaction(() => {
            this.mentalObjects.update(updated);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persisted);
        this.telemetry.increment("shared_memory.archived");
        return updated;
    }
    async reinforceMemoryReference(workerId, objectId, actor = {}, at = new Date()) {
        this.workers.require(workerId);
        const current = this.requireOwnedObject(workerId, objectId);
        const now = at.toISOString();
        const updated = {
            ...current,
            activation: this.config.memoryActivation.referenceReinforcementEnabled
                ? recordReference(current.activation, at, this.config.memoryActivation.referenceLogCapacity)
                : current.activation,
            lastAccessedAt: now
        };
        const event = this.makeEvent(workerId, "memory.referenced", { objectId }, actor, now);
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.update(updated);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("memory.references");
        return updated;
    }
    async reinforceAssociation(input) {
        this.workers.require(input.workerId);
        if (input.sourceId === input.targetId)
            throw new TypeError("An association cannot target its source object");
        const source = this.requireOwnedObject(input.workerId, input.sourceId);
        this.requireOwnedObject(input.workerId, input.targetId);
        const at = input.at ?? new Date();
        const kind = input.kind ?? "associative";
        if (!EDGE_KINDS.includes(kind))
            throw new TypeError(`Unknown edge kind: ${String(kind)}`);
        const updated = {
            ...source,
            associations: this.config.memoryActivation.associativeEdgesEnabled
                ? reinforceEdge(source.associations, input.targetId, kind, at, this.config.memoryActivation.hebbianIncrement, this.config.memoryActivation.maxEdgeStrength)
                : source.associations,
            lastAccessedAt: at.toISOString()
        };
        const event = this.makeEvent(input.workerId, "association.reinforced", {
            sourceId: input.sourceId, targetId: input.targetId, kind
        }, input.actor ?? {}, at.toISOString());
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.update(updated);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("memory.associations.reinforced");
        return updated;
    }
    async retrieveMemories(input) {
        const worker = this.workers.require(input.workerId);
        const anchorIds = [...new Set(input.anchorIds ?? worker.workingMemory)];
        for (const id of anchorIds)
            this.requireOwnedObject(input.workerId, id);
        const excluded = new Set(input.excludedIds ?? []);
        const graph = new ActivationGraph(this.mentalObjects.listForWorker(input.workerId));
        const now = input.now ?? new Date();
        const config = this.config.memoryActivation;
        const winners = config.associativeEdgesEnabled
            ? recall(graph, new Set(anchorIds), excluded, {
                maxHops: config.spreadingActivationEnabled ? config.maxHops : 0,
                edgeDecayRatePerMs: config.edgeDecayEnabled ? config.edgeDecayRatePerMs : 0,
                retrievalThreshold: config.retrievalThreshold,
                maxNoise: config.maxNoise,
                baseLevelEnabled: config.baseLevelEnabled,
                spreadingActivationEnabled: config.spreadingActivationEnabled,
                inhibitionEnabled: config.inhibitionEnabled
            }, now)
            : [];
        const limit = Math.max(0, Math.floor(input.limit ?? 10));
        const query = input.query?.trim() ?? "";
        const scores = new Map();
        for (const id of winners)
            scores.set(id, graph.get(id)?.activation.total ?? 0);
        if (query) {
            const queryEmbedding = (await this.encodeTexts([query], "query"))[0];
            for (const object of graph.values()) {
                if (object.status === "archived" || excluded.has(object.id) || anchorIds.includes(object.id))
                    continue;
                scores.set(object.id, Math.max(scores.get(object.id) ?? 0, semanticRetrievalScore(query, queryEmbedding, object)));
            }
        }
        const selected = [...scores]
            .map(([id, score]) => ({ object: graph.get(id), score }))
            .filter((entry) => Boolean(entry.object))
            .sort((left, right) => right.score - left.score
            || right.object.importance - left.object.importance
            || right.object.confidence - left.object.confidence
            || left.object.id.localeCompare(right.object.id))
            .slice(0, limit);
        if (config.referenceReinforcementEnabled) {
            for (const { object } of selected) {
                object.activation = recordReference(object.activation, now, config.referenceLogCapacity);
                object.lastAccessedAt = now.toISOString();
            }
        }
        const touched = [...new Map([...graph.values()]
                .filter((object) => object.activation.lastComputedAt === now.toISOString() || selected.some((entry) => entry.object.id === object.id))
                .map((object) => [object.id, object])).values()];
        const event = this.makeEvent(input.workerId, "memory-activation", {
            anchorIds,
            candidateIds: selected.map(({ object }) => object.id),
            query: query || null,
            maxHops: config.spreadingActivationEnabled ? config.maxHops : 0
        }, input.actor ?? {}, now.toISOString());
        const persistedEvent = this.database.transaction(() => {
            for (const object of touched)
                this.mentalObjects.update(object);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment("memory.retrievals");
        this.telemetry.increment("memory.retrieved_objects", selected.length);
        return {
            workerId: input.workerId,
            anchorIds,
            candidates: selected.map(({ object, score }) => ({ object, activation: score })),
            computedAt: now.toISOString()
        };
    }
    async linkMemoryToDomain(input) {
        if (!this.config.memoryActivation.domainAnchorsEnabled)
            throw new TypeError("Domain anchors are disabled");
        if (!this.config.memoryActivation.associativeEdgesEnabled)
            throw new TypeError("Associative edges are disabled");
        const domain = input.domain.trim().toLowerCase();
        const key = input.key.trim().toLowerCase();
        if (!domain || !key)
            throw new TypeError("Domain and key are required");
        this.requireOwnedObject(input.workerId, input.objectId);
        let graph = new ActivationGraph(this.mentalObjects.listForWorker(input.workerId));
        let anchorId = findDomainAnchor(graph, domain, key);
        if (!anchorId) {
            const created = await this.runtime.createMentalObject({
                workerId: input.workerId,
                kind: "belief",
                content: `Domain anchor for ${domain}:${key}`,
                data: { domainAnchor: { domain, key } },
                memoryRoles: ["semantic"],
                confidence: 1,
                importance: 0,
                ...(input.actor ? { actor: input.actor } : {})
            });
            anchorId = created.id;
            graph = new ActivationGraph(this.mentalObjects.listForWorker(input.workerId));
        }
        const at = input.at ?? new Date();
        reinforceDomainLink(graph, input.objectId, anchorId, at, this.config.memoryActivation.referenceLogCapacity, this.config.memoryActivation.hebbianIncrement, this.config.memoryActivation.maxEdgeStrength, this.config.memoryActivation.referenceReinforcementEnabled);
        const object = graph.get(input.objectId);
        const anchor = graph.get(anchorId);
        const event = this.makeEvent(input.workerId, "association.reinforced", {
            sourceId: input.objectId, targetId: anchorId, kind: "derived-from", domain, key
        }, input.actor ?? {}, at.toISOString());
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.update(object);
            this.mentalObjects.update(anchor);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        return { anchor, object };
    }
    async retrieveDomainMemories(input) {
        if (!this.config.memoryActivation.domainAnchorsEnabled)
            throw new TypeError("Domain anchors are disabled");
        this.workers.require(input.workerId);
        const graph = new ActivationGraph(this.mentalObjects.listForWorker(input.workerId));
        const anchorId = findDomainAnchor(graph, input.domain.trim().toLowerCase(), input.key.trim().toLowerCase());
        if (!anchorId)
            return { workerId: input.workerId, anchorIds: [], candidates: [], computedAt: (input.now ?? new Date()).toISOString() };
        const cloud = domainCloudAnchors(graph, anchorId);
        return this.retrieveMemories({
            workerId: input.workerId,
            anchorIds: [...cloud],
            excludedIds: [anchorId],
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.actor ? { actor: input.actor } : {}),
            ...(input.now ? { now: input.now } : {})
        });
    }
    async encodeTexts(texts, purpose) {
        if (!texts.length)
            return [];
        const config = this.config.embeddingRuntime;
        if (config.enabled) {
            try {
                const vectors = [];
                for (let offset = 0; offset < texts.length; offset += config.batchSize) {
                    vectors.push(...await this.embeddingClient.embed(config, texts.slice(offset, offset + config.batchSize), purpose));
                }
                this.telemetry.increment("embeddings.model_calls");
                this.telemetry.increment("embeddings.encoded", vectors.length);
                this.telemetry.gauge("embeddings.dimensions", vectors[0]?.length ?? config.dimensions);
                return vectors.map((vector) => ({
                    provider: config.provider, model: config.model, dimensions: vector.length, vector,
                    generatedAt: new Date().toISOString(), fallback: false
                }));
            }
            catch (error) {
                this.telemetry.increment("embeddings.model_failures");
                if (!config.allowHashFallback)
                    throw error;
            }
        }
        this.telemetry.increment("embeddings.hash_fallback", texts.length);
        return texts.map((text) => ({
            provider: "feature-hash", model: "speck-feature-hash-v1",
            dimensions: this.config.backgroundCognition.embeddingDimensions,
            vector: featureHashEmbedding(text, this.config.backgroundCognition.embeddingDimensions),
            generatedAt: new Date().toISOString(), fallback: true
        }));
    }
    // Decides which candidate facts the user actually stated, against a
    // baseline built from the user's other past statements in memory, and
    // records every decision as evidence for later learning (S1, S5).
    async groundFacts(input) {
        if (!input.facts.length)
            return [];
        const { decisions, encoder } = await groundFacts({
            facts: input.facts,
            statement: input.statement,
            pastStatements: this.pastUserStatements(input.workerId),
            encoder: {
                encode: async (texts) => {
                    const encoded = await this.encodeTexts(texts, "document");
                    const first = encoded[0];
                    return { vectors: encoded.map((entry) => entry.vector), encoder: first ? `${first.provider}:${first.model}` : "none" };
                }
            }
        });
        const grounded = decisions.filter((decision) => decision.grounded).length;
        await this.runtime.createMentalObject({
            workerId: input.workerId,
            kind: "observation",
            content: `Grounded ${grounded} of ${decisions.length} candidate facts (${decisions[0]?.method ?? "none"}).`,
            data: { grounding: { statement: input.statement, encoder, decisions } },
            memoryRoles: [], confidence: 1, importance: 0.3,
            actor: input.actor ?? { kind: "runtime", source: "grounding" }
        });
        return decisions;
    }
    // The user's past statements, most recent first: task objectives and the
    // user side of recorded conversations, across all workers but this one's
    // current objective.
    pastUserStatements(workerId) {
        const current = this.workers.require(workerId).objective.description;
        const statements = [];
        for (const worker of this.workers.list()) {
            if (worker.id !== workerId)
                statements.push({ text: worker.objective.description, at: worker.createdAt });
            const turns = worker.worldState["genesis.conversationTurns"]?.value;
            if (Array.isArray(turns)) {
                for (const turn of turns) {
                    if (turn && typeof turn === "object" && turn.role === "user") {
                        statements.push({ text: String(turn.content ?? ""), at: worker.updatedAt });
                    }
                }
            }
        }
        return statements.filter((entry) => entry.text.trim() && entry.text !== current)
            .sort((left, right) => right.at.localeCompare(left.at)).map((entry) => entry.text);
    }
}
function semanticRetrievalScore(query, queryEmbedding, object) {
    const queryTokens = new Set(normalize(query).split(" ").filter(Boolean));
    const objectTokens = new Set(normalize(object.content).split(" ").filter(Boolean));
    const overlap = queryTokens.size === 0 ? 0 : [...queryTokens].filter((token) => objectTokens.has(token)).length / queryTokens.size;
    const stored = isRecord(object.data.embedding) ? object.data.embedding : null;
    const embedding = stored && Array.isArray(stored.vector)
        ? stored.vector.filter((value) => typeof value === "number" && Number.isFinite(value)) : [];
    const compatible = stored?.model === queryEmbedding.model && stored?.provider === queryEmbedding.provider
        && embedding.length === queryEmbedding.vector.length;
    const similarity = compatible
        ? Math.max(0, embedding.reduce((sum, value, index) => sum + value * (queryEmbedding.vector[index] ?? 0), 0)) : 0;
    return compatible
        ? 0.75 * similarity + 0.15 * overlap + 0.06 * object.importance + 0.04 * object.confidence
        : 0.75 * overlap + 0.15 * object.importance + 0.1 * object.confidence;
}
function readSharedMemory(object) {
    const value = object.data.sharedMemory;
    if (!isRecord(value) || value.schema !== "speck.shared-memory.v1")
        return null;
    const scope = String(value.scope ?? "");
    if (!(scope === "global" || scope === "project" || scope === "domain" || scope === "session"))
        return null;
    const audience = Array.isArray(value.audience)
        ? value.audience.map(String).filter((role) => role === "intake" || role === "planner" || role === "worker")
        : [];
    if (!audience.length)
        return null;
    return {
        schema: "speck.shared-memory.v1",
        scope,
        scopeKey: value.scopeKey === null || value.scopeKey === undefined ? null : String(value.scopeKey),
        audience,
        sourceWorkerId: value.sourceWorkerId ? String(value.sourceWorkerId) : null
    };
}
//# sourceMappingURL=memory.js.map