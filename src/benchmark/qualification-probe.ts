import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfiguredModelProcessor } from "../models/types.js";
import {
  ATOMIC_ENTAILMENT_CORPUS, OUTAGE_TASK_SET, PAIRED_OPPOSITE_FORM, entailmentLabel, entailmentRequest, scorePairedQualification, scoreQualification,
  type ContrastivePair, type EntailmentLabel, type JudgmentCapability, type PairAnswer, type Qualification
} from "../metacognition/qualification.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import { CORPUS_V5_ADDITIONS } from "../metacognition/entailment-corpus-v5.js";
import { oppositeOf } from "../speck/negation.js";
import { parseText } from "../speck/parse.js";

// The paired judgment's corpus: v4 and the v5 additions, each opposite formed
// by Speck from the parse as at runtime (the hand-written ones are not used).
// One parse at a time: the sidecar resets connections under a burst of 180.
async function pairedCorpus(pairs: readonly ContrastivePair[]): Promise<ContrastivePair[]> {
  const formed: ContrastivePair[] = [];
  for (const pair of pairs) {
    const tokens = await parseText(pair.proposition);
    if (!tokens) throw new Error("the parse sidecar is needed to form opposites (sidecars/parse/server.py)");
    formed.push({ ...pair, opposite: oppositeOf(pair.proposition, tokens, PAIRED_OPPOSITE_FORM) });
  }
  return formed;
}

// Measures models on a judgment class: each item of the qualification corpus
// asked as the runtime asks it, repeated, scored per label and for negation
// consistency. The causal test's propositions are scored alongside, never
// counted towards qualification.

export interface QualificationProbeResult {
  model: string;
  processorId: string;
  qualification: Qualification;
  // The same scoring on the task set, for comparison only.
  task: Qualification;
}

export async function runQualificationProbe(input: {
  processors: ConfiguredModelProcessor[];
  capability?: JudgmentCapability;
  repetitions?: number;
  timeoutMs?: number;
  // The pairs to measure on; the qualification corpus when not given.
  corpus?: readonly ContrastivePair[];
  onAnswer?: (processorId: string, pair: ContrastivePair, answer: PairAnswer) => void;
}): Promise<QualificationProbeResult[]> {
  const capability = input.capability ?? "atomic-entailment";
  const repetitions = Math.max(1, input.repetitions ?? 3);
  const results: QualificationProbeResult[] = [];
  for (const processor of input.processors) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-qualify-"));
    const runtime = new SpeckRuntime({
      databasePath: path.join(directory, "speck.sqlite"), genesisRuntimePath: directory,
      modelRuntime: { processors: [{ ...processor, enabled: true }], roles: { intake: processor.id, planner: processor.id, worker: processor.id, toolCaller: "", specialists: {} }, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }
    });
    try {
      const worker = await runtime.createWorker(`Qualification of ${processor.model} for ${capability}`);
      let calls = 0;
      let elapsed = 0;
      const ask = async (premise: string, hypothesis: string): Promise<EntailmentLabel | null> => {
        const began = performance.now();
        try {
          const answered = await runtime.inferForWorker({
            workerId: worker.id, processorId: processor.id, contextScope: "minimal",
            ...entailmentRequest(premise, hypothesis), actor: { kind: "runtime", source: "qualification-probe" }
          });
          return entailmentLabel(answered.response.structured?.label);
        } catch {
          return null;
        } finally {
          calls += 1;
          elapsed += performance.now() - began;
        }
      };
      const answer = async (pairs: readonly ContrastivePair[]) => {
        const answers: PairAnswer[] = [];
        for (let repetition = 0; repetition < repetitions; repetition += 1) {
          for (const pair of pairs) {
            const entry = { pair, proposition: await ask(pair.premise, pair.proposition), opposite: await ask(pair.premise, pair.opposite) };
            input.onAnswer?.(processor.id, pair, entry);
            answers.push(entry);
          }
        }
        return answers;
      };
      const paired = capability === "paired-entailment";
      const corpus = await answer(paired ? await pairedCorpus(input.corpus ?? [...ATOMIC_ENTAILMENT_CORPUS, ...CORPUS_V5_ADDITIONS]) : input.corpus ?? ATOMIC_ENTAILMENT_CORPUS);
      const latency = calls ? Math.round(elapsed / calls) : 0;
      const task = await answer(paired ? await pairedCorpus(OUTAGE_TASK_SET) : OUTAGE_TASK_SET);
      const score = (answers: PairAnswer[]) => paired ? scorePairedQualification(answers, repetitions, latency) : scoreQualification(capability, answers, repetitions, latency);
      results.push({
        model: `${processor.provider}:${processor.model}`, processorId: processor.id,
        qualification: score(corpus),
        task: score(task)
      });
    } finally {
      runtime.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  return results;
}
