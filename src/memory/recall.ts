import type { MentalObjectId } from "../types/ids.js";
import { computeBaseLevel, clearsRetrievalThreshold, sampleNoise } from "./activation.js";
import { effectiveStrength } from "./edges.js";
import { ActivationGraph, isRecallEligible } from "./graph.js";

// Direct TypeScript translation of ACA aca-graph/src/recall.rs.
export function spreadActivationMultiHop(
  graph: ActivationGraph,
  sourceIds: readonly MentalObjectId[],
  maxHops: number,
  decayRatePerMs: number,
  now: Date,
  inhibitionEnabled = true
): Map<MentalObjectId, number> {
  const accumulated = new Map<MentalObjectId, number>();
  if (sourceIds.length === 0 || maxHops === 0) return accumulated;
  const sourceSet = new Set(sourceIds);
  const uniformWeight = 1 / sourceIds.length;
  let frontier = new Map<MentalObjectId, number>(sourceIds.map((id) => [id, uniformWeight]));

  for (let hop = 0; hop < maxHops; hop += 1) {
    const nextFrontier = new Map<MentalObjectId, number>();
    for (const [nodeId, energy] of frontier) {
      const node = graph.get(nodeId);
      if (!node || !isRecallEligible(node) || node.associations.length === 0) continue;
      const fanOut = node.associations.length;
      for (const edge of node.associations) {
        if (sourceSet.has(edge.targetId)) continue;
        const target = graph.get(edge.targetId);
        if (!target || !isRecallEligible(target)) continue;
        const contribution = energy * effectiveStrength(edge, now, decayRatePerMs) / fanOut;
        if (contribution <= 0) continue;
        const negative = edge.kind === "inhibitory" || edge.kind === "contradicts";
        if (negative && !inhibitionEnabled) continue;
        if (negative) {
          accumulated.set(edge.targetId, (accumulated.get(edge.targetId) ?? 0) - contribution);
        } else {
          accumulated.set(edge.targetId, (accumulated.get(edge.targetId) ?? 0) + contribution);
          nextFrontier.set(edge.targetId, (nextFrontier.get(edge.targetId) ?? 0) + contribution);
        }
      }
    }
    if (nextFrontier.size === 0) break;
    frontier = nextFrontier;
  }
  return accumulated;
}

export interface RecallOptions {
  maxHops: number;
  edgeDecayRatePerMs: number;
  retrievalThreshold: number;
  maxNoise: number;
  random?: () => number;
  baseLevelEnabled?: boolean;
  spreadingActivationEnabled?: boolean;
  inhibitionEnabled?: boolean;
}

// Direct TypeScript translation of ACA aca-engine/src/steps/recall.rs.
export function recall(
  graph: ActivationGraph,
  anchors: ReadonlySet<MentalObjectId>,
  excluded: ReadonlySet<MentalObjectId>,
  options: RecallOptions,
  now: Date
): MentalObjectId[] {
  const spreadingMap = options.spreadingActivationEnabled === false
    ? new Map<MentalObjectId, number>()
    : spreadActivationMultiHop(
      graph, [...anchors], options.maxHops, options.edgeDecayRatePerMs, now, options.inhibitionEnabled
    );
  const winners: MentalObjectId[] = [];
  for (const [id, spreading] of spreadingMap) {
    if (anchors.has(id) || excluded.has(id)) continue;
    const object = graph.get(id);
    if (!object) continue;
    const baseLevel = options.baseLevelEnabled === false
      ? 0
      : computeBaseLevel(object.activation.references, object.activation.decay, now);
    const noise = sampleNoise(options.random ?? Math.random, options.maxNoise);
    object.activation = {
      ...object.activation,
      baseLevel,
      spreading,
      noise,
      total: baseLevel + spreading + noise,
      lastComputedAt: now.toISOString()
    };
    if (clearsRetrievalThreshold(object.activation.total, options.retrievalThreshold)) winners.push(id);
  }
  return winners;
}
