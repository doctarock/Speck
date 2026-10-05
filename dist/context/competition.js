import { reinforceEdge } from "../memory/edges.js";
// Direct translation of ACA steps/coalition.rs::attention_score.
export function attentionScore(activationTotal, surprise) {
    return activationTotal + (surprise ?? 0);
}
// Speck extension: ACA's activation + surprise score with configurable
// plan-level signals that are already represented by Speck state.
export function scoreCandidate(object, signals, config) {
    return config.activationWeight * object.activation.total
        + config.surpriseWeight * (signals.surprise ?? 0)
        + config.importanceWeight * object.importance
        + config.confidenceWeight * object.confidence
        + config.taskRelevanceWeight * (signals.taskRelevance ?? 0)
        + config.noveltyWeight * (signals.novelty ?? 0)
        + config.evidenceValueWeight * (signals.evidenceValue ?? 0)
        + config.unresolvedPressureWeight * (signals.unresolvedPressure ?? 0)
        - config.redundancyWeight * (signals.redundancy ?? 0);
}
// Direct counterpart of ACA steps/coalition.rs::form_coalition.
export function formCoalition(objects, signals, config) {
    return objects.map((object) => {
        const score = config.candidateRankingEnabled
            ? scoreCandidate(object, signals.get(object.id) ?? {}, config)
            : object.activation.total;
        return { id: object.id, score, rawScore: score };
    }).filter((candidate) => Number.isFinite(candidate.score) && candidate.score > config.attentionThreshold);
}
// Direct translation of ACA's divisive crowding normalization.
export function applyCrowdingNormalization(candidates, crowdingStrength) {
    const strength = Math.max(0, crowdingStrength);
    if (strength === 0)
        return candidates.map((candidate) => ({ ...candidate }));
    const totalPositive = candidates.reduce((sum, candidate) => sum + Math.max(0, candidate.score), 0);
    return candidates.map((candidate) => {
        const othersPositive = totalPositive - Math.max(0, candidate.score);
        return { ...candidate, score: candidate.score / (1 + strength * othersPositive) };
    });
}
// Direct counterpart of ACA aca-graph/src/ranking.rs.
export function rankCandidates(candidates) {
    return [...candidates].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
// Direct counterpart of ACA steps/broadcast.rs::decide_admission_with_hysteresis.
export function decideAdmissionWithHysteresis(candidates, previousWorkingMemory, capacity, ignitionThreshold) {
    const eligible = candidates.filter((candidate) => previousWorkingMemory.has(candidate.id) || candidate.score >= ignitionThreshold);
    return rankCandidates(eligible).slice(0, Math.max(0, capacity));
}
// Direct ACA broadcast bookkeeping, adapted to Speck's persisted objects.
export function broadcast(graph, coalition, admitted, previousWorkingMemory, now, config, hebbianIncrement, maxEdgeStrength) {
    const ids = admitted.map((candidate) => candidate.id);
    const admittedSet = new Set(ids);
    const newlyAdmitted = ids.filter((id) => !previousWorkingMemory.has(id));
    const released = [...previousWorkingMemory].filter((id) => !admittedSet.has(id));
    for (const candidate of admitted) {
        const object = graph.get(candidate.id);
        if (!object)
            continue;
        const wasInWorkingMemory = object.workspace.inWorkingMemory;
        object.workspace = {
            attentionScore: candidate.score,
            inWorkingMemory: true,
            broadcastCount: object.workspace.broadcastCount + (wasInWorkingMemory ? 0 : 1),
            lastBroadcastAt: now.toISOString()
        };
        object.memoryRoles = [...new Set([...object.memoryRoles, "working"])];
    }
    for (const id of released) {
        const object = graph.get(id);
        if (!object)
            continue;
        object.workspace = { ...object.workspace, inWorkingMemory: false };
        object.memoryRoles = object.memoryRoles.filter((role) => role !== "working");
    }
    if (config.coalescenceLearningEnabled) {
        reinforceCoalescence(graph, ids, now, hebbianIncrement, maxEdgeStrength);
    }
    if (config.lateralInhibitionLearningEnabled) {
        reinforceLateralInhibition(graph, newlyAdmitted, coalition, admittedSet, now, config.lateralInhibitionIncrement, config.lateralInhibitionMaxLosers);
    }
    return { workingMemory: ids, newlyAdmitted, released };
}
export function reinforceCoalescence(graph, admitted, now, increment, maxStrength) {
    for (let left = 0; left < admitted.length; left += 1) {
        for (let right = left + 1; right < admitted.length; right += 1) {
            const leftObject = graph.get(admitted[left]);
            const rightObject = graph.get(admitted[right]);
            if (leftObject)
                leftObject.associations = reinforceEdge(leftObject.associations, admitted[right], "associative", now, increment, maxStrength);
            if (rightObject)
                rightObject.associations = reinforceEdge(rightObject.associations, admitted[left], "associative", now, increment, maxStrength);
        }
    }
}
export function reinforceLateralInhibition(graph, freshWinners, coalition, admitted, now, increment, maxLosersPerWinner) {
    if (increment <= 0 || maxLosersPerWinner <= 0)
        return;
    const losers = rankCandidates(coalition.filter((candidate) => !admitted.has(candidate.id)))
        .slice(0, maxLosersPerWinner);
    for (const winnerId of freshWinners) {
        const winner = graph.get(winnerId);
        if (!winner)
            continue;
        for (const loser of losers) {
            winner.associations = reinforceEdge(winner.associations, loser.id, "inhibitory", now, increment, 1);
        }
    }
}
//# sourceMappingURL=competition.js.map