// The answering model's ordinary chat path: the conversation as chat
// history, the model reasoning as it does on its own, the reply being the
// text after any reasoning. This is Speck's default path; Speck adds to it
// only where a measured component has something to add.
//
// Settings match the naked arm of the evaluations (2026-10-19/20), where this
// path was the baseline Speck's integration lost to: think false (this
// qwen3:4b build reasons anyway, closing with </think>), a budget large
// enough to finish reasoning, and replies taken after the reasoning.

import { afterReasoning } from "../models/response.js";

export interface ChatSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  contextSize: number;
  outputBudget: number;
  timeoutMs: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatReply {
  reply: string;
  raw: string;
  doneReason: string | null;
  endedInsideReasoning: boolean;
  latencyMs: number;
}

export async function chat(settings: ChatSettings, messages: readonly ChatMessage[], fetchImpl: typeof fetch = fetch): Promise<ChatReply> {
  const started = Date.now();
  const response = await fetchImpl(`${settings.baseUrl.replace(/\/+$/, "")}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model: settings.model, stream: false, think: false, messages,
      options: { temperature: settings.temperature, num_ctx: settings.contextSize, num_predict: settings.outputBudget }
    }),
    signal: AbortSignal.timeout(settings.timeoutMs)
  });
  if (!response.ok) throw new Error(`chat model answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json() as { message?: { content?: string }; done_reason?: string };
  const raw = String(body.message?.content ?? "").trim();
  const doneReason = body.done_reason ?? null;
  return { reply: afterReasoning(raw).trim(), raw, doneReason, endedInsideReasoning: !/<\/think>/.test(raw) && doneReason === "length", latencyMs: Date.now() - started };
}
