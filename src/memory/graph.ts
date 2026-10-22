import type { MentalObjectId } from "../types/ids.js";
import type { MentalObject } from "../types/model.js";

// Direct TypeScript counterpart of ACA aca-graph/src/graph.rs.
export class ActivationGraph {
  private readonly objects = new Map<MentalObjectId, MentalObject>();

  constructor(objects: readonly MentalObject[] = []) {
    for (const object of objects) this.insert(object);
  }

  insert(object: MentalObject): void { this.objects.set(object.id, object); }
  get(id: MentalObjectId): MentalObject | undefined { return this.objects.get(id); }
  values(): IterableIterator<MentalObject> { return this.objects.values(); }
  get size(): number { return this.objects.size; }

  activeIds(): MentalObjectId[] {
    return [...this.objects.values()].filter(isRecallEligible).map((object) => object.id);
  }
}

export function isRecallEligible(object: MentalObject): boolean {
  // Speck's `dormant` is ACA's still-stored, non-discarded memory state.
  return object.status === "active" || object.status === "dormant";
}
