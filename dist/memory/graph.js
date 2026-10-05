// Direct TypeScript counterpart of ACA aca-graph/src/graph.rs.
export class ActivationGraph {
    objects = new Map();
    constructor(objects = []) {
        for (const object of objects)
            this.insert(object);
    }
    insert(object) { this.objects.set(object.id, object); }
    get(id) { return this.objects.get(id); }
    values() { return this.objects.values(); }
    get size() { return this.objects.size; }
    activeIds() {
        return [...this.objects.values()].filter(isRecallEligible).map((object) => object.id);
    }
}
export function isRecallEligible(object) {
    // Speck's `dormant` is ACA's still-stored, non-discarded memory state.
    return object.status === "active" || object.status === "dormant";
}
//# sourceMappingURL=graph.js.map