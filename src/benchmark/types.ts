import type { SpeckConfigOverrides } from "../config.js";

export const BENCHMARK_CATEGORIES = [
  "coding", "debugging", "server-administration", "research", "file-manipulation",
  "multi-step-tool-use", "planning", "long-running"
] as const;
export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];

export type BenchmarkEvaluator =
  | { kind: "exact"; expected: unknown }
  | { kind: "contains-all"; expected: string[]; caseSensitive?: boolean }
  | { kind: "object-fields"; expected: Record<string, unknown> };

export interface BenchmarkTask {
  schema: "speck-benchmark-task/v1";
  id: string;
  category: BenchmarkCategory;
  description: string;
  prompt: string;
  setup: Record<string, unknown>;
  evaluator: BenchmarkEvaluator;
  timeoutMs: number;
  tags: string[];
}

export interface BenchmarkProcessor {
  id: string;
  provider: string;
  tier: number;
  parametersBillions: number;
}

export interface BenchmarkVariant {
  schema: "speck-benchmark-variant/v1";
  id: string;
  comparisonGroup: string;
  architecture: "minimal-agent" | "speck";
  primaryProcessor: BenchmarkProcessor;
  allowedProcessors: BenchmarkProcessor[];
  allowEscalation: boolean;
  config: SpeckConfigOverrides;
  ablations: string[];
}

export interface ModelCallMeasurement {
  processorId: string;
  provider: string;
  tier: number;
  parametersBillions: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  estimatedCostUsd: number;
  purpose: string;
}

export interface ToolCallMeasurement {
  tool: string;
  successful: boolean;
  durationMs: number;
}

export interface CognitiveMeasurements {
  impasses: number;
  successfulImpasseRecoveries: number;
  procedureHits: number;
  knownAnswerHits: number;
  memoryRetrievals: number;
  usefulMemoryRetrievals: number;
  contextTokens: number;
  repeatedStateCount: number;
  llmCallsAvoided: number;
  tokensAvoided: number;
}

export interface BenchmarkExecution {
  output: unknown;
  modelCalls: ModelCallMeasurement[];
  observedModelCallCount: number;
  toolCalls: ToolCallMeasurement[];
  cognitive: CognitiveMeasurements;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkExecutionContext {
  experimentId: string;
  task: BenchmarkTask;
  variant: BenchmarkVariant;
  repetition: number;
  seed: number;
  signal: AbortSignal;
}

export interface BenchmarkExecutor {
  execute(context: BenchmarkExecutionContext): Promise<BenchmarkExecution>;
}

export interface BenchmarkRunMetrics extends CognitiveMeasurements {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  tokensToCompletion: number;
  modelCalls: number;
  largestModelBillions: number;
  averageModelBillions: number;
  toolCalls: number;
  failedToolCalls: number;
  escalations: number;
  estimatedCostUsd: number;
  proceduralFastPathRate: number;
  knownAnswerHitRate: number;
  memoryRetrievalUsefulness: number;
  escalationFrequency: number;
}

export interface BenchmarkRunRecord {
  schema: "speck-benchmark-run/v1";
  harnessVersion: string;
  runId: string;
  experimentId: string;
  taskId: string;
  taskHash: string;
  category: BenchmarkCategory;
  variantId: string;
  variantHash: string;
  comparisonGroup: string;
  architecture: BenchmarkVariant["architecture"];
  primaryProcessor: BenchmarkProcessor;
  repetition: number;
  seed: number;
  startedAt: string;
  completedAt: string;
  valid: boolean;
  invalidReasons: string[];
  success: boolean;
  score: number;
  evaluationReason: string;
  error: string | null;
  metrics: BenchmarkRunMetrics;
  execution: BenchmarkExecution | null;
}

export interface AggregateMetrics {
  runs: number;
  validRuns: number;
  invalidRuns: number;
  successRate: number;
  meanScore: number;
  meanDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  meanTokens: number;
  meanModelCalls: number;
  meanToolCalls: number;
  meanCostUsd: number;
  smallModelCompletionRate: number;
  escalationFrequency: number;
  proceduralFastPathRate: number;
  knownAnswerHitRate: number;
  memoryRetrievalUsefulness: number;
}

export interface BenchmarkReport {
  schema: "speck-benchmark-report/v1";
  harnessVersion: string;
  experimentId: string;
  seed: number;
  repetitions: number;
  startedAt: string;
  completedAt: string;
  taskHashes: Record<string, string>;
  variantHashes: Record<string, string>;
  runs: BenchmarkRunRecord[];
  aggregates: Record<string, AggregateMetrics>;
  comparisons: BenchmarkComparison[];
}

export interface BenchmarkComparison {
  comparisonGroup: string;
  baselineVariantId: string;
  candidateVariantId: string;
  baselineValidRuns: number;
  candidateValidRuns: number;
  delta: {
    successRate: number;
    meanScore: number;
    meanDurationMs: number;
    meanTokens: number;
    meanModelCalls: number;
    meanCostUsd: number;
    smallModelCompletionRate: number;
  };
}
