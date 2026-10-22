import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStandardVariants } from "../benchmark/ablations.js";
import { BenchmarkHarness, evaluate } from "../benchmark/harness.js";
import { writeBenchmarkReport, writeBenchmarkRunsJsonl } from "../benchmark/reporter.js";
import { STANDARD_TASK_SUITE, validateCategoryCoverage } from "../benchmark/suites.js";
import type { BenchmarkExecution, BenchmarkExecutor, BenchmarkProcessor, BenchmarkTask, BenchmarkVariant } from "../benchmark/types.js";
import { validateBenchmarkDesign } from "../benchmark/validation.js";

const processor: BenchmarkProcessor = { id: "small-3b", provider: "test", tier: 1, parametersBillions: 3 };
const variants = createStandardVariants(processor).slice(0, 2);

function execution(output: unknown = { completed: true }): BenchmarkExecution {
  return {
    output,
    modelCalls: [{ processorId: "small-3b", provider: "test", tier: 1, parametersBillions: 3, inputTokens: 100, outputTokens: 20, durationMs: 5, estimatedCostUsd: 0.01, purpose: "task" }],
    observedModelCallCount: 1,
    toolCalls: [{ tool: "inspect", successful: true, durationMs: 1 }],
    cognitive: {
      impasses: 1, successfulImpasseRecoveries: 1, procedureHits: 1, knownAnswerHits: 0,
      memoryRetrievals: 2, usefulMemoryRetrievals: 1, contextTokens: 80,
      repeatedStateCount: 0, llmCallsAvoided: 1, tokensAvoided: 50
    }
  };
}

test("standard suite covers every required Phase 13 category", () => {
  assert.deepEqual(validateCategoryCoverage(STANDARD_TASK_SUITE), []);
  assert.equal(new Set(STANDARD_TASK_SUITE.map((task) => task.id)).size, 8);
});

test("experiment design requires same-model minimal and Speck comparisons", () => {
  validateBenchmarkDesign([STANDARD_TASK_SUITE[0]!], variants);
  const mismatched: BenchmarkVariant = {
    ...variants[1]!, id: "large-speck",
    primaryProcessor: { id: "large", provider: "test", tier: 2, parametersBillions: 7 },
    allowedProcessors: [{ id: "large", provider: "test", tier: 2, parametersBillions: 7 }]
  };
  assert.throws(() => validateBenchmarkDesign([STANDARD_TASK_SUITE[0]!], [variants[0]!, mismatched]), /same primary processor/);
});

test("fixed seeds produce repeatable balanced trial ordering", async () => {
  const observedA: string[] = [];
  const observedB: string[] = [];
  const makeExecutor = (observed: string[]): BenchmarkExecutor => ({ execute: async (context) => {
    observed.push(`${context.task.id}|${context.variant.id}|${context.repetition}|${context.seed}`);
    return execution();
  } });
  await new BenchmarkHarness(makeExecutor(observedA)).run({ tasks: STANDARD_TASK_SUITE.slice(0, 2), variants, repetitions: 2, seed: 42, experimentId: "repeat-a" });
  await new BenchmarkHarness(makeExecutor(observedB)).run({ tasks: STANDARD_TASK_SUITE.slice(0, 2), variants, repetitions: 2, seed: 42, experimentId: "repeat-b" });
  assert.deepEqual(observedA, observedB);
  assert.equal(observedA.length, 8);
  const seedByTask = new Map<string, Set<string>>();
  for (const value of observedA) {
    const [taskId, , repetition, seed] = value.split("|");
    const key = `${taskId}:${repetition}`;
    seedByTask.set(key, new Set([...(seedByTask.get(key) ?? []), seed!]));
  }
  assert.ok([...seedByTask.values()].every((seeds) => seeds.size === 1));
});

test("harness captures success, cost, latency inputs, cognition, and aggregate efficiency", async () => {
  const report = await new BenchmarkHarness({ execute: async () => execution() }).run({
    tasks: [STANDARD_TASK_SUITE[0]!], variants, repetitions: 2, seed: 7, experimentId: "metrics"
  });
  assert.equal(report.runs.length, 4);
  assert.ok(report.runs.every((run) => run.valid && run.success));
  const run = report.runs[0]!;
  assert.equal(run.metrics.tokensToCompletion, 120);
  assert.equal(run.metrics.largestModelBillions, 3);
  assert.equal(run.metrics.estimatedCostUsd, 0.01);
  assert.equal(run.metrics.memoryRetrievalUsefulness, 0.5);
  assert.equal(report.aggregates[`variant:${variants[0]!.id}`]?.successRate, 1);
  assert.equal(report.aggregates[`variant:${variants[1]!.id}`]?.smallModelCompletionRate, 1);
  assert.equal(report.comparisons.length, 1);
  assert.equal(report.comparisons[0]?.delta.successRate, 0);
});

test("unattributed calls, undeclared processors, and forbidden escalation invalidate gains", async () => {
  const bad = execution();
  bad.observedModelCallCount = 3;
  bad.modelCalls.push({ processorId: "hidden-70b", provider: "remote", tier: 4, parametersBillions: 70, inputTokens: 1, outputTokens: 1, durationMs: 1, estimatedCostUsd: 0, purpose: "hidden" });
  const report = await new BenchmarkHarness({ execute: async () => bad }).run({
    tasks: [STANDARD_TASK_SUITE[0]!], variants, experimentId: "accounting"
  });
  assert.ok(report.runs.every((run) => !run.valid && !run.success));
  assert.ok(report.runs.every((run) => run.invalidReasons.some((reason) => /observed model-call|undeclared processor/.test(reason))));
  assert.equal(report.aggregates[`variant:${variants[0]!.id}`]?.validRuns, 0);
});

test("timeouts abort the adapter and remain valid failed trials instead of disappearing", async () => {
  let aborted = false;
  const slowTask: BenchmarkTask = { ...STANDARD_TASK_SUITE[0]!, id: "timeout", timeoutMs: 5 };
  const report = await new BenchmarkHarness({ execute: async ({ signal }) => new Promise<BenchmarkExecution>((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); });
  }) }).run({ tasks: [slowTask], variants, experimentId: "timeout" });
  assert.equal(aborted, true);
  assert.ok(report.runs.every((run) => run.valid && !run.success && /timed out/.test(run.error ?? "")));
});

test("standard ablations are explicit and reports persist as JSON and JSONL", async () => {
  const allVariants = createStandardVariants(processor);
  const spreading = allVariants.find((variant) => variant.ablations.includes("spreading-activation"))!;
  const procedures = allVariants.find((variant) => variant.ablations.includes("procedures"))!;
  assert.equal(spreading.config.memoryActivation?.spreadingActivationEnabled, false);
  assert.equal(procedures.config.procedures?.enabled, false);
  assert.equal(allVariants[1]!.ablations.length, 0);
  assert.deepEqual(evaluate({ kind: "contains-all", expected: ["alpha", "beta"] }, "Alpha and Beta"), { success: true, score: 1, reason: "2/2 required fragments" });

  const report = await new BenchmarkHarness({ execute: async () => execution() }).run({ tasks: [STANDARD_TASK_SUITE[0]!], variants, experimentId: "persist" });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-benchmark-"));
  try {
    const json = path.join(directory, "report.json");
    const jsonl = path.join(directory, "runs.jsonl");
    await writeBenchmarkReport(json, report);
    await writeBenchmarkRunsJsonl(jsonl, report);
    assert.equal(JSON.parse(fs.readFileSync(json, "utf8")).experimentId, "persist");
    assert.equal(fs.readFileSync(jsonl, "utf8").trim().split("\n").length, report.runs.length);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
