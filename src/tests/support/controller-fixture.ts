// A runtime with stub processors for the four controller roles, and helpers
// shared by the controller tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATOMIC_ENTAILMENT_CORPUS, opposed, scoreQualification } from "../../metacognition/qualification.js";
import type { ModelProcessorDescriptor } from "../../models/types.js";
import { SpeckRuntime } from "../../runtime/speck-runtime.js";

export const descriptors: ModelProcessorDescriptor[] = ["intake", "planner", "worker", "tool-caller"].map((id) => ({
  id, provider: "ollama", model: `${id}-model`, tier: 1, contextSize: 4096,
  specialties: ["general", id === "planner" ? "planning" : id], enabled: true
}));

export interface IntakeFixtureDecision {
  [key: string]: unknown;
  route: "direct" | "plan";
  specialty: string;
  reason: string;
  interaction: "task" | "conversation" | "disclosure";
  response: string;
  facts: string[];
  memoryScope: "none" | "local" | "shared";
}

export interface Fixture {
  directory: string;
  runtime: SpeckRuntime;
}

export function fixture(route: "direct" | "plan", intakeDecision?: IntakeFixtureDecision): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-controller-"));
  const runtime = new SpeckRuntime({
    databasePath: path.join(directory, "speck.sqlite"),
    modelRuntime: { processors: [], roles: { intake: "intake", planner: "planner", worker: "worker", toolCaller: "", specialists: {} } }
  });
  for (const descriptor of descriptors) {
    runtime.registerModelProcessor(descriptor, {
      infer: async (request) => {
        if (request.contract?.name === "speck-intake-route") {
          const decision = intakeDecision ?? { route, specialty: "general", interaction: "task" };
          return completion({ interaction: decision.interaction === "task" ? "task" : "conversation", route: decision.route });
        }
        if (request.contract?.name === "speck-dialogue-turn") {
          return completion({ response: intakeDecision?.response ?? "" });
        }
        if (request.contract?.name === "speck-disclosure-extraction") {
          return completion({ facts: intakeDecision?.facts ?? [] });
        }
        if (request.contract?.name === "speck-disclosure-validation") {
          // Echo exactly the candidates Speck presented, as a model would.
          const shown = [...request.prompt.matchAll(/^(\d+)\. (.+)$/gm)].map((match) => ({ candidate: Number(match[1]), fact: match[2]! }));
          return completion({ facts: shown });
        }
        if (request.contract?.name === "speck-retention-evidence" || request.contract?.name === "speck-retention-check") {
          // A restriction is claimed with the words it rests on, which tests
          // put in the user statement as "Just for this task" / "Do not keep this".
          const scope = intakeDecision?.memoryScope;
          const retention = scope === "local" ? "only for this task" : scope === "none" ? "do not keep" : "not mentioned";
          const quote = scope === "local" ? "Just for this task" : scope === "none" ? "Do not keep this" : "";
          return completion(request.contract.name === "speck-retention-check" ? { retention } : { quote, retention });
        }
        if (request.contract?.name === "speck-parallel-plan") {
          return completion({ subtasks: [
            { id: "first", objective: "First part", dependencies: [], priority: 80, completionCriteria: ["done"], constraints: [] },
            { id: "second", objective: "Second part", dependencies: ["first"], priority: 70, completionCriteria: ["done"], constraints: [] }
          ] });
        }
        if (request.contract?.name === "speck-completion-validation") {
          return completion({ satisfied: true, reason: "The proposed answer directly satisfies the objective.", confidence: 0.9 });
        }
        if (request.contract?.name === "speck-wait-validation") return completion({ reason: "Waiting is justified.", justified: true });
        if (request.contract?.name === "speck-atomic-entailment") return completion({ label: "neutral" });
        if (request.contract?.name === "speck-hypothesis-requirements") return completion({ requirements: [] });
        if (request.contract?.name === "speck-reply-claims") return completion({ claims: [] });
        if (request.contract?.name === "speck-examples") return completion({ examples: [] });
        return completion({
          reply: "Finished by the worker role.", state: "done", action: "tool", madeProgress: true,
          expectedOutcome: "The completion validator accepts the direct answer.",
          progressEvidence: "A direct answer was produced.",
          evidence: ["The response contains the requested result."],
          semanticMemories: ["Direct objectives can be answered without decomposition."],
          episodicMemories: ["The worker produced a direct answer."],
          toolRequest: "", question: ""
        });
      }
    });
  }
  // No encoder in tests: the toolbelt then offers every tool, and no test
  // reaches the configured embedding server. Toolbelt tests set their own.
  runtime.toolbelt.encoder = async () => { throw new Error("no encoder in tests"); };
  return { directory, runtime };
}

// Runs a test body against a fresh fixture and always cleans it up.
export async function withFixture(route: "direct" | "plan", body: (f: Fixture) => Promise<void>, intakeDecision?: IntakeFixtureDecision): Promise<void> {
  const f = fixture(route, intakeDecision);
  try {
    await body(f);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
}

// Records a processor as measured qualified for atomic entailment, as if it
// had answered the whole corpus correctly.
export function qualify(runtime: SpeckRuntime, processorId: string, latencyMs = 100): void {
  const answers = [0, 1, 2].flatMap(() => ATOMIC_ENTAILMENT_CORPUS.map((pair) => ({ pair, proposition: pair.label, opposite: opposed(pair.label) })));
  runtime.processorCompetence.recordQualification(runtime.modelRegistry.modelKey(processorId), scoreQualification("atomic-entailment", answers, 3, latencyMs));
}

export function completion(response: Record<string, unknown>) {
  return { text: JSON.stringify({ confidence: 0.9, response }) };
}

// The intake processor reads "A17 → Blue" pairs as labelled examples, from a
// user message or a reply, as the example-extraction role does; everything
// else it answers as before. `onReplyRead` sees each reply it reads.
export function readsLabelledExamples(runtime: SpeckRuntime, onReplyRead?: (text: string) => void): void {
  const intake = runtime.modelRegistry.processor("intake")!;
  runtime.modelRegistry.upsert(descriptors.find((descriptor) => descriptor.id === "intake")!, {
    infer: async (request) => {
      if (request.contract?.name !== "speck-examples") return intake.infer(request);
      const [, text = ""] = request.prompt.split(/USER MESSAGE:|REPLY:/);
      if (request.prompt.includes("REPLY:")) onReplyRead?.(text);
      return completion({ examples: [...text.matchAll(/(A\d+) → (\w+)/g)].map((match) => ({ item: match[1], label: match[2] })) });
    }
  });
}

// Completion validation runs on a processor other than the reply's writer;
// this records its prompts on every processor except the writer, without
// changing their other behaviour.
export function captureValidation(runtime: SpeckRuntime, writerId: string, prompts: string[]): void {
  for (const processor of runtime.modelRegistry.list()) {
    if (processor.id === writerId) continue;
    const original = runtime.modelRegistry.processor(processor.id)!;
    runtime.modelRegistry.upsert(descriptors.find((descriptor) => descriptor.id === processor.id)!, {
      ...(original.supportsNativeTools ? { supportsNativeTools: () => original.supportsNativeTools!() } : {}),
      infer: async (request) => {
        if (request.contract?.name === "speck-completion-validation") prompts.push(request.prompt);
        return original.infer(request);
      }
    });
  }
}
