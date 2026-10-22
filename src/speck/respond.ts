// Speck's default path for one user message (respond/2).
//
// Every message is answered by the model's ordinary chat path, exactly as the
// model answers on its own: that is the floor. Speck's components
// (src/speck/component.ts) add to it only where they have something to add:
// each observes the message, may contribute a section of notes, and may
// review the reply. The components on the path are the admitted ones
// (src/speck/components/index.ts), each returned by a no-harm measurement.
//
// The earlier pipeline (episodes, worker framing, routing, planning,
// validators, generated hypotheses) was measured to cost answers and is not
// on this path (failed work/pipeline-2026-10-20); its parts come back as
// components, one gate at a time (docs/REINTEGRATION.md).

import type { ModelRegistry } from "../models/registry.js";
import type { SpeckRuntime } from "../runtime/speck-runtime.js";
import { chat, type ChatMessage, type ChatSettings } from "./chat.js";
import { NOTES_HEADING, type Component, type TurnContext } from "./component.js";
import { admittedComponents } from "./components/index.js";
import type { Session } from "./session.js";

// "plain", or the components that acted: "<id>-notes" for a contribution,
// "<id>-corrected" for a replaced reply, joined with "+".
export type ResponsePath = string;

export interface Response {
  reply: string;
  path: ResponsePath;
  notes: string | null;
  // The model's reply when a component replaced it.
  correctedFrom: string | null;
  // What each component did on this turn.
  components: Record<string, Record<string, unknown>>;
  latencyMs: number;
}

export interface RespondDependencies {
  registry: ModelRegistry;
  runtime?: SpeckRuntime;
  readerProcessorId: string;
  chat: ChatSettings;
  fetch?: typeof fetch;
  // The components on the path; the admitted ones when not given.
  components?: readonly Component[];
}

export async function respond(session: Session, message: string, deps: RespondDependencies): Promise<Response> {
  const started = Date.now();
  const components = deps.components ?? admittedComponents();
  const history: ChatMessage[] = session.turns.map((entry) => ({ role: entry.role, content: entry.content }));
  const context: TurnContext = {
    session, message, turn: session.turns.filter((entry) => entry.role === "user").length, history,
    registry: deps.registry, runtime: deps.runtime, readerProcessorId: deps.readerProcessorId, chat: deps.chat, fetch: deps.fetch, scratch: new Map()
  };
  for (const component of components) await component.observe?.(context);
  const sections: Array<{ id: string; text: string }> = [];
  for (const component of components) {
    const text = await component.contribute?.(context);
    if (text) sections.push({ id: component.id, text });
  }
  const notes = sections.length ? [NOTES_HEADING, ...sections.map((section) => section.text)].join("\n\n") : null;
  const messages: ChatMessage[] = [...(notes ? [{ role: "system" as const, content: notes }] : []), ...history, { role: "user", content: message }];
  const answered = await chat(deps.chat, messages, deps.fetch);
  let reply = answered.reply;
  let correctedFrom: string | null = null;
  const acted = sections.map((section) => `${section.id}-notes`);
  for (const component of components) {
    const review = await component.review?.(context, reply);
    if (!review) continue;
    correctedFrom ??= reply;
    reply = review.reply;
    const at = acted.indexOf(`${component.id}-notes`);
    if (at >= 0) acted.splice(at, 1, `${component.id}-corrected`); else acted.push(`${component.id}-corrected`);
  }
  const path = acted.length ? acted.join("+") : "plain";
  const records = Object.fromEntries(components.map((component) => [component.id, component.record?.(context) ?? {}]));
  session.turns.push({ role: "user", content: message }, { role: "assistant", content: reply });
  session.log.push({ turn: context.turn, path, components: records, at: new Date().toISOString() });
  return { reply, path, notes, correctedFrom, components: records, latencyMs: Date.now() - started };
}
