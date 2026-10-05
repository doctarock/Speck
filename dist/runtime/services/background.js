// Background cognition: consolidation and maintenance run in slices between
// foreground work (patterns, procedures, embeddings, calibration, associations).
import { effectiveStrength } from "../../memory/edges.js";
import { readProcedure } from "../../procedure/engine.js";
import { maintenanceKey, mean, normalize } from "../../background/maintenance.js";
import { isRecord, RuntimeService } from "../core.js";
export class BackgroundCognitionService extends RuntimeService {
    runtime;
    backgroundCursor = 0;
    constructor(core, runtime) {
        super(core);
        this.runtime = runtime;
    }
    beginForegroundWork() {
        this.telemetry.increment("foreground.leases");
        return this.runtime.backgroundScheduler.beginForeground();
    }
    async runBackgroundCognition(input = {}) {
        const selected = input.workerId ? [this.workers.require(input.workerId)] : this.workers.list();
        const taskFactories = selected.flatMap((worker) => [
            () => this.consolidateWorker(worker.id),
            () => this.synthesizePatterns(worker.id),
            () => this.maintainProcedures(worker.id),
            () => this.maintainCalibration(worker.id),
            () => this.maintainAssociations(worker.id),
            () => this.generateEmbeddings(worker.id)
        ]);
        const rotated = rotate(taskFactories, this.backgroundCursor).map((run) => ({ run }));
        const result = await this.runtime.backgroundScheduler.runSlice(rotated, {
            enabled: this.config.backgroundCognition.enabled,
            maximumOperations: this.config.backgroundCognition.maximumOperationsPerSlice,
            timeBudgetMs: this.config.backgroundCognition.timeBudgetMs
        });
        if (taskFactories.length > 0 && result.processed > 0) {
            this.backgroundCursor = (this.backgroundCursor + result.processed) % taskFactories.length;
        }
        this.telemetry.increment(`background.${result.status}`);
        this.telemetry.increment("background.operations", result.processed);
        this.telemetry.gauge("background.last_elapsed_ms", result.elapsedMs);
        return result;
    }
    async consolidateWorker(workerId) {
        this.workers.require(workerId);
        const objects = this.mentalObjects.listForWorker(workerId);
        const episodes = objects.filter((object) => object.status === "active" && object.memoryRoles.includes("episodic") && object.kind === "observation");
        const groups = new Map();
        for (const episode of episodes) {
            const key = maintenanceKey(episode, "consolidationKey");
            if (!key)
                continue;
            const semanticContent = typeof episode.data.semanticContent === "string" ? episode.data.semanticContent.trim() : episode.content.trim();
            const compound = `${key}\u0000${normalize(semanticContent)}`;
            groups.set(compound, [...(groups.get(compound) ?? []), episode]);
        }
        const existing = objects.filter((object) => object.kind === "fact" && object.data.schema === "speck-consolidation/v1");
        const eligible = [...groups.entries()].filter(([, sources]) => sources.length >= this.config.backgroundCognition.consolidationMinimumEpisodes
            && mean(sources.map((source) => source.confidence)) >= this.config.backgroundCognition.consolidationMinimumConfidence).sort(([left], [right]) => left.localeCompare(right));
        const createdIds = [];
        for (const [compound, sources] of eligible.slice(0, this.config.backgroundCognition.maximumItemsPerOperation)) {
            const [key] = compound.split("\u0000");
            const semanticContent = typeof sources[0].data.semanticContent === "string" ? String(sources[0].data.semanticContent).trim() : sources[0].content;
            if (existing.some((object) => object.data.key === key && normalize(object.content) === normalize(semanticContent)))
                continue;
            const contradiction = existing.find((object) => object.data.key === key && normalize(object.content) !== normalize(semanticContent));
            const created = await this.runtime.createMentalObject({
                workerId,
                kind: contradiction ? "error" : "fact",
                content: contradiction ? `Consolidation contradiction: ${semanticContent} conflicts with ${contradiction.content}` : semanticContent,
                data: contradiction ? {
                    schema: "speck-consolidation-contradiction/v1", key, existingId: contradiction.id,
                    sourceIds: sources.map((source) => source.id)
                } : {
                    schema: "speck-consolidation/v1", key, sourceIds: sources.map((source) => source.id),
                    episodeCount: sources.length, averageConfidence: mean(sources.map((source) => source.confidence))
                },
                confidence: contradiction ? 0.5 : mean(sources.map((source) => source.confidence)),
                importance: 0.7,
                memoryRoles: contradiction ? ["episodic"] : ["semantic"],
                actor: { kind: "runtime", source: "background-consolidation" }
            });
            createdIds.push(created.id);
        }
        return this.backgroundResult("consolidation", workerId, episodes.length, createdIds.length, createdIds);
    }
    async synthesizePatterns(workerId) {
        this.workers.require(workerId);
        const objects = this.mentalObjects.listForWorker(workerId);
        const groups = new Map();
        for (const object of objects) {
            if (object.status !== "active" || !object.memoryRoles.includes("episodic"))
                continue;
            const key = maintenanceKey(object, "patternKey");
            if (key)
                groups.set(key, [...(groups.get(key) ?? []), object]);
        }
        const existingKeys = new Set(objects.filter((object) => object.kind === "artifact" && object.data.schema === "speck-pattern/v1").map((object) => String(object.data.key)));
        const eligible = [...groups.entries()].filter(([key, sources]) => !existingKeys.has(key) && sources.length >= this.config.backgroundCognition.patternMinimumEpisodes)
            .sort(([left], [right]) => left.localeCompare(right));
        const createdIds = [];
        for (const [key, sources] of eligible.slice(0, this.config.backgroundCognition.maximumItemsPerOperation)) {
            const artifact = await this.runtime.createMentalObject({
                workerId, kind: "artifact", content: `Repeated pattern: ${key}`,
                data: { schema: "speck-pattern/v1", key, sourceIds: sources.map((source) => source.id), occurrences: sources.length },
                confidence: Math.min(1, sources.length / (this.config.backgroundCognition.patternMinimumEpisodes * 2)),
                importance: 0.6, memoryRoles: ["semantic"], actor: { kind: "runtime", source: "background-pattern-synthesis" }
            });
            createdIds.push(artifact.id);
        }
        return this.backgroundResult("pattern-synthesis", workerId, objects.length, createdIds.length, createdIds);
    }
    async maintainProcedures(workerId) {
        this.workers.require(workerId);
        if (!this.config.procedures.enabled)
            return this.backgroundResult("procedure-compilation", workerId, 0, 0, []);
        const objects = this.mentalObjects.listForWorker(workerId).filter((object) => object.status === "active" && readProcedure(object));
        const byTrigger = new Map();
        for (const object of objects) {
            const trigger = readProcedure(object).trigger.value;
            byTrigger.set(trigger, [...(byTrigger.get(trigger) ?? []), object]);
        }
        const updates = [];
        const now = new Date().toISOString();
        for (const group of byTrigger.values()) {
            const eligible = group.filter((object) => readProcedure(object).verifiedSuccesses >= this.config.procedures.compilationThreshold);
            const signatures = new Set(eligible.map((object) => String(object.data.signature)));
            for (const object of group) {
                if (updates.length >= this.config.backgroundCognition.maximumItemsPerOperation)
                    break;
                const definition = readProcedure(object);
                if (definition.status === "deprecated")
                    continue;
                const desired = eligible.includes(object) && signatures.size === 1 ? "compiled" : "candidate";
                const ambiguous = signatures.size > 1;
                if (definition.status === desired && Boolean(object.data.ambiguous) === ambiguous)
                    continue;
                updates.push({
                    ...object,
                    data: { ...object.data, status: desired, ambiguous },
                    confidence: Math.min(1, definition.verifiedSuccesses / this.config.procedures.compilationThreshold),
                    lastAccessedAt: now
                });
            }
        }
        await this.persistBackgroundObjectUpdates(workerId, "procedure-compilation", updates, now);
        return this.backgroundResult("procedure-compilation", workerId, objects.length, updates.length, updates.map((object) => object.id));
    }
    async generateEmbeddings(workerId) {
        this.workers.require(workerId);
        const objects = this.mentalObjects.listForWorker(workerId);
        const desiredProvider = this.config.embeddingRuntime.enabled ? this.config.embeddingRuntime.provider : "feature-hash";
        const desiredModel = this.config.embeddingRuntime.enabled ? this.config.embeddingRuntime.model : "speck-feature-hash-v1";
        const candidates = objects.filter((object) => object.status !== "archived" && (!isRecord(object.data.embedding)
            || object.data.embedding.model !== desiredModel || object.data.embedding.provider !== desiredProvider))
            .slice(0, this.config.backgroundCognition.maximumItemsPerOperation);
        const now = new Date().toISOString();
        const encoded = await this.runtime.memory.encodeTexts(candidates.map((object) => object.content), "document");
        const updates = candidates.map((object, index) => ({
            ...object,
            data: { ...object.data, embedding: encoded[index] },
            lastAccessedAt: now
        }));
        await this.persistBackgroundObjectUpdates(workerId, "embedding-generation", updates, now);
        return this.backgroundResult("embedding-generation", workerId, objects.length, updates.length, updates.map((object) => object.id));
    }
    async maintainCalibration(workerId) {
        const worker = this.workers.require(workerId);
        const profiles = worker.confidence.calibration ?? {};
        const now = new Date().toISOString();
        const repaired = Object.fromEntries(Object.entries(profiles).map(([id, profile]) => {
            const samples = profile.samples.slice(-this.config.metacognition.calibrationWindow);
            const bias = mean(samples.map((sample) => sample.reportedConfidence - sample.reward));
            const meanAbsoluteError = mean(samples.map((sample) => Math.abs(sample.reportedConfidence - sample.reward)));
            return [id, { ...profile, samples, bias, meanAbsoluteError, reliability: Math.max(0, Math.min(1, 1 - meanAbsoluteError)), updatedAt: now }];
        }));
        const changed = Object.entries(repaired).some(([id, profile]) => {
            const current = profiles[id];
            return !current || JSON.stringify({ samples: current.samples, bias: current.bias, meanAbsoluteError: current.meanAbsoluteError, reliability: current.reliability })
                !== JSON.stringify({ samples: profile.samples, bias: profile.bias, meanAbsoluteError: profile.meanAbsoluteError, reliability: profile.reliability });
        });
        if (changed) {
            const updated = { ...worker, confidence: { ...worker.confidence, calibration: repaired }, updatedAt: now, revision: worker.revision + 1 };
            const event = this.makeEvent(workerId, "background.maintenance", { kind: "calibration-maintenance", changed: Object.keys(repaired).length }, { kind: "runtime", source: "background-cognition" }, now);
            const persisted = this.database.transaction(() => {
                this.workers.update(updated, worker.revision);
                return this.eventBus.persist(event);
            });
            await this.eventBus.dispatch(persisted);
        }
        return this.backgroundResult("calibration-maintenance", workerId, Object.keys(profiles).length, changed ? Object.keys(repaired).length : 0, []);
    }
    async maintainAssociations(workerId) {
        this.workers.require(workerId);
        const objects = this.mentalObjects.listForWorker(workerId);
        const owned = new Set(objects.map((object) => object.id));
        const nowDate = new Date();
        const now = nowDate.toISOString();
        const updates = [];
        let examined = 0;
        for (const object of objects) {
            if (updates.length >= this.config.backgroundCognition.maximumItemsPerOperation)
                break;
            if (object.associations.length === 0)
                continue;
            examined += object.associations.length;
            const associations = object.associations.filter((edge) => owned.has(edge.targetId)
                && effectiveStrength(edge, nowDate, this.config.memoryActivation.edgeDecayRatePerMs) >= this.config.backgroundCognition.associationPruneThreshold);
            if (associations.length !== object.associations.length)
                updates.push({ ...object, associations, lastAccessedAt: now });
        }
        await this.persistBackgroundObjectUpdates(workerId, "association-maintenance", updates, now);
        return this.backgroundResult("association-maintenance", workerId, examined, updates.length, updates.map((object) => object.id));
    }
    async persistBackgroundObjectUpdates(workerId, kind, updates, now) {
        if (updates.length === 0)
            return;
        const event = this.makeEvent(workerId, "background.maintenance", { kind, objectIds: updates.map((object) => object.id), changed: updates.length }, { kind: "runtime", source: "background-cognition" }, now);
        const persisted = this.database.transaction(() => {
            for (const object of updates)
                this.mentalObjects.update(object);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persisted);
    }
    backgroundResult(kind, workerId, examined, changed, createdIds) {
        this.telemetry.increment(`background.${kind}.changed`, changed);
        return { kind, workerId, examined, changed, createdIds };
    }
}
function rotate(values, offset) {
    if (values.length === 0)
        return [];
    const index = ((offset % values.length) + values.length) % values.length;
    return [...values.slice(index), ...values.slice(0, index)];
}
//# sourceMappingURL=background.js.map