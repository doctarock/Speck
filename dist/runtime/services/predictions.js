// The predictive loop: predictions are stated before an outcome is known,
// compared with what was observed, and the error moves the worker's pressure
// and operational mode.
import { comparePrediction, validatePredictionSpec } from "../../prediction/compare.js";
import { bounded, isRecord, RuntimeService } from "../core.js";
export class PredictionService extends RuntimeService {
    runtime;
    constructor(core, runtime) {
        super(core);
        this.runtime = runtime;
    }
    async createPrediction(input) {
        if (!this.config.predictiveLoop.enabled)
            throw new TypeError("Predictive loop is disabled");
        validatePredictionSpec(input.spec);
        const object = await this.runtime.createMentalObject({
            workerId: input.workerId,
            kind: "prediction",
            content: input.spec.description,
            data: { prediction: { status: "pending", spec: structuredClone(input.spec), comparison: null, observationId: null } },
            confidence: input.spec.confidence,
            importance: 0.5,
            memoryRoles: this.runtime.memoryAdmissionPolicy.predictionEpisodes ? ["episodic"] : [],
            actor: input.actor ?? { kind: "runtime", source: "predictive-loop" }
        });
        const now = new Date().toISOString();
        const event = this.makeEvent(input.workerId, "prediction.created", {
            predictionId: object.id, sourceChannel: input.spec.sourceChannel
        }, input.actor ?? {}, now);
        await this.eventBus.dispatch(this.database.transaction(() => this.eventBus.persist(event)));
        return object;
    }
    async comparePredictionToObservation(input) {
        if (!this.config.predictiveLoop.enabled)
            throw new TypeError("Predictive loop is disabled");
        const currentWorker = this.workers.require(input.workerId);
        const prediction = this.requireOwnedObject(input.workerId, input.predictionId);
        const observation = this.requireOwnedObject(input.workerId, input.observationId);
        const predictionState = isRecord(prediction.data.prediction) ? prediction.data.prediction : null;
        if (!predictionState || prediction.kind !== "prediction" || !isPredictionSpec(predictionState.spec)) {
            throw new TypeError("Mental object is not a structured prediction");
        }
        if (predictionState.status !== "pending")
            throw new TypeError("Prediction has already been compared");
        const actual = input.actual ?? { kind: observation.kind, content: observation.content, data: observation.data };
        const comparison = this.computePredictionComparison(input.workerId, prediction.id, predictionState.spec, actual);
        const now = comparison.comparedAt;
        const updatedPrediction = {
            ...prediction,
            data: { ...prediction.data, prediction: { ...predictionState, status: "resolved", comparison, observationId: observation.id } },
            lastAccessedAt: now
        };
        const updatedObservation = {
            ...observation,
            data: { ...observation.data, predictionComparison: comparison, predictionId: prediction.id },
            importance: Math.max(observation.importance, comparison.errorMagnitude),
            lastAccessedAt: now
        };
        const updatedWorker = this.applyPredictionEffects(currentWorker, comparison, now);
        const event = this.makeEvent(input.workerId, "prediction.compared", {
            predictionId: prediction.id, observationId: observation.id,
            errorMagnitude: comparison.errorMagnitude,
            precision: comparison.precision,
            precisionWeightedSurprise: comparison.precisionWeightedSurprise,
            verdict: comparison.verdict,
            pressure: updatedWorker.operationalState.pressure,
            mode: updatedWorker.operationalState.mode
        }, input.actor ?? {}, now);
        const persistedEvent = this.database.transaction(() => {
            this.mentalObjects.update(updatedPrediction);
            this.mentalObjects.update(updatedObservation);
            this.workers.update(updatedWorker, currentWorker.revision);
            return this.eventBus.persist(event);
        });
        await this.eventBus.dispatch(persistedEvent);
        this.telemetry.increment(`predictions.${comparison.verdict}`);
        return { prediction: updatedPrediction, observation: updatedObservation, comparison, worker: updatedWorker };
    }
    computePredictionComparison(workerId, predictionId, spec, actual) {
        const previousErrors = this.mentalObjects.listForWorker(workerId).flatMap((object) => {
            if (object.id === predictionId || object.kind !== "prediction" || !isRecord(object.data.prediction))
                return [];
            const state = object.data.prediction;
            if (!isPredictionSpec(state.spec) || state.spec.sourceChannel !== spec.sourceChannel || !isPredictionComparison(state.comparison))
                return [];
            return [state.comparison.errorMagnitude];
        });
        const comparison = comparePrediction(spec, actual, previousErrors, this.config.predictiveLoop);
        return isRecord(actual) && actual.actualOutcome === "unknown-outcome"
            ? { ...comparison, verdict: "uncertain" }
            : comparison;
    }
    applyPredictionEffects(worker, comparison, now) {
        const config = this.config.predictiveLoop;
        const pressure = bounded(Math.min(1, Math.max(0, worker.operationalState.pressure
            + comparison.errorMagnitude * config.pressureGain
            - (1 - comparison.errorMagnitude) * config.pressureRelief)), "pressure");
        const mode = comparison.verdict === "uncertain"
            || pressure >= config.conservativePressureThreshold
            ? "conservative"
            : comparison.errorMagnitude >= config.highErrorThreshold || pressure >= config.focusedPressureThreshold
                ? "focused"
                : "normal";
        const madeProgress = comparison.verdict === "confirmed";
        return {
            ...worker,
            progress: {
                ...worker.progress,
                score: worker.progress.score + (madeProgress ? (1 - comparison.errorMagnitude) * config.progressGain : 0),
                lastProgressAt: madeProgress ? now : worker.progress.lastProgressAt
            },
            operationalState: { mode, pressure },
            updatedAt: now,
            revision: worker.revision + 1
        };
    }
}
export function isPredictionSpec(value) {
    if (!isRecord(value))
        return false;
    return typeof value.description === "string"
        && typeof value.confidence === "number"
        && typeof value.sourceChannel === "string"
        && Array.isArray(value.conditions);
}
export function isPredictionComparison(value) {
    return isRecord(value)
        && typeof value.errorMagnitude === "number"
        && typeof value.precision === "number"
        && typeof value.precisionWeightedSurprise === "number"
        && typeof value.epistemicValue === "number"
        && typeof value.comparedAt === "string";
}
export function predictionSignals(object) {
    const direct = object.data.predictionComparison;
    const nested = isRecord(object.data.prediction) ? object.data.prediction.comparison : null;
    const comparison = isPredictionComparison(direct) ? direct : isPredictionComparison(nested) ? nested : null;
    return comparison ? { surprise: Math.min(1, Math.max(0, comparison.precisionWeightedSurprise)) } : {};
}
//# sourceMappingURL=predictions.js.map