import type { WorkerId } from "../types/ids.js";

export const TOOL_RISK_CLASSES = [
  "read-only", "reversible-mutation", "destructive-mutation", "external-side-effect"
] as const;
export type ToolRiskClass = (typeof TOOL_RISK_CLASSES)[number];

export type ToolParameterType = "string" | "number" | "boolean" | "object" | "array";

export interface ToolParameterSchema {
  type: ToolParameterType | ToolParameterType[];
  required?: boolean;
  enum?: Array<string | number | boolean>;
  // What the value is, for the Tool Caller (names alone left a small one
  // putting the area in `directory` and a file name in `scope`).
  description?: string;
  // Free text the assistant writes (a document, message, or memory), as
  // opposed to an identifier or value taken from the request. Composed
  // arguments are written by the Worker, never by the Tool Caller.
  // Shortcut S14 (docs/COGNITIVE_SHORTCUTS.md).
  composed?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  intents: string[];
  inputSchema: Record<string, ToolParameterSchema>;
  outputSchema?: Record<string, ToolParameterSchema>;
  risk: ToolRiskClass;
  sideEffects: string[];
  requiredPermissions: string[];
  source: string;
  // The plugin a tool came with, if any: what the toolbelt reads to tell
  // whose board or campaign a terse description is about.
  family?: { id: string; name: string; description: string; topics?: { keywords: string[]; examples: string[] } };
}

export interface ToolIntent {
  intent: string;
  target?: string | null;
  arguments: Record<string, unknown>;
  expectedOutcome: string;
}

export interface ToolAuthorization {
  approved: boolean;
  approvedBy: string;
  reason?: string;
  permissions?: string[];
}

export interface ToolExecutionContext {
  workerId: WorkerId;
  executionId: string;
  intent: ToolIntent;
  signal: AbortSignal;
}

export type ToolExecutor = (arguments_: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;

export type ToolOutcomeStatus = "succeeded" | "failed" | "unknown-outcome";

export interface ToolInvocationRecord {
  executionId: string;
  workerId: WorkerId;
  intent: string;
  target: string | null;
  tool: string;
  parameters: Record<string, unknown>;
  risk: ToolRiskClass;
  expectedOutcome: string;
  actualOutcome: ToolOutcomeStatus;
  output: unknown;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  durationMs: number;
  sideEffects: string[];
  startedAt: string;
  completedAt: string;
  authorizedBy: string | null;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}
