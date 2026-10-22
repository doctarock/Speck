// A read-only tool family as a default-path component (2026-10-22): when a
// message needs one of the family's tools, the Tool Caller chooses it with
// its arguments, Speck runs it, and the results go in as notes. Made from the
// files component (admitted 2026-10-21) so every tool family is gated the
// same way; ported from the archived ToolStep (failed work/pipeline-2026-10-20/
// src/runtime/controller/tool-step.ts) for read-only tools only:
//
//   - the toolbelt (src/cognition/toolbelt.ts) and the Tool Caller decide
//     whether a tool must run; "none" leaves the turn untouched;
//   - up to two steps per message, so a thing found by one tool can be read
//     by the next; the same operation is never run twice in a message;
//   - only read-only tools, so nothing needs approval and nothing changes;
//   - only successful results become notes.

import type { Component, ComponentOption, TurnContext } from "../component.js";
import { NoApplicableToolError, type SpeckRuntime } from "../../runtime/speck-runtime.js";

const MAXIMUM_STEPS = 2;
const OUTPUT_LIMIT = 6_000;
const CONTEXT_TURNS = 6;
const CONTEXT_CHARACTERS = 400;

interface Step {
  tool: string;
  arguments: Record<string, unknown>;
  outcome: string;
  output: string;
}

export interface ToolFamily {
  id: string;
  tools: readonly string[];
  option: ComponentOption;
  // The first line of the notes the results go in.
  heading: string;
}

function shown(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 1);
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[… cut at ${OUTPUT_LIMIT} characters]` : text;
}

async function runTools(family: ToolFamily, runtime: SpeckRuntime, context: TurnContext): Promise<Step[]> {
  const actor = { kind: "runtime" as const, source: `speck-${family.id}` };
  const offered = family.tools.filter((name) => runtime.toolRegistry.list().some((tool) => tool.name === name && tool.risk === "read-only"));
  if (!offered.length) return [];
  // One worker per message: the Tool Caller sees this message as the request.
  const worker = await runtime.createWorker(context.message, [], actor);
  // The worker model decides whether a tool must run. The configured Tool
  // Caller (Qwen3 0.6B tools) was measured unqualified for this on
  // 2026-10-21: it declined "What files are in my workspace?" and "Is there
  // anything in my inbox?", and listed the inbox for notes/todo.txt, with
  // think false, true or unset; qwen3:4b chose the right tool and arguments
  // on all of them and declined every message that needed none
  // (docs/REINTEGRATION.md, files gate).
  const routing = runtime.processorForRole("worker");
  const steps: Step[] = [];
  // The conversation so far, so a short follow-up ("And Q63?") is read as
  // continuing it, not as an open request for a tool (files gate,
  // 2026-10-21: without it the Tool Caller listed files on rule-task
  // follow-ups, and the listings shifted label answers). The archived
  // ToolStep gave it the same.
  const earlier = context.history.slice(-CONTEXT_TURNS)
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content.length > CONTEXT_CHARACTERS ? `${turn.content.slice(0, CONTEXT_CHARACTERS)} …` : turn.content}`);
  for (let step = 0; step < MAXIMUM_STEPS; step += 1) {
    const situation = [
      earlier.length ? `EARLIER IN THIS CONVERSATION:\n${earlier.join("\n")}` : "",
      steps.length ? `ALREADY DONE FOR THIS MESSAGE:\n${steps.map((done) => `- ${done.tool} ${JSON.stringify(done.arguments)} → ${done.outcome}: ${shown(done.output).slice(0, 1_500)}`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n");
    let proposed;
    try {
      proposed = await runtime.proposeToolIntent({ workerId: worker.id, request: context.message, allowedTools: offered, ...(routing ? { processorId: routing } : {}), ...(situation ? { situation } : {}), actor });
    } catch (error) {
      if (error instanceof NoApplicableToolError) break;
      throw error;
    }
    const definition = runtime.toolRegistry.resolve(proposed.intent).definition;
    if (definition.risk !== "read-only") break;
    const key = `${definition.name} ${JSON.stringify(proposed.intent.arguments)}`;
    if (steps.some((done) => `${done.tool} ${JSON.stringify(done.arguments)}` === key)) break;
    try {
      const result = await runtime.executeToolIntent({ workerId: worker.id, intent: proposed.intent, actor });
      steps.push({ tool: definition.name, arguments: proposed.intent.arguments, outcome: result.record.actualOutcome,
        output: result.record.actualOutcome === "succeeded" ? shown(result.record.output) : String(result.record.error ?? "failed") });
    } catch (error) {
      steps.push({ tool: definition.name, arguments: proposed.intent.arguments, outcome: "failed", output: error instanceof Error ? error.message : String(error) });
    }
    if (steps.at(-1)!.outcome !== "succeeded") break;
  }
  return steps;
}

export function toolComponent(family: ToolFamily): Component {
  return {
    id: family.id,
    option: family.option,

    async contribute(context) {
      const runtime = context.runtime;
      if (!runtime) return null;
      let steps: Step[];
      try { steps = await runTools(family, runtime, context); } catch { return null; }
      context.scratch.set(`${family.id}.steps`, steps);
      // Only results: a failed call says nothing, and failed calls on messages
      // that needed none shifted answers (files gate, 2026-10-21).
      const results = steps.filter((step) => step.outcome === "succeeded");
      if (!results.length) return null;
      return [family.heading, ...results.map((step) => `- ${step.tool} ${JSON.stringify(step.arguments)}:\n${step.output}`)].join("\n");
    },

    record(context) {
      const steps = (context.scratch.get(`${family.id}.steps`) as Step[] | undefined) ?? [];
      return { steps: steps.map((step) => ({ tool: step.tool, arguments: step.arguments, outcome: step.outcome })) };
    }
  };
}
