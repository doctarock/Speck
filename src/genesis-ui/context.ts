// What the interface's route modules share: the Express app, the runtime and
// its configuration, the persisted interface state, and the event streams.

import { type Express, type Response } from "express";
import type { SpeckConfig } from "../config.js";
import type { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { SecretStore } from "../security/secret-store.js";

import { GenesisUiState } from "./state.js";

export interface UiContext {
  app: Express;
  runtime: SpeckRuntime;
  config: SpeckConfig;
  options: { speckRoot: string; profile: Record<string, any>; profileRoot: string; startedAt: number; secretStore: SecretStore };
  state: GenesisUiState;
  // Workers hidden from the task lists.
  archived: Set<string>;
  saveState(): Promise<void>;
  broadcastLog(line: string): void;
  logClients: Set<Response>;
  eventClients: Set<Response>;
  workspaceRoot: string;
  inboxRoot: string;
  outboxRoot: string;
}
