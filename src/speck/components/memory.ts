// Memory as a component (candidate, 2026-10-21): facts the user states about
// themselves, kept across conversations, and brought back as notes in a later
// conversation when they bear on the message. Ported from the archived
// FactRetention (failed work/pipeline-2026-10-20/src/runtime/controller/facts.ts):
//
//   observe     the declarative sentences of a message are read for lasting
//               facts (intake model), each candidate is grounded in the
//               user's words (src/memory/grounding.ts), checked by the worker
//               model, and kept as the user's own words allow: shared, this
//               conversation only, or not at all;
//   contribute  facts from *other* conversations that the message retrieves
//               (shared memory, embedding retrieval) go in as notes. Facts of
//               this conversation are already in its history, so a single
//               conversation is never touched.
//
// Changes from the archived version, all toward fewer calls or no word lists:
// a sentence is a question only when it ends with "?" (the archived reading
// also used a list of question openers); a retention restriction counts when
// the reader quotes the user's words and they are in the message (the
// archived version also asked independent readers, none of which is
// qualified on this setup); the native tool-call extraction path is not used.

import type { Component, TurnContext } from "../component.js";
import { componentState } from "../component.js";
import type { SpeckRuntime } from "../../runtime/speck-runtime.js";
import type { WorkerId } from "../../types/ids.js";

const extractionContract = {
  name: "speck-disclosure-extraction",
  description: "Each item is one fact the user explicitly stated: identity, preferences, relationships, possessions, or stable context. Return an empty list when the user states no such facts.",
  required: ["facts"],
  properties: { facts: { type: "array" as const, items: { type: "string" as const } } },
  additionalProperties: false
};

const validationContract = {
  name: "speck-disclosure-validation",
  description: "Each item is {\"candidate\": the number of the candidate it comes from, \"fact\": that candidate restated so it stands alone, naming who or what it is about}. A candidate that states several facts becomes one item per fact. Keep only candidates that are lasting facts the user stated about themselves or their situation; leave out requests, questions, material given for the current task (examples, data, or content to work on), statements about the assistant, and anything the user did not say.",
  required: ["facts"],
  properties: { facts: { type: "array" as const, items: { type: "object" as const } } },
  additionalProperties: false
};

const RETENTION = ["not mentioned", "only for this task", "do not keep"] as const;
type Retention = (typeof RETENTION)[number];
const retentionContract = {
  name: "speck-retention-evidence",
  description: "quote: the user's own words about keeping or sharing what they told you, copied exactly from the statement. Not the information itself. Empty if the user says nothing about keeping or sharing it. retention: what those words ask for; \"not mentioned\" if the quote is empty.",
  required: ["quote", "retention"],
  properties: { quote: { type: "string" as const }, retention: { type: "string" as const, enum: [...RETENTION] } },
  additionalProperties: false
};

interface MemoryState {
  // The runtime worker that holds this conversation's turns, so grounding
  // can compare a fact with the user's other statements.
  workerId: WorkerId | null;
  // Facts kept for this conversation only.
  local: string[];
}

interface TurnRecord {
  candidates: string[];
  grounded: string[];
  validated: string[];
  retention: Retention | null;
  stored: string[];
  recalled: string[];
}

// Material written in mapping notation is data given for a task, not a
// statement about the user (memory gate, 2026-10-21: "K12 → Teal" was kept as
// a fact and came back in a later conversation). A colon is not counted: it
// opens ordinary prose ("Note for later: my sister ...").
const MAPPING_NOTATION = /→|->|=>|⇒|=/;

// Every sentence that does not end with "?" and is not written in mapping notation.
export function declarativeSentences(text: string): string {
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !sentence.endsWith("?") && !MAPPING_NOTATION.test(sentence)).join(" ");
}

// The quoted words occur in the statement, ignoring case, punctuation and spacing.
export function quotedIn(quote: string, statement: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const words = normalize(quote);
  return words.length > 0 && ` ${normalize(statement)} `.includes(` ${words} `);
}

// A validated fact names a real candidate and stands alone (three words or
// more: "I'm Dana" is three words, "Dana" is one).
function acceptedFacts(value: unknown, candidates: number): string[] {
  if (!Array.isArray(value)) return [];
  const accepted: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { candidate, fact } = item as Record<string, unknown>;
    const index = Number(candidate);
    const text = typeof fact === "string" ? fact.trim() : "";
    if (Number.isInteger(index) && index >= 1 && index <= candidates && text.split(/[\s'’]+/).filter(Boolean).length >= 3) accepted.push(text);
  }
  return [...new Set(accepted)];
}

const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const actor = { kind: "runtime" as const, source: "speck-memory" };

async function sessionWorker(runtime: SpeckRuntime, context: TurnContext, state: MemoryState): Promise<WorkerId> {
  if (!state.workerId || !runtime.getWorker(state.workerId)) state.workerId = (await runtime.createWorker(context.message, [], actor)).id;
  const turns = [...context.history, { role: "user", content: context.message }];
  await runtime.setWorldState({ workerId: state.workerId, key: "genesis.conversationTurns", value: turns, epistemicStatus: "observed", confidence: 1, actor });
  return state.workerId;
}

// Memory is inert without a runtime (a caller that keeps none), and a failure
// anywhere in it (a model, the embedding server) keeps or recalls nothing and
// never fails the turn.
export const memory: Component = {
  id: "memory",
  option: {
    label: "Memory across conversations",
    description: "Remembers facts you state about yourself and brings them back in later conversations. It is a feature: answers within one conversation are unchanged.",
    cost: "about 0.1–0.4 s per message (fact reading by the intake model; a 4B check when a fact is found)",
    enabledByDefault: true
  },

  async observe(context) {
    if (!context.runtime) return;
    try { await remember(context.runtime, context); } catch { /* nothing kept */ }
  },

  async contribute(context) {
    if (!context.runtime) return null;
    try { return await recall(context.runtime, context); } catch { return null; }
  },

  record(context) {
    return (context.scratch.get("memory.record") as TurnRecord | undefined) as unknown as Record<string, unknown> ?? {};
  }
};

async function remember(runtime: SpeckRuntime, context: TurnContext): Promise<void> {
  const state = componentState<MemoryState>(context.session, "memory", () => ({ workerId: null, local: [] }));
  const record: TurnRecord = { candidates: [], grounded: [], validated: [], retention: null, stored: [], recalled: [] };
  context.scratch.set("memory.record", record);
  const workerId = await sessionWorker(runtime, context, state);
  const statements = declarativeSentences(context.message);
  if (!statements) return;
  const worker = runtime.processorForRole("worker") ?? context.readerProcessorId;
  try {
    const extraction = await context.registry.infer({
      processorId: context.readerProcessorId, contract: extractionContract,
      prompt: `List the lasting facts the user states about themselves or their situation. Do not decide whether or where to store them.\nUSER STATEMENT:\n${statements}`
    });
    record.candidates = [...new Set((Array.isArray(extraction.structured?.facts) ? extraction.structured!.facts as unknown[] : [])
      .filter((fact): fact is string => typeof fact === "string").map((fact) => fact.trim()).filter(Boolean))].slice(0, 8);
    if (!record.candidates.length) return;
    record.grounded = (await runtime.groundFacts({ workerId, facts: record.candidates, statement: statements, actor })).filter((d) => d.grounded).map((d) => d.fact);
    if (!record.grounded.length) return;
    const validation = await context.registry.infer({
      processorId: worker, contract: validationContract,
      prompt: `Check each candidate against the user statement.\nUSER STATEMENT:\n${statements}\n\nCANDIDATES:\n${record.grounded.map((fact, index) => `${index + 1}. ${fact}`).join("\n")}`
    });
    const accepted = acceptedFacts(validation.structured?.facts, record.grounded.length);
    record.validated = (await runtime.groundFacts({ workerId, facts: accepted, statement: statements, actor })).filter((d) => d.grounded).map((d) => d.fact);
    if (!record.validated.length) return;
    const retention = await context.registry.infer({ processorId: worker, contract: retentionContract, prompt: `Read the user statement.\nUSER STATEMENT:\n${context.message}` });
    const claimed = String(retention.structured?.retention ?? "not mentioned") as Retention;
    const quote = String(retention.structured?.quote ?? "");
    record.retention = RETENTION.includes(claimed) && claimed !== "not mentioned" && quotedIn(quote, context.message) ? claimed : "not mentioned";
  } catch {
    return; // a failed reading keeps nothing; it never fails the turn
  }
  if (record.retention === "do not keep") return;
  if (record.retention === "only for this task") {
    for (const fact of record.validated) if (!state.local.some((kept) => key(kept) === key(fact))) state.local.push(fact);
    return;
  }
  const known = new Set((await runtime.retrieveSharedMemories({ query: record.validated.join(" "), limit: 50 })).map((entry) => key(entry.object.content)));
  for (const [position, fact] of record.validated.entries()) {
    if (known.has(key(fact))) continue;
    await runtime.recordSharedMemory({
      type: "semantic", content: fact, sourceWorkerId: workerId, confidence: 0.9, importance: 0.9,
      data: { verification: "validated-user-disclosure", sessionId: context.session.id, turn: context.turn, position, sourceText: context.message }, actor
    });
    record.stored.push(fact);
  }
}

// The order facts were told in: when they were stored, then their place in
// the message that stated them. Facts from one message can share a
// timestamp, and without the second key their order followed retrieval
// scores and could change between runs (memo identity check, 2026-10-21:
// "I left the bakery" and "I started at a library" swapped).
export function toldOrder(a: { createdAt: string; data: Record<string, unknown> }, b: { createdAt: string; data: Record<string, unknown> }): number {
  const place = (object: { data: Record<string, unknown> }) => typeof object.data.position === "number" ? object.data.position : Number.MAX_SAFE_INTEGER;
  return a.createdAt.localeCompare(b.createdAt) || place(a) - place(b);
}

async function recall(runtime: SpeckRuntime, context: TurnContext): Promise<string | null> {
  const state = componentState<MemoryState>(context.session, "memory", () => ({ workerId: null, local: [] }));
  const record = context.scratch.get("memory.record") as TurnRecord | undefined;
  const found = await runtime.retrieveSharedMemories({ query: context.message, ...(state.workerId ? { excludeSourceWorkerId: state.workerId } : {}), limit: 8 });
  if (!found.length) return null;
  const facts = found.map((entry) => entry.object).sort(toldOrder);
  if (record) record.recalled = facts.map((fact) => fact.content);
  // In the order they were told, without dates (memory gate, 2026-10-21:
  // the model read a stored date as the user's birthday, or as a future date).
  return ["Facts the user told you in earlier conversations (in the order they were told; where two disagree, the later one is current):",
    ...facts.map((fact) => `- ${fact.content}`)].join("\n");
}
