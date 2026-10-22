// The default path's dependencies from Speck's configuration: the configured
// worker model answers in its ordinary chat path, with room to finish its
// reasoning (as the plain-model arm of the evaluations); the intake model
// reads examples.

import type { SpeckConfig } from "../config.js";
import type { ModelRegistry } from "../models/registry.js";
import type { SpeckRuntime } from "../runtime/speck-runtime.js";
import type { RespondDependencies } from "./respond.js";

export function defaultPathDependencies(config: SpeckConfig, registry: ModelRegistry, runtime?: SpeckRuntime): RespondDependencies {
  const roles = config.modelRuntime.roles;
  const answering = config.modelRuntime.processors.find((processor) => processor.id === roles.worker);
  if (!answering) throw new Error("No worker model is configured");
  if (answering.provider !== "ollama") throw new Error(`The default path supports Ollama models; ${answering.id} is ${answering.provider}`);
  return {
    registry,
    ...(runtime ? { runtime } : {}),
    readerProcessorId: roles.intake || answering.id,
    chat: { baseUrl: answering.baseUrl, model: answering.model, temperature: config.modelRuntime.temperature, contextSize: 16_384, outputBudget: 8_192, timeoutMs: 900_000 }
  };
}
