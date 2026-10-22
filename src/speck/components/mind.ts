// The mind (candidate, 2026-10-22): Speck's memory machinery on the default
// path. One persistent runtime worker holds what Speck knows about the person
// it talks with, across every conversation, as its own memories, so the
// runtime's machinery applies to them:
//
//   activation     recall through the ACA activation graph: base-level
//                  activation from each memory's reference history, spreading
//                  from what is in the mind's working memory, and semantic
//                  scoring for the message; a recalled memory is reinforced,
//                  and facts told together or found related are associated;
//   context        the runtime's working-memory competition and context
//                  builder decide which recalled facts are shown, within a
//                  token budget;
//   beliefs        a newly told fact that contradicts an older one (by the
//                  qualified paired judgment, paired-entailment) retires the
//                  older one, so only what still stands is recalled;
//   consolidation  the runtime's background cognition runs on the mind
//                  between conversations: repeated mentions consolidate into
//                  facts, associations decay, embeddings are kept up.
//
// Facts are read exactly as the memory component reads them (readDisclosures:
// extraction, grounding in the user's words, a check by another model, and
// retention from the user's quoted words). Each piece of machinery can be
// switched off for ablation (MindOptions).

import { entailmentLabel, entailmentRequest } from "../../metacognition/qualification.js";
import type { SpeckRuntime } from "../../runtime/speck-runtime.js";
import type { MentalObject } from "../../types/model.js";
import type { WorkerId, MentalObjectId } from "../../types/ids.js";
import type { Component, TurnContext } from "../component.js";
import { pairedEntailment } from "../paired-entailment.js";
import { parseText, type ParsedToken } from "../parse.js";

// How facts are parsed to form opposites for belief revision (the parse
// sidecar; tests supply recorded parses).
export const mindOptions: { parse: (text: string) => Promise<ParsedToken[] | null> } = { parse: parseText };
import { readDisclosures, toldOrder, type TurnRecord } from "./memory.js";

export interface MindOptions { activation: boolean; context: boolean; beliefs: boolean; consolidation: boolean }

const MIND_TAG = "speck:mind";
const actor = { kind: "runtime" as const, source: "speck-mind" };
const RECALL_LIMIT = 8;
const RECALL_FLOOR = 0.15;
const RELATED_FLOOR = 0.5;
const CONTEXT_BUDGET = 600;

interface MindRecord extends TurnRecord { superseded: string[]; consolidation: string | null }

const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
const isFact = (object: MentalObject) => object.kind === "fact" && object.status !== "archived" && object.memoryRoles.includes("semantic");

// The one persistent worker that holds the mind, found by its tag.
async function mindWorker(runtime: SpeckRuntime): Promise<WorkerId> {
  const found = runtime.listWorkers().find((worker) => worker.objective.constraints?.includes(MIND_TAG));
  if (found) return found.id;
  return (await runtime.createWorker("What Speck knows about the person it talks with", [MIND_TAG], actor)).id;
}

function checkerAsk(runtime: SpeckRuntime, context: TurnContext) {
  const checker = runtime.qualifiedProcessor(runtime.processorForRole("worker") ?? "", "paired-entailment");
  if (!checker) return null;
  return async (premise: string, hypothesis: string) => {
    try {
      const request = entailmentRequest(premise, hypothesis);
      const judged = await context.registry.infer({ processorId: checker, prompt: request.instruction, contract: request.contract, input: request.input });
      return entailmentLabel(judged.structured?.label);
    } catch {
      return null;
    }
  };
}

// Facts of the mind related to a text, by the runtime's recall with no
// anchors (no spreading), for checking and associating a new fact.
async function related(runtime: SpeckRuntime, mind: WorkerId, text: string, exclude: MentalObjectId[]): Promise<Array<{ object: MentalObject; score: number }>> {
  const found = await runtime.retrieveMemories({ workerId: mind, anchorIds: [], excludedIds: exclude, query: text, limit: 6, actor });
  return found.candidates.filter((entry) => isFact(entry.object)).map((entry) => ({ object: entry.object, score: entry.activation }));
}

async function remember(options: MindOptions, runtime: SpeckRuntime, context: TurnContext, record: MindRecord): Promise<void> {
  const mind = await mindWorker(runtime);
  context.scratch.set("mind.worker", mind);
  // A new conversation starts with an empty working memory, so recall spreads
  // only from what this conversation brings in (mind ablations, 2026-10-22:
  // with activation and context assembly together, facts admitted in an
  // earlier, unrelated conversation anchored recall, and the wrong facts were
  // recalled).
  if (context.turn === 0) await runtime.releaseWorkingMemory(mind, actor);
  // Between conversations: the runtime's background cognition on the mind.
  if (options.consolidation && context.turn === 0) {
    try { record.consolidation = (await runtime.runBackgroundCognition({ workerId: mind })).status; } catch { record.consolidation = "failed"; }
  }
  // The mind holds this conversation's turns, so grounding compares a fact
  // with the user's other statements.
  await runtime.setWorldState({ workerId: mind, key: "genesis.conversationTurns", value: [...context.history, { role: "user", content: context.message }], epistemicStatus: "observed", confidence: 1, actor });
  if (!await readDisclosures(runtime, context, mind, record)) return;
  // What the user asked not to keep, or to keep for this conversation only,
  // is not kept in the mind: the conversation's own history holds it.
  if (record.retention === "do not keep" || record.retention === "only for this task") return;
  const ask = options.beliefs ? checkerAsk(runtime, context) : null;
  const toldHere: MentalObjectId[] = [];
  for (const [position, fact] of record.validated.entries()) {
    const facts = runtime.mentalObjects.listForWorker(mind).filter(isFact);
    const same = facts.find((object) => key(object.content) === key(fact));
    // A fact told again is the same memory, referenced again.
    if (same) {
      await runtime.reinforceMemoryReference(mind, same.id, actor);
      toldHere.push(same.id);
      continue;
    }
    const near = await related(runtime, mind, fact, toldHere);
    const stored = await runtime.recordMemory({
      workerId: mind, type: "semantic", content: fact, confidence: 0.9, importance: 0.9, actor,
      data: { verification: "validated-user-disclosure", sessionId: context.session.id, turn: context.turn, position, sourceText: context.message, consolidationKey: key(fact) }
    });
    // A repeated mention is an episode of the fact, for consolidation.
    await runtime.recordMemory({ workerId: mind, type: "episodic", content: context.message, confidence: 0.9, importance: 0.5, actor,
      data: { consolidationKey: key(fact), semanticContent: fact, sessionId: context.session.id } });
    // Belief revision: an older fact the new one contradicts is retired.
    if (ask) {
      for (const { object } of near) {
        const verdict = await pairedEntailment(ask, fact, object.content, mindOptions.parse);
        if (verdict.label !== "contradiction") continue;
        runtime.mentalObjects.update({ ...object, status: "archived", data: { ...object.data, supersededBy: stored.id, supersededAt: new Date().toISOString() } });
        record.superseded.push(object.content);
      }
    }
    // Association: facts told together, or closely related, are linked both ways.
    if (options.activation) {
      for (const other of [...toldHere, ...near.filter((entry) => entry.score >= RELATED_FLOOR && !record.superseded.includes(entry.object.content)).map((entry) => entry.object.id)]) {
        if (other === stored.id) continue;
        await runtime.reinforceAssociation({ workerId: mind, sourceId: stored.id, targetId: other, actor });
        await runtime.reinforceAssociation({ workerId: mind, sourceId: other, targetId: stored.id, actor });
      }
    }
    toldHere.push(stored.id);
    record.stored.push(fact);
  }
}

async function recall(options: MindOptions, runtime: SpeckRuntime, context: TurnContext, record: MindRecord): Promise<string | null> {
  const mind = (context.scratch.get("mind.worker") as WorkerId | undefined) ?? await mindWorker(runtime);
  const found = await runtime.retrieveMemories({ workerId: mind, query: context.message, limit: RECALL_LIMIT, actor, ...(options.activation ? {} : { anchorIds: [] }) });
  // Facts from other conversations: this one's are in its history already.
  let facts = found.candidates
    .filter((entry) => entry.activation >= RECALL_FLOOR && isFact(entry.object) && entry.object.data.sessionId !== context.session.id)
    .map((entry) => entry.object);
  if (!facts.length) return null;
  if (options.context) {
    // The runtime's working-memory competition and context builder choose
    // what is shown, within the budget.
    await runtime.competeForWorkingMemory({ workerId: mind, candidateIds: facts.map((fact) => fact.id), actor });
    const packet = runtime.buildContext({ workerId: mind, tokenBudget: CONTEXT_BUDGET, scope: "minimal" });
    const chosen = new Set(packet.includedObjectIds ?? []);
    const shown = facts.filter((fact) => chosen.has(fact.id));
    if (shown.length) facts = shown;
  }
  // Recalled facts that are mutually associated reinforce each other.
  if (options.activation) for (const [index, fact] of facts.entries()) for (const other of facts.slice(index + 1)) {
    await runtime.reinforceAssociation({ workerId: mind, sourceId: fact.id, targetId: other.id, actor });
  }
  const ordered = [...facts].sort(toldOrder);
  record.recalled = ordered.map((fact) => fact.content);
  return ["Facts the user told you in earlier conversations (in the order they were told; where two disagree, the later one is current):",
    ...ordered.map((fact) => `- ${fact.content}`)].join("\n");
}

export function makeMind(id: string, options: MindOptions): Component {
  return {
    id,
    option: {
      label: "Memory across conversations",
      description: "Remembers facts you state about yourself in a persistent mind: recalled by activation, assembled by the context engine, revised when you correct them, and consolidated between conversations. It is a feature: answers within one conversation are unchanged.",
      cost: "about 0.2–0.6 s per message (fact reading; checks when a fact is found)",
      enabledByDefault: true
    },
    async observe(context) {
      const record: MindRecord = { candidates: [], grounded: [], validated: [], retention: null, stored: [], recalled: [], superseded: [], consolidation: null };
      context.scratch.set("mind.record", record);
      if (!context.runtime) return;
      try { await remember(options, context.runtime, context, record); } catch { /* nothing kept */ }
    },
    async contribute(context) {
      if (!context.runtime) return null;
      const record = context.scratch.get("mind.record") as MindRecord;
      try { return await recall(options, context.runtime, context, record); } catch { return null; }
    },
    record(context) {
      return (context.scratch.get("mind.record") as MindRecord | undefined) as unknown as Record<string, unknown> ?? {};
    }
  };
}

export const mind = makeMind("mind", { activation: true, context: true, beliefs: true, consolidation: true });

// Ablations: the mind with one piece of machinery switched off.
export const mindAblations = {
  "mind-noctx": makeMind("mind-noctx", { activation: true, context: false, beliefs: true, consolidation: true }),
  "mind-noact": makeMind("mind-noact", { activation: false, context: true, beliefs: true, consolidation: true }),
  "mind-nobel": makeMind("mind-nobel", { activation: true, context: true, beliefs: false, consolidation: true }),
  "mind-nocons": makeMind("mind-nocons", { activation: true, context: true, beliefs: true, consolidation: false })
};
