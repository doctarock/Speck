import { recordReference } from "./activation.js";
import { reinforceEdge } from "./edges.js";
import { isRecallEligible } from "./graph.js";
// Speck generalization of ACA aca-engine/src/steps/interlocutor.rs.
export function findDomainAnchor(graph, domain, key) {
    for (const object of graph.values()) {
        const anchor = object.data.domainAnchor;
        if (isDomainAnchor(anchor) && anchor.domain === domain && anchor.key === key)
            return object.id;
    }
    return null;
}
export function reinforceDomainLink(graph, objectId, anchorId, now, referenceCapacity, increment, maxStrength, referenceReinforcementEnabled = true) {
    const object = graph.get(objectId);
    if (object) {
        object.associations = reinforceEdge(object.associations, anchorId, "derived-from", now, increment, maxStrength);
    }
    const anchor = graph.get(anchorId);
    if (anchor && referenceReinforcementEnabled) {
        anchor.activation = recordReference(anchor.activation, now, referenceCapacity);
    }
}
export function domainCloudAnchors(graph, anchorId) {
    const anchors = new Set();
    for (const object of graph.values()) {
        if (!isRecallEligible(object))
            continue;
        if (object.associations.some((edge) => edge.kind === "derived-from" && edge.targetId === anchorId)) {
            anchors.add(object.id);
        }
    }
    return anchors;
}
function isDomainAnchor(value) {
    return Boolean(value && typeof value === "object"
        && typeof value.domain === "string"
        && typeof value.key === "string");
}
//# sourceMappingURL=domain-anchors.js.map