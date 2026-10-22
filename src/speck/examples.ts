// Reading the labelled examples in a user's message: a model proposes pairs,
// and only those the message writes in mapping notation are kept
// (src/cognition/example-support.ts). A message without a mapping symbol is
// not read at all, so ordinary conversation costs no reader call.

import { supportExamples, type RejectedCandidate, type SupportedExample } from "../cognition/example-support.js";
import type { ModelRegistry } from "../models/registry.js";

export const exampleExtractionContract = {
  name: "speck-examples",
  description: "examples: each case in the message where an item is given a label or category, as {\"item\": the item exactly as written, \"label\": its label exactly as written}. Empty if there are none.",
  required: ["examples"],
  properties: { examples: { type: "array" as const, items: { type: "object" as const } } },
  additionalProperties: false
};

const MAPPING_SYMBOL = /→|->|=>|⇒|:|=/;

export function mayHoldExamples(message: string): boolean {
  return MAPPING_SYMBOL.test(message);
}

export async function readExamples(registry: ModelRegistry, processorId: string, message: string): Promise<{ accepted: SupportedExample[]; rejected: RejectedCandidate[] } | null> {
  if (!mayHoldExamples(message)) return { accepted: [], rejected: [] };
  try {
    const reading = await registry.infer({
      processorId, contract: exampleExtractionContract,
      prompt: `List the labelled examples in the user's message.\nUSER MESSAGE:\n${message}`
    });
    const raw = Array.isArray(reading.structured?.examples) ? reading.structured!.examples as unknown[] : [];
    const pairs = raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({ item: String(entry.item ?? "").trim(), label: String(entry.label ?? "").trim() }));
    return supportExamples(message, pairs);
  } catch {
    return null;
  }
}
