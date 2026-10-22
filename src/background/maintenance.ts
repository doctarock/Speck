import type { MentalObject } from "../types/model.js";

export function maintenanceKey(object: MentalObject, field: "consolidationKey" | "patternKey"): string | null {
  const explicit = object.data[field];
  if (typeof explicit === "string" && explicit.trim()) return normalize(explicit);
  return field === "consolidationKey" ? normalize(object.content) : null;
}

export function featureHashEmbedding(text: string, dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new RangeError("Embedding dimensions must be a positive integer");
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = normalize(text).match(/[\p{L}\p{N}_-]+/gu) ?? [];
  for (const token of tokens) {
    const hash = fnv1a(token);
    const index = hash % dimensions;
    vector[index] = vector[index]! + ((hash & 1) === 0 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => Number((value / norm).toFixed(6)));
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
