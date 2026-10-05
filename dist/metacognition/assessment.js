import { createHash } from "node:crypto";
export function emptyMetacognitiveState() {
    return { cyclesWithoutProgress: 0, repeatedStateCount: 0, lastSignature: null, cycleHistory: [], activeImpasseId: null, lastAssessmentAt: null };
}
export function cognitiveStateSignature(worker, objects, action, error) {
    const byId = new Map(objects.map((object) => [object.id, object]));
    const state = {
        workingMemory: [...worker.workingMemory].sort(),
        strategy: worker.currentStrategy,
        procedure: worker.currentProcedure,
        worldState: Object.fromEntries(Object.entries(worker.worldState).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, entry.value])),
        hypotheses: worker.hypotheses.map((id) => byId.get(id)).filter(Boolean).map((object) => ({ id: object.id, confidence: rounded(object.confidence), status: object.data.status })),
        action: action?.trim() || null,
        error: error?.trim() || null
    };
    return createHash("sha256").update(stableJson(state)).digest("hex").slice(0, 24);
}
export function assessCycle(input) {
    const previous = input.worker.metacognition ?? emptyMetacognitiveState();
    const action = input.action?.trim() || null;
    const error = input.error?.trim() || null;
    const signature = cognitiveStateSignature(input.worker, input.objects, action, error);
    const topConfidence = input.objects.filter((object) => input.worker.hypotheses.includes(object.id) && object.status !== "rejected")
        .sort((a, b) => b.confidence - a.confidence)[0]?.confidence ?? null;
    const cyclesWithoutProgress = input.madeProgress ? 0 : previous.cyclesWithoutProgress + 1;
    let lastProgressIndex = -1;
    for (let index = previous.cycleHistory.length - 1; index >= 0; index -= 1) {
        if (previous.cycleHistory[index].madeProgress) {
            lastProgressIndex = index;
            break;
        }
    }
    const sinceProgress = previous.cycleHistory.slice(lastProgressIndex + 1);
    const repeatedStateCount = input.madeProgress ? 0 : sinceProgress.filter((entry) => entry.signature === signature).length + 1;
    const sample = {
        cycle: input.worker.progress.cycle + 1,
        signature,
        madeProgress: input.madeProgress,
        score: input.worker.progress.score,
        evidenceCount: input.worker.evidence.length,
        hypothesisConfidence: topConfidence,
        action,
        error,
        recordedAt: input.at
    };
    const history = [...previous.cycleHistory, sample].slice(-input.config.historyCapacity);
    const recent = history.slice(-input.config.stagnationCycles);
    const reasons = [];
    const add = (reason, condition) => { if (condition && !reasons.includes(reason))
        reasons.push(reason); };
    const unresolvedHistory = input.madeProgress ? [] : [...sinceProgress, sample];
    add("loop-detected", !input.madeProgress && (repeatedStateCount >= input.config.repeatedStateThreshold || periodicTail(unresolvedHistory, input.config.patternRepeatThreshold)));
    add("progress-stagnation", !input.madeProgress && cyclesWithoutProgress >= input.config.stagnationCycles);
    add("repeated-failure", !input.madeProgress && repeatedPairCount(unresolvedHistory, action, error) >= input.config.repeatedFailureThreshold);
    add("confidence-stagnation", !input.madeProgress && recent.length >= input.config.stagnationCycles && confidenceRange(recent) <= input.config.confidenceStagnationEpsilon);
    add("no-new-evidence", !input.madeProgress && recent.length >= input.config.stagnationCycles && recent.every((entry) => entry.evidenceCount === recent[0].evidenceCount));
    add("no-valid-action", !input.madeProgress && input.validAction === false);
    add("strategy-exhausted", !input.madeProgress && input.strategyExhausted === true);
    add("required-resource-unavailable", !input.madeProgress && input.resourceAvailable === false);
    add("procedure-invalid", !input.madeProgress && input.procedureValid === false);
    add("world-model-insufficient", !input.madeProgress && input.worldModelSufficient === false);
    const hypotheses = input.objects.filter((object) => input.worker.hypotheses.includes(object.id));
    add("hypotheses-exhausted", !input.madeProgress && hypotheses.length > 0 && hypotheses.every((object) => object.status === "rejected" || object.data.status === "rejected"));
    add("confidence-too-low", !input.madeProgress && (input.worker.confidence.calibrated ?? input.worker.confidence.overall) < input.config.lowConfidenceThreshold);
    // A hypothesis the evidence has already rejected is a settled conflict,
    // not an open one.
    const settled = (object) => ["rejected", "superseded"].includes(String(object.data.status)) || object.status === "rejected";
    add("conflicting-evidence", !input.madeProgress && hypotheses.some((object) => !settled(object) && Array.isArray(object.data.supportingEvidence) && object.data.supportingEvidence.length > 0
        && Array.isArray(object.data.contradictoryEvidence) && object.data.contradictoryEvidence.length > 0
        && object.confidence < input.config.lowConfidenceThreshold));
    const state = {
        cyclesWithoutProgress,
        repeatedStateCount,
        lastSignature: signature,
        cycleHistory: history,
        activeImpasseId: previous.activeImpasseId,
        lastAssessmentAt: input.at
    };
    return {
        assessment: {
            signature,
            cyclesWithoutProgress,
            repeatedStateCount,
            reasons,
            responses: responsesFor(reasons),
            signals: { evidenceCount: input.worker.evidence.length, hypothesisConfidence: topConfidence, action, error }
        },
        state,
        sample
    };
}
function responsesFor(reasons) {
    const result = [];
    const add = (response) => { if (!result.includes(response))
        result.push(response); };
    for (const reason of reasons) {
        if (["no-new-evidence", "world-model-insufficient", "hypotheses-exhausted"].includes(reason))
            add("retrieve-additional-memories");
        if (reason === "no-new-evidence")
            add("expand-spreading-activation");
        if (["loop-detected", "progress-stagnation", "repeated-failure", "strategy-exhausted"].includes(reason))
            add("change-strategy");
        if (["no-valid-action", "world-model-insufficient", "hypotheses-exhausted"].includes(reason))
            add("spawn-subgoal");
        if (reason === "required-resource-unavailable")
            add("wait-for-dependency");
        if (["confidence-too-low", "conflicting-evidence", "confidence-stagnation"].includes(reason))
            add("request-planner-intervention");
    }
    if (reasons.length) {
        add("increase-model-tier");
        add("request-human-input");
    }
    return result;
}
function repeatedPairCount(history, action, error) {
    if (!action || !error)
        return 0;
    return history.filter((entry) => entry.action === action && entry.error === error).length;
}
function confidenceRange(history) {
    const values = history.map((entry) => entry.hypothesisConfidence).filter((value) => value !== null);
    return values.length === history.length ? Math.max(...values) - Math.min(...values) : Number.POSITIVE_INFINITY;
}
function periodicTail(history, requiredRepeats) {
    const values = history.map((entry) => entry.signature);
    // Single-state repetition has its own stricter threshold. Periodicity is
    // for genuine multi-state cycles such as A -> B -> A -> B.
    for (let length = 2; length <= Math.floor(values.length / requiredRepeats); length += 1) {
        const tail = values.slice(-length);
        let matches = true;
        for (let repeat = 2; repeat <= requiredRepeats; repeat += 1) {
            const candidate = values.slice(-length * repeat, -length * (repeat - 1));
            if (candidate.length !== length || candidate.some((value, index) => value !== tail[index])) {
                matches = false;
                break;
            }
        }
        if (matches)
            return true;
    }
    return false;
}
function rounded(value) { return Math.round(value * 1000) / 1000; }
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
    return JSON.stringify(value);
}
//# sourceMappingURL=assessment.js.map