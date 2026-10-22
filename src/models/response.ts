import type { JsonContractProperty, StructuredOutputContract } from "./types.js";

export interface ParsedCompletion {
  text: string;
  structured: Record<string, unknown> | null;
  confidence: number;
}

// TypeScript translation of ACA aca-tiers/src/response.rs, extended with a
// strict Speck contract validator when a structured contract is requested.
export function parseModelCompletion(rawCompletion: string, contract?: StructuredOutputContract): ParsedCompletion {
  const candidate = extractJsonCandidate(rawCompletion);
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch {
    if (contract) throw new TypeError("model did not return a JSON object");
    return { text: rawCompletion, structured: null, confidence: 0.5 };
  }
  if (!isRecord(parsed)) {
    if (contract) throw new TypeError("model response must be a JSON object");
    return { text: rawCompletion, structured: null, confidence: 0.5 };
  }
  const confidence = clampConfidence(parsed.confidence);
  const response = parsed.response;
  if (!contract) {
    return {
      text: typeof response === "string" ? response : rawCompletion,
      structured: isRecord(response) ? response : null,
      confidence
    };
  }
  // Models commonly return a contract directly at the top level. A contract
  // may itself have a field named "response", so only unwrap that field when
  // the top-level object does not already look like the requested contract.
  const directContract = conformsToContract(parsed, contract);
  const namedEnvelope = parsed[contract.name];
  const payload = normalizePayload(directContract
    ? parsed
    : response !== undefined
      ? response
      : isRecord(namedEnvelope)
        ? namedEnvelope
        : parsed);
  const normalized = withoutUndeclaredKeys(payload, contract);
  validateContract(normalized, contract);
  assertNoInstructionEcho(normalized, contract);
  return { text: JSON.stringify(normalized), structured: normalized, confidence };
}

function conformsToContract(value: unknown, contract: StructuredOutputContract): boolean {
  // A contract whose fields are all optional is satisfied by any object, so an
  // envelope only counts as the payload when it carries a declared field.
  if (!isRecord(value) || !Object.keys(contract.properties).some((key) => key in value)) return false;
  try {
    validateContract(value, contract);
    return true;
  } catch {
    return false;
  }
}

export function validateContract(value: unknown, contract: StructuredOutputContract): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("the reply must be a JSON object");
  for (const key of contract.required) {
    if (!(key in value)) throw new TypeError(`missing required field "${key}"`);
  }
  for (const [key, field] of Object.entries(contract.properties)) {
    if (!(key in value)) continue;
    const actual = value[key];
    const matches = field.type === "array" ? Array.isArray(actual)
      : field.type === "object" ? isRecord(actual)
      : typeof actual === field.type;
    if (!matches) throw new TypeError(`${key} must be ${describeType(field)}`);
    if (field.type === "array" && field.items && Array.isArray(actual)) {
      const invalidIndex = actual.findIndex((item) => field.items!.type === "object"
        ? !isRecord(item)
        : typeof item !== field.items!.type);
      if (invalidIndex >= 0) throw new TypeError(`${key}[${invalidIndex}] must be ${field.items.type}`);
    }
    if (field.enum && !field.enum.includes(actual as string | number | boolean)) {
      throw new TypeError(`${key} must be exactly one of ${field.enum.map((value) => JSON.stringify(value)).join(", ")}`);
    }
  }
  if (contract.additionalProperties === false) {
    const allowed = new Set(Object.keys(contract.properties));
    const extras = Object.keys(value).filter((key) => !allowed.has(key));
    if (extras.length > 0) throw new TypeError(`unknown field "${extras[0]}"`);
  }
}

// The contract as a JSON schema, for providers that constrain generation to a
// schema. A bare "JSON object" constraint lets a model emit any object (often
// {} or a repeating fragment); the schema admits only the contract's keys,
// types, and enum values.
// A field's schema, with a list's items and an object's own fields when the
// contract declares them.
function fieldSchema(property: JsonContractProperty): Record<string, unknown> {
  return {
    type: property.type,
    ...(property.enum ? { enum: property.enum } : {}),
    ...(property.type === "array" ? { items: property.items ? fieldSchema(property.items) : { type: "string" } } : {}),
    ...(property.type === "object" && property.properties
      ? { properties: Object.fromEntries(Object.entries(property.properties).map(([name, nested]) => [name, fieldSchema(nested)])),
          ...(property.required ? { required: property.required } : {}),
          ...(property.additionalProperties === false ? { additionalProperties: false } : {}) }
      : {})
  };
}

export function contractJsonSchema(contract: StructuredOutputContract): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(contract.properties).map(([name, property]) => [name, fieldSchema(property)])),
    required: contract.required,
    ...(contract.additionalProperties === false ? { additionalProperties: false } : {})
  };
}

// The model sees only the fields it must fill: their names, types, and the
// exact allowed values. Speck's internal contract name and envelope handling
// are never shown, because naming them invites the model to reproduce them.
export function contractInstruction(contract: StructuredOutputContract): string {
  const fields = Object.entries(contract.properties).map(([name, property]) =>
    `- ${name} (${contract.required.includes(name) ? "required" : "optional"}): ${describeType(property)}`);
  // An example shows a reply's shape, and is valid so that copying it is not
  // a failure. A choice (one of several values, true or false, a number)
  // cannot be shown without showing an answer: an example of {"episode":0}
  // made qwen3:4b answer 0 to every reading, and {"relation":"consistent"}
  // or {"satisfied":false} lean every checker the same way. So the example
  // is given only when every required field is free text or a list; the
  // field list states every choice. With no required keys, any single-key
  // example would single out one option, so the field list stands alone.
  const choices = contract.required.some((name) => isChoice(contract.properties[name]));
  const example = Object.fromEntries(contract.required.map((name) => [name, exampleValue(contract.properties[name])]));
  return [
    "Reply with only a JSON object with these keys:",
    ...fields,
    contract.required.length && !choices ? `Example: ${JSON.stringify(example)}` : "",
    contract.description ?? ""
  ].filter(Boolean).join("\n");
}

type ContractField = StructuredOutputContract["properties"][string];

function describeType(field: ContractField): string {
  if (field.enum?.length) return `exactly one of ${field.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  if (field.type === "array") return `list of ${field.items?.type === "object" ? "objects" : `${field.items?.type ?? "value"}s`}`;
  if (field.type === "boolean") return "true or false";
  return field.type;
}

function isChoice(field: ContractField | undefined): boolean {
  return Boolean(field && (field.enum?.length || field.type === "boolean" || field.type === "number"));
}

function exampleValue(field: ContractField | undefined): unknown {
  if (!field) return null;
  if (field.enum?.length) return field.enum[0];
  // Containers are shown with a placeholder member: an empty example reads as
  // "leave this empty".
  return field.type === "string" ? "..." : field.type === "number" ? 0 : field.type === "boolean" ? false
    : field.type === "array" ? [exampleValue({ type: field.items?.type ?? "string" })] : { "...": "..." };
}

// Keys the contract does not declare carry nothing Speck will read, so a
// payload that adds them is equivalent to one that omits them. Dropping them is
// model-independent normalization rather than a reason to retry.
function withoutUndeclaredKeys(value: Record<string, unknown>, contract: StructuredOutputContract): Record<string, unknown> {
  if (contract.additionalProperties !== false) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key in contract.properties));
}

// A text field that reproduces the contract's own instructions is not an
// answer, whatever the model; it is unusable like any malformed reply.
function assertNoInstructionEcho(payload: Record<string, unknown>, contract: StructuredOutputContract): void {
  const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const instructions = ` ${words(contractInstruction(contract)).join(" ")} `;
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "string") continue;
    const text = words(value);
    if (text.length >= 6 && instructions.includes(` ${text.join(" ")} `)) {
      throw new TypeError(`${key} repeats the instructions instead of answering`);
    }
  }
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(extractJsonCandidate(value));
      if (isRecord(parsed)) return parsed;
    } catch { /* validator below reports the stable error */ }
  }
  throw new TypeError("model response envelope did not contain an object payload");
}

// What a model said after any reasoning it emitted despite being asked not
// to: the text after the last closing think tag.
export function afterReasoning(raw: string): string {
  const endThink = raw.lastIndexOf("</think>");
  return endThink >= 0 ? raw.slice(endThink + "</think>".length) : raw;
}

function extractJsonCandidate(raw: string): string {
  const afterThink = afterReasoning(raw);
  const range = findBalancedObject(afterThink);
  return range ? afterThink.slice(range[0], range[1] + 1) : raw.trim();
}

function findBalancedObject(text: string): [number, number] | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return [start, index];
  }
  return null;
}

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
