// Tool intents: the Tool Caller's proposal of an operation (with its
// arguments normalised to the tool's schema), its execution as a prediction
// compared with the observed outcome, and recovery of executions a crash
// interrupted.
import { randomUUID } from "node:crypto";
import { isRecord, RuntimeService } from "../core.js";
import { isPredictionSpec } from "./predictions.js";
export class ToolIntentService extends RuntimeService {
    runtime;
    predictions;
    constructor(core, runtime, predictions) {
        super(core);
        this.runtime = runtime;
        this.predictions = predictions;
    }
    async proposeToolIntent(input) {
        const registered = this.runtime.toolRegistry.list();
        if (!registered.length)
            throw new TypeError("No tools are registered");
        const request = input.request.trim();
        if (!request)
            throw new TypeError("Tool request is required");
        // The action text is another model's paraphrase; the user's own request is
        // the source of names and values, so the Tool Caller sees both.
        const objective = this.workers.require(input.workerId).objective.description.trim();
        // Shortcut S32 (docs/COGNITIVE_SHORTCUTS.md): only the tools on the
        // message's topic are offered (the toolbelt). Without the encoder every
        // tool is, as before. Nothing on topic means no tool runs, and the Tool
        // Caller is not asked.
        const usedTools = new Set(this.runtime.mentalObjects.listForWorker(input.workerId)
            .filter((object) => object.kind === "tool-outcome")
            .map((object) => String(object.data.toolInvocation?.tool ?? "")));
        const belt = await this.runtime.toolbelt.select({
            tools: registered, topic: objective && objective !== request ? `${objective}
${request}` : request, usedTools
        });
        const tools = belt ? registered.filter((tool) => belt.tools.includes(tool.name)) : registered;
        await this.runtime.setWorldState({
            workerId: input.workerId, key: "speck.toolbelt", epistemicStatus: "observed", confidence: 1,
            value: belt ? { tools: tools.map((tool) => tool.name), reasons: belt.reasons } : { tools: tools.map((tool) => tool.name), reasons: {}, encoder: "unavailable" },
            actor: { kind: "runtime", source: "toolbelt" }
        });
        if (!tools.length)
            throw new NoApplicableToolError(request);
        const available = tools.map((tool) => {
            const parameters = Object.entries(tool.inputSchema).map(([name, schema]) => schema.composed
                ? `${name}: written separately, leave out`
                : `${name}:${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}${schema.required ? " required" : " optional"}`).join(", ");
            return `${tool.intents.join("/")}: ${tool.description} [${tool.risk}] arguments={${parameters}}`;
        }).join("\n");
        // Without a configured Tool Caller, the registry picks by the tool-use
        // specialty, unless competence routing has evidence to choose by.
        const configuredToolCaller = this.config.modelRuntime.roles.toolCaller;
        const routedToolCaller = this.config.modelRuntime.routing === "competence" ? this.runtime.processorForRole("toolCaller")
            : configuredToolCaller && this.runtime.modelRegistry.has(configuredToolCaller) ? configuredToolCaller : "";
        const processorId = input.processorId ?? (routedToolCaller || undefined);
        const userRequest = objective && objective !== request ? `USER REQUEST:\n${objective}\n\n` : "";
        const situation = input.situation?.trim() ? `\n\n${input.situation.trim()}` : "";
        const inferred = await this.runtime.inferForWorker({
            workerId: input.workerId,
            ...(processorId ? { processorId } : {}),
            specialty: "tool-use",
            contextScope: "minimal",
            tools: tools.map(nativeToolDefinition),
            system: "Call one of the provided tools when one must run next to fulfil the user's request. If no tool needs to run, reply briefly without calling a tool. Do not answer the request yourself.",
            nativeInstruction: `${userRequest}REQUEST:\n${request}${situation}`,
            instruction: `Decide whether one of the listed tools must run next to fulfil the request below, and if so give that one invocation. Use intent "${NO_TOOL_INTENT}" only when no tool needs to run. Do not answer the request yourself.\n${userRequest}ACTION:\n${request}${situation}\n\nTOOLS:\n${available}`,
            contract: {
                name: "tool-intent",
                // Bare field names left small models guessing (a tool name in target,
                // "none" in intent), so each field says what it holds.
                description: "intent: the name of the tool to run, or \"none\". target: the main thing that tool acts on, such as a file or service name, if any. arguments: the tool's argument values.",
                required: ["intent", "arguments"],
                properties: {
                    // A closed choice without an abstain option forces a tool onto
                    // actions no tool can perform.
                    intent: { type: "string", enum: [...new Set(tools.flatMap((tool) => tool.intents)), NO_TOOL_INTENT] },
                    target: { type: "string" },
                    arguments: { type: "object" }
                },
                additionalProperties: false
            },
            ...(input.actor ? { actor: input.actor } : {})
        });
        const structured = inferred.response.structured;
        if (structured.intent === NO_TOOL_INTENT)
            throw new NoApplicableToolError(request);
        const target = structured.target === undefined ? null : String(structured.target);
        // The tool's success criterion is fixed by Speck (actualOutcome ===
        // "succeeded"), so the expected outcome is derived rather than authored.
        const unresolved = {
            intent: String(structured.intent),
            target,
            arguments: structured.arguments,
            expectedOutcome: ""
        };
        let resolved;
        try {
            resolved = this.runtime.toolRegistry.resolve(unresolved);
        }
        catch (error) {
            // Naming a tool that does not exist is the Tool Caller's failure.
            this.runtime.recordJudgment({
                producerId: inferred.response.processorId, contract: "tool-intent", protocol: inferred.response.toolCalling ?? "json",
                aspect: "execution", evaluator: "deterministic", verdict: "rejected", deterministicOutcome: "unknown-tool",
                context: { requested: unresolved.intent, request }
            });
            throw error;
        }
        const intent = {
            ...unresolved,
            arguments: normalizeProposedToolArguments(resolved.definition, unresolved.arguments, target, request),
            expectedOutcome: `${resolved.definition.name} succeeds`
        };
        return { intent, response: inferred.response, object: inferred.object };
    }
    async executeToolIntent(input) {
        this.workers.require(input.workerId);
        const registered = this.runtime.toolRegistry.resolve(input.intent);
        this.runtime.toolRegistry.validateArguments(registered.definition, input.intent.arguments);
        this.runtime.toolRegistry.assertAuthorized(registered.definition, input.authorization);
        const executionId = randomUUID();
        const startedAt = new Date().toISOString();
        const operationActor = {
            ...(input.actor ?? { kind: "runtime", source: "tool-runtime" }),
            correlationId: input.actor?.correlationId ?? executionId
        };
        const prediction = await this.runtime.createMentalObject({
            workerId: input.workerId,
            kind: "prediction",
            content: input.intent.expectedOutcome.trim() || `Execute ${registered.definition.name}`,
            data: {
                prediction: {
                    status: "pending",
                    spec: {
                        description: input.intent.expectedOutcome.trim() || `${registered.definition.name} succeeds`,
                        confidence: 0.8,
                        sourceChannel: `tool:${registered.definition.name}`,
                        conditions: [{ path: "actualOutcome", operator: "equals", value: "succeeded" }]
                    },
                    comparison: null,
                    observationId: null
                },
                toolExecution: {
                    executionId, status: "pending", intent: input.intent.intent,
                    target: input.intent.target ?? null, tool: registered.definition.name,
                    parameters: input.intent.arguments, risk: registered.definition.risk,
                    startedAt, authorizedBy: input.authorization?.approvedBy ?? null
                }
            },
            memoryRoles: this.runtime.memoryAdmissionPolicy.predictionEpisodes ? ["episodic"] : [],
            actor: operationActor
        });
        const startEvent = this.makeEvent(input.workerId, "tool.execution-started", {
            executionId, predictionId: prediction.id, tool: registered.definition.name,
            intent: input.intent.intent, risk: registered.definition.risk
        }, operationActor, startedAt);
        await this.eventBus.dispatch(this.database.transaction(() => this.eventBus.persist(startEvent)));
        const started = Date.now();
        let output = null;
        let status = "succeeded";
        let error = null;
        try {
            output = await this.runtime.toolRegistry.execute(registered, input.intent.arguments, {
                workerId: input.workerId, executionId, intent: input.intent,
                signal: input.signal ?? new AbortController().signal
            }, this.config.toolRuntime.timeoutMs);
            output = toPersistable(output);
            if (isRecord(output) && output.ok === false) {
                status = "failed";
                error = String(output.error ?? "Tool reported failure");
            }
        }
        catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
            status = caught instanceof Error && caught.name === "AbortError" ? "unknown-outcome" : "failed";
        }
        const completedAt = new Date().toISOString();
        const record = {
            executionId,
            workerId: input.workerId,
            intent: input.intent.intent,
            target: input.intent.target ?? null,
            tool: registered.definition.name,
            parameters: input.intent.arguments,
            risk: registered.definition.risk,
            expectedOutcome: input.intent.expectedOutcome,
            actualOutcome: status,
            output,
            stdout: typeof output === "string" ? output : isRecord(output) && typeof output.text === "string" ? output.text : "",
            stderr: error ?? "",
            exitCode: isRecord(output) && typeof output.exitCode === "number" && Number.isFinite(output.exitCode)
                ? output.exitCode : null,
            error,
            durationMs: Math.max(0, Date.now() - started),
            sideEffects: registered.definition.sideEffects,
            startedAt,
            completedAt,
            authorizedBy: input.authorization?.approvedBy ?? null
        };
        const predictionState = prediction.data.prediction;
        const predictionSpec = predictionState.spec;
        const comparison = this.config.predictiveLoop.enabled
            ? this.predictions.computePredictionComparison(input.workerId, prediction.id, predictionSpec, record)
            : null;
        const updatedPrediction = {
            ...prediction,
            data: {
                ...prediction.data,
                prediction: comparison
                    ? { ...predictionState, status: "resolved", comparison }
                    : predictionState,
                toolExecution: { ...prediction.data.toolExecution, status, completedAt }
            },
            lastAccessedAt: completedAt
        };
        const toolActor = {
            kind: "tool", source: registered.definition.name, actorId: registered.definition.source,
            correlationId: operationActor.correlationId ?? executionId
        };
        const summary = summarizeToolRecord(record);
        let outcome = this.makeMentalObjectRecord({
            workerId: input.workerId,
            kind: "tool-outcome",
            content: summary,
            data: { toolInvocation: record, predictionId: prediction.id, ...(comparison ? { predictionComparison: comparison } : {}) },
            confidence: status === "unknown-outcome" ? 0 : 1,
            importance: status === "succeeded" ? 0.5 : 0.8,
            memoryRoles: ["episodic"],
            actor: toolActor
        }, completedAt);
        if (comparison) {
            outcome = { ...outcome, importance: Math.max(outcome.importance, comparison.errorMagnitude) };
            updatedPrediction.data = {
                ...updatedPrediction.data,
                prediction: { ...updatedPrediction.data.prediction, observationId: outcome.id }
            };
        }
        const evidence = this.makeMentalObjectRecord({
            workerId: input.workerId,
            kind: "evidence",
            content: summary,
            data: {
                source: `tool:${registered.definition.name}`,
                reliability: status === "unknown-outcome" ? 0 : this.config.toolRuntime.evidenceReliability,
                supports: [], contradicts: [], outcomeId: outcome.id,
                ...(comparison ? { predictionComparison: comparison, predictionId: prediction.id } : {})
            },
            confidence: 0.5,
            importance: 0.5,
            memoryRoles: ["evidence"],
            actor: toolActor
        }, completedAt);
        const currentWorker = this.workers.require(input.workerId);
        const effectsWorker = comparison ? this.predictions.applyPredictionEffects(currentWorker, comparison, completedAt) : currentWorker;
        const updatedWorker = {
            ...effectsWorker,
            evidence: [...currentWorker.evidence, evidence.id],
            updatedAt: completedAt,
            revision: currentWorker.revision + 1
        };
        const outcomeEvent = this.makeEvent(input.workerId, "mental-object.created", {
            objectId: outcome.id, kind: outcome.kind
        }, toolActor, completedAt);
        const evidenceEvent = this.makeEvent(input.workerId, "evidence.recorded", {
            objectId: evidence.id, source: `tool:${registered.definition.name}`
        }, toolActor, completedAt);
        const completedEvent = this.makeEvent(input.workerId, "tool.execution-completed", {
            executionId, predictionId: prediction.id, outcomeId: outcome.id, evidenceId: evidence.id,
            tool: record.tool, status: record.actualOutcome, durationMs: record.durationMs,
            predictionError: comparison?.errorMagnitude ?? null,
            precisionWeightedSurprise: comparison?.precisionWeightedSurprise ?? null,
            operationalMode: updatedWorker.operationalState.mode,
            pressure: updatedWorker.operationalState.pressure
        }, toolActor, completedAt);
        const persistedEvents = this.database.transaction(() => {
            this.mentalObjects.update(updatedPrediction);
            this.mentalObjects.insert(outcome);
            this.mentalObjects.insert(evidence);
            this.workers.update(updatedWorker, currentWorker.revision);
            return [outcomeEvent, evidenceEvent, completedEvent].map((event) => this.eventBus.persist(event));
        });
        for (const event of persistedEvents)
            await this.eventBus.dispatch(event);
        this.telemetry.increment("mental_objects.tool-outcome.created");
        this.telemetry.increment("mental_objects.evidence.created");
        this.telemetry.increment(`tools.${status}`);
        return { record, prediction: updatedPrediction, outcome, evidence };
    }
    async recoverInterruptedToolExecutions() {
        const pending = this.mentalObjects.listAll().filter((object) => {
            if (object.kind !== "prediction" || !isRecord(object.data.toolExecution))
                return false;
            return object.data.toolExecution.status === "pending" && object.workerId !== null;
        });
        for (const prediction of pending) {
            const execution = prediction.data.toolExecution;
            const completedAt = new Date().toISOString();
            const predictionState = isRecord(prediction.data.prediction) ? prediction.data.prediction : null;
            const comparison = this.config.predictiveLoop.enabled && predictionState && isPredictionSpec(predictionState.spec)
                ? this.predictions.computePredictionComparison(prediction.workerId, prediction.id, predictionState.spec, { actualOutcome: "unknown-outcome" })
                : null;
            const updated = {
                ...prediction,
                data: {
                    ...prediction.data,
                    toolExecution: { ...execution, status: "unknown-outcome", completedAt },
                    ...(comparison ? {
                        prediction: { ...predictionState, status: "resolved", comparison, observationId: null }
                    } : {})
                },
                lastAccessedAt: completedAt
            };
            const currentWorker = this.workers.require(prediction.workerId);
            const updatedWorker = comparison ? this.predictions.applyPredictionEffects(currentWorker, comparison, completedAt) : currentWorker;
            const event = this.makeEvent(prediction.workerId, "tool.execution-recovered", {
                executionId: execution.executionId ?? null,
                predictionId: prediction.id,
                tool: execution.tool ?? null,
                status: "unknown-outcome",
                predictionError: comparison?.errorMagnitude ?? null,
                verdict: comparison?.verdict ?? null,
                pressure: updatedWorker.operationalState.pressure,
                mode: updatedWorker.operationalState.mode
            }, { kind: "recovery", source: "startup-recovery" }, completedAt);
            const persistedEvent = this.database.transaction(() => {
                this.mentalObjects.update(updated);
                if (comparison)
                    this.workers.update(updatedWorker, currentWorker.revision);
                return this.eventBus.persist(event);
            });
            await this.eventBus.dispatch(persistedEvent);
            this.telemetry.increment("tools.unknown-outcome");
            if (comparison)
                this.telemetry.increment("predictions.uncertain");
        }
        return pending.length;
    }
}
function summarizeToolRecord(record) {
    const detail = record.error ?? (record.stdout || safeJson(record.output));
    return `${record.tool} ${record.actualOutcome}${detail ? `: ${detail.slice(0, 2_000)}` : ""}`;
}
function safeJson(value) {
    try {
        return value === null || value === undefined ? "" : JSON.stringify(value);
    }
    catch {
        return "[unserializable tool output]";
    }
}
function toPersistable(value) {
    if (value === undefined)
        return null;
    try {
        return JSON.parse(JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested));
    }
    catch {
        return { unserializable: true, preview: String(value) };
    }
}
const NO_TOOL_INTENT = "none";
// A registered tool in the provider's native function format. Composed
// arguments are left out: the Worker writes them after the call is chosen.
function nativeToolDefinition(tool) {
    const parameters = Object.entries(tool.inputSchema).filter(([, schema]) => !schema.composed);
    return {
        name: tool.name,
        description: tool.description,
        parameters: {
            type: "object",
            properties: Object.fromEntries(parameters.map(([name, schema]) => [name, {
                    type: schema.type, ...(schema.enum ? { enum: schema.enum } : {})
                }])),
            required: parameters.filter(([, schema]) => schema.required).map(([name]) => name)
        }
    };
}
// Values whose type differs from the declared one only in representation
// ("5" for a number, "true" for a boolean) are converted to it.
function coerceToSchema(value, schema) {
    const types = [schema.type].flat();
    if (typeof value === "string") {
        const text = value.trim();
        if (!types.includes("string") && types.includes("number") && text !== "" && Number.isFinite(Number(text)))
            return Number(text);
        if (!types.includes("string") && types.includes("boolean") && /^(true|false)$/i.test(text))
            return text.toLowerCase() === "true";
    }
    if ((typeof value === "number" || typeof value === "boolean") && types.length === 1 && types[0] === "string")
        return String(value);
    return value;
}
// The Tool Caller judged that no registered tool applies. This is an answer,
// not a failure: callers continue without a tool.
export class NoApplicableToolError extends TypeError {
    constructor(request) {
        super(`No registered tool can perform: ${request}`);
        this.name = "NoApplicableToolError";
    }
}
function normalizeProposedToolArguments(definition, proposed, target, request) {
    // Some tool callers put a placeholder object around arguments even when a
    // tool declares none. There is no value to map, so discard only this exact
    // wrapper; ordinary unknown arguments still fail strict validation.
    if (Object.keys(definition.inputSchema).length === 0
        && Object.keys(proposed).length === 1 && isRecord(proposed.object))
        return {};
    const normalized = { ...proposed };
    for (const [name, schema] of Object.entries(definition.inputSchema)) {
        if (normalized[name] !== undefined)
            normalized[name] = coerceToSchema(normalized[name], schema);
    }
    if ("file" in definition.inputSchema && normalized.file === undefined) {
        const alias = normalized.filename ?? normalized.path ?? target;
        if (alias !== undefined && alias !== null && String(alias).trim())
            normalized.file = normalizeSpokenFilename(String(alias));
        delete normalized.filename;
        delete normalized.path;
    }
    if ("file" in definition.inputSchema && normalized.file !== undefined) {
        normalized.file = normalizeSpokenFilename(String(normalized.file));
    }
    if ("url" in definition.inputSchema && normalized.url === undefined) {
        const alias = normalized.href ?? normalized.uri ?? normalized.link ?? target ?? extractHttpUrl(request);
        if (alias !== undefined && alias !== null && String(alias).trim())
            normalized.url = String(alias).trim();
        delete normalized.href;
        delete normalized.uri;
        delete normalized.link;
    }
    if ("target" in definition.inputSchema && normalized.target === undefined && target)
        normalized.target = target;
    // The target is the object the action applies to. When exactly one required
    // argument is still missing, it is the only place that object can belong.
    // Composed arguments are written later by the Worker; whatever the Tool
    // Caller put there is discarded so that it never authors content.
    for (const [name, schema] of Object.entries(definition.inputSchema))
        if (schema.composed)
            delete normalized[name];
    // Shortcut S12 (docs/COGNITIVE_SHORTCUTS.md).
    const missing = Object.entries(definition.inputSchema)
        .filter(([, schema]) => schema.required && !schema.composed)
        .filter(([name]) => normalized[name] === undefined);
    if (target?.trim() && missing.length === 1 && [missing[0][1].type].flat().includes("string")) {
        normalized[missing[0][0]] = target.trim();
    }
    return normalized;
}
// Shortcut S13 (docs/COGNITIVE_SHORTCUTS.md).
function normalizeSpokenFilename(value) {
    return value.trim().replace(/\s+dot\s+([a-z0-9]{1,16})\b/gi, ".$1");
}
function extractHttpUrl(value) {
    const match = value.match(/https?:\/\/[^\s<>"']+/i);
    return match?.[0].replace(/[),.;!?]+$/, "");
}
//# sourceMappingURL=tool-intents.js.map