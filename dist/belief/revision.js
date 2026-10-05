import { HYPOTHESIS_STATUSES } from "./types.js";
export function reviseHypothesis(input) {
    const { hypothesis, relation, config } = input;
    if (hypothesis.kind !== "hypothesis")
        throw new TypeError("Belief revision target must be a hypothesis");
    const supportingEvidence = stringIds(hypothesis.data.supportingEvidence);
    const contradictoryEvidence = stringIds(hypothesis.data.contradictoryEvidence);
    if (supportingEvidence.includes(input.evidenceId) || contradictoryEvidence.includes(input.evidenceId)) {
        return { hypothesis, revision: null };
    }
    const strength = bounded(relation.strength ?? 1, "evidence relation strength");
    const reliability = bounded(input.reliability, "evidence reliability");
    const previousStatus = hypothesisStatus(hypothesis.data.status);
    if (!config.enabled)
        return { hypothesis, revision: null };
    const refuted = relation.direction === "contradicts" && relation.decisive === true;
    const magnitude = refuted ? hypothesis.confidence - config.minConfidenceFloor
        : (relation.direction === "supports" ? config.supportBonus : config.contradictionPenalty) * reliability * strength;
    const confidence = relation.direction === "supports"
        ? Math.min(1, hypothesis.confidence + magnitude)
        : Math.max(config.minConfidenceFloor, hypothesis.confidence - magnitude);
    const status = refuted && previousStatus !== "superseded" ? "rejected" : statusAfter(previousStatus, confidence, relation.direction, config);
    const revision = {
        evidenceId: input.evidenceId,
        direction: relation.direction,
        reliability,
        strength,
        delta: relation.direction === "supports" ? magnitude : -magnitude,
        previousConfidence: hypothesis.confidence,
        newConfidence: confidence,
        previousStatus,
        newStatus: status,
        source: input.source,
        at: input.at
    };
    const history = Array.isArray(hypothesis.data.revisionHistory)
        ? hypothesis.data.revisionHistory.slice(-(config.revisionHistoryCapacity - 1))
        : [];
    return {
        hypothesis: {
            ...hypothesis,
            confidence,
            data: {
                ...hypothesis.data,
                status,
                supportingEvidence: relation.direction === "supports" ? [...supportingEvidence, input.evidenceId] : supportingEvidence,
                contradictoryEvidence: relation.direction === "contradicts" ? [...contradictoryEvidence, input.evidenceId] : contradictoryEvidence,
                revisionHistory: [...history, revision],
                lastUpdatedAt: input.at
            },
            lastAccessedAt: input.at
        },
        revision
    };
}
export function rankHypotheses(hypotheses) {
    return [...hypotheses].sort((left, right) => right.confidence - left.confidence
        || statusRank(hypothesisStatus(right.data.status)) - statusRank(hypothesisStatus(left.data.status))
        || evidenceBalance(right) - evidenceBalance(left)
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id));
}
export function hypothesisStatus(value) {
    return HYPOTHESIS_STATUSES.includes(value) ? value : "proposed";
}
function statusAfter(previous, confidence, direction, config) {
    if (previous === "superseded")
        return previous;
    if (direction === "supports") {
        if (confidence >= config.confirmationThreshold)
            return "confirmed";
        if (confidence >= config.supportedThreshold)
            return "supported";
        return "active";
    }
    if (previous === "confirmed" && confidence > config.demotionConfidenceThreshold)
        return "confirmed";
    if (confidence <= config.demotionConfidenceThreshold)
        return "rejected";
    return "weakening";
}
function evidenceBalance(object) {
    return stringIds(object.data.supportingEvidence).length - stringIds(object.data.contradictoryEvidence).length;
}
function statusRank(status) {
    return { confirmed: 6, supported: 5, active: 4, proposed: 3, weakening: 2, rejected: 1, superseded: 0 }[status];
}
function stringIds(value) {
    return Array.isArray(value) ? value.map(String) : [];
}
function bounded(value, label) {
    if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new RangeError(`${label} must be between 0 and 1`);
    return value;
}
//# sourceMappingURL=revision.js.map