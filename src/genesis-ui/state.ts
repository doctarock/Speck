// The interface's persisted state.

import fs from "node:fs/promises";
import { normalizeMemoryAdmissionPolicy, type MemoryAdmissionPolicy } from "../memory/admission.js";
import { normalizeComponentSwitches } from "../speck/components/index.js";


export interface GenesisUiState {
  archivedWorkerIds: string[];
  queuePaused: boolean;
  app: Record<string, unknown>;
  toolApprovals: Record<string, boolean>;
  memoryAdmission: MemoryAdmissionPolicy;
  // Switches for default-path components that add time or features without
  // improving answers (src/speck/components/index.ts).
  components: Record<string, boolean>;
  cronJobs: GenesisCronJob[];
  cronEvents: Array<Record<string, unknown>>;
}

export interface GenesisCronJob {
  id: string;
  name: string;
  every: string;
  everyMs: number;
  message: string;
  brainId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export async function loadState(statePath: string): Promise<GenesisUiState> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return {
      archivedWorkerIds: Array.isArray(parsed.archivedWorkerIds) ? parsed.archivedWorkerIds.map(String) : [],
      queuePaused: parsed.queuePaused === true,
      app: parsed.app && typeof parsed.app === "object" ? parsed.app : {},
      toolApprovals: parsed.toolApprovals && typeof parsed.toolApprovals === "object" ? parsed.toolApprovals : {},
      memoryAdmission: normalizeMemoryAdmissionPolicy(parsed.memoryAdmission),
      components: normalizeComponentSwitches(parsed.components),
      cronJobs: Array.isArray(parsed.cronJobs) ? parsed.cronJobs : [],
      cronEvents: Array.isArray(parsed.cronEvents) ? parsed.cronEvents : []
    };
  } catch {
    return { archivedWorkerIds: [], queuePaused: false, app: {}, toolApprovals: {}, memoryAdmission: normalizeMemoryAdmissionPolicy(null), components: {}, cronJobs: [], cronEvents: [] };
  }
}
