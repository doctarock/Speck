import type { MentalObjectId } from "../types/ids.js";
import { recordReference } from "./activation.js";
import { reinforceEdge } from "./edges.js";
import { ActivationGraph, isRecallEligible } from "./graph.js";

// Speck generalization of ACA aca-engine/src/steps/interlocutor.rs.
export function findDomainAnchor(
  graph: ActivationGraph,
  domain: string,
  key: string
): MentalObjectId | null {
  for (const object of graph.values()) {
    const anchor = object.data.domainAnchor;
    if (isDomainAnchor(anchor) && anchor.domain === domain && anchor.key === key) return object.id;
  }
  return null;
}

export function reinforceDomainLink(
  graph: ActivationGraph,
  objectId: MentalObjectId,
  anchorId: MentalObjectId,
  now: Date,
  referenceCapacity: number,
  increment: number,
  maxStrength: number,
  referenceReinforcementEnabled = true
): void {
  const object = graph.get(objectId);
  if (object) {
    object.associations = reinforceEdge(
      object.associations, anchorId, "derived-from", now, increment, maxStrength
    );
  }
  const anchor = graph.get(anchorId);
  if (anchor && referenceReinforcementEnabled) {
    anchor.activation = recordReference(anchor.activation, now, referenceCapacity);
  }
}

export function domainCloudAnchors(graph: ActivationGraph, anchorId: MentalObjectId): Set<MentalObjectId> {
  const anchors = new Set<MentalObjectId>();
  for (const object of graph.values()) {
    if (!isRecallEligible(object)) continue;
    if (object.associations.some((edge) => edge.kind === "derived-from" && edge.targetId === anchorId)) {
      anchors.add(object.id);
    }
  }
  return anchors;
}

function isDomainAnchor(value: unknown): value is { domain: string; key: string } {
  return Boolean(value && typeof value === "object"
    && typeof (value as { domain?: unknown }).domain === "string"
    && typeof (value as { key?: unknown }).key === "string");
}
