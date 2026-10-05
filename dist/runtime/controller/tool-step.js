// The tool step of a cycle: the Tool Caller decides whether a registered tool
// still has to act and with which arguments; the Worker writes any free-text
// content; Speck checks approval, deduplicates, runs it, and records what
// happened as evidence about each role.
import { NoApplicableToolError } from "../speck-runtime.js";
import { composedArgumentContract } from "./contracts.js";
import { stableKey } from "./statements.js";
import { actor, roleProcessor } from "./support.js";
export class ToolStep {
    runtime;
    view;
    options;
    constructor(runtime, view, options) {
        this.runtime = runtime;
        this.view = view;
        this.options = options;
    }
    async attempt(worker, request, situation) {
        if (!request.trim() || this.runtime.toolRegistry.list().length === 0) {
            return { waiting: true, message: "A tool is required, but no suitable tool is available.", successful: false };
        }
        let proposed;
        let registered;
        try {
            proposed = await this.runtime.proposeToolIntent({ workerId: worker.id, request, ...(situation ? { situation } : {}), actor: actor("tool-routing") });
            await this.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: [proposed.object.id], actor: actor("tool-routing") });
            registered = this.runtime.toolRegistry.resolve(proposed.intent);
            // Invalid arguments are a rejected proposal like any other, reported
            // back to the worker rather than thrown out of the controller. Composed
            // arguments are checked after the Worker has written them.
            this.runtime.toolRegistry.validateArguments({ ...registered.definition, inputSchema: Object.fromEntries(Object.entries(registered.definition.inputSchema).filter(([, schema]) => !schema.composed)) }, proposed.intent.arguments);
        }
        catch (error) {
            if (error instanceof NoApplicableToolError)
                return { waiting: false, message: error.message, successful: false, noTool: true };
            // A resolved tool with unusable arguments is the Tool Caller's failure.
            // (An unresolved tool name is recorded where it is resolved.)
            if (proposed && registered) {
                this.runtime.recordJudgment({
                    producerId: proposed.response.processorId, contract: "tool-intent", protocol: proposed.response.toolCalling ?? "json",
                    aspect: "execution", evaluator: "deterministic", verdict: "rejected", deterministicOutcome: "invalid-arguments",
                    context: { tool: registered.definition.name, request, error: error instanceof Error ? error.message : String(error) }
                });
            }
            const message = error instanceof Error ? error.message : String(error);
            await this.runtime.setWorldState({
                workerId: worker.id, key: "genesis.latestToolOutcome",
                value: { request, status: "invalid-intent", error: message },
                epistemicStatus: "observed", confidence: 1, actor: actor("tool-routing")
            });
            await this.runtime.createMentalObject({
                workerId: worker.id, kind: "observation", content: `Tool intent rejected before execution: ${message}`,
                memoryRoles: ["working"], confidence: 1, importance: 0.8,
                data: { cognitiveRole: "tool-routing", request, error: message }, actor: actor("tool-routing")
            });
            return { waiting: false, message, successful: false };
        }
        if (this.options.isToolApproved?.(registered.definition.name) === false)
            return { waiting: true, message: `Tool ${registered.definition.name} is disabled in System → Capabilities.` };
        const authorization = registered.definition.risk === "read-only"
            ? undefined
            : this.options.getToolAuthorization?.(registered.definition.name);
        if (registered.definition.risk !== "read-only" && authorization?.approved !== true) {
            return { waiting: true, message: `Approval required for ${registered.definition.name} (${registered.definition.risk}).`, successful: false };
        }
        const latest = this.runtime.getWorker(worker.id)?.worldState["genesis.latestToolOutcome"]?.value;
        if (latest?.status === "succeeded" && latest.tool === registered.definition.name
            && stableKey(structuralArguments(registered.definition, latest.arguments)) === stableKey(structuralArguments(registered.definition, proposed.intent.arguments))) {
            return { waiting: false, message: "already-succeeded", successful: false, duplicate: true };
        }
        const composed = await this.composeArguments(worker, registered.definition, proposed.intent);
        if (!composed) {
            return { waiting: false, message: "The worker did not write the content this operation needs.", successful: false };
        }
        proposed = { ...proposed, intent: composed };
        const result = await this.runtime.executeToolIntent({
            workerId: worker.id, intent: proposed.intent, actor: actor("controller"),
            ...(authorization ? { authorization } : {})
        });
        await this.runtime.setWorldState({
            workerId: worker.id,
            key: "genesis.latestToolOutcome",
            value: {
                tool: registered.definition.name,
                intent: proposed.intent.intent,
                arguments: proposed.intent.arguments,
                request,
                status: result.record.actualOutcome,
                output: result.record.output
            },
            epistemicStatus: "observed",
            confidence: result.record.actualOutcome === "succeeded" ? 1 : 0.5,
            actor: actor("tool-outcome")
        });
        if (this.runtime.config.metacognition.enabled) {
            await this.runtime.recordModelOutcome({
                workerId: worker.id, processorId: proposed.response.processorId,
                reportedConfidence: proposed.response.confidence,
                reward: result.record.actualOutcome === "succeeded" ? 1 : 0,
                sourceObjectId: proposed.object.id, actor: actor("tool-routing-calibration")
            });
        }
        // Running is evidence about execution, not about whether this was the
        // right action (selection) or whether it helped (result); those are kept
        // as unobserved with their provenance until something can judge them.
        // A tool that ran and failed says more about the environment than the
        // call, so its execution is unobserved too.
        const toolContext = { tool: registered.definition.name, arguments: structuralArguments(registered.definition, proposed.intent.arguments), request, workerId: worker.id };
        const judged = { producerId: proposed.response.processorId, contract: "tool-intent", protocol: proposed.response.toolCalling ?? "json", context: toolContext };
        this.runtime.recordJudgment({
            ...judged, aspect: "execution", evaluator: "deterministic",
            verdict: result.record.actualOutcome === "succeeded" ? "accepted" : "unobserved",
            deterministicOutcome: result.record.actualOutcome === "succeeded" ? "executed" : `execution-${result.record.actualOutcome}`
        });
        for (const aspect of ["selection", "result"]) {
            this.runtime.recordJudgment({ ...judged, aspect, evaluator: null, verdict: "unobserved", deterministicOutcome: null });
        }
        return {
            waiting: false, message: result.record.actualOutcome,
            successful: result.record.actualOutcome === "succeeded", intent: proposed.intent, outcome: result.outcome
        };
    }
    // Free-text arguments (file contents, messages, memories) are generation,
    // which belongs to the Worker. The Tool Caller only chose the operation.
    async composeArguments(worker, definition, intent) {
        const names = Object.entries(definition.inputSchema).filter(([, schema]) => schema.composed).map(([name]) => name);
        if (!names.length)
            return intent;
        const processorId = this.runtime.getWorker(worker.id)?.modelAssignment?.processorId || roleProcessor(this.runtime, "worker");
        const settled = Object.entries(intent.arguments).filter(([name]) => !names.includes(name))
            .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(", ");
        const arguments_ = { ...intent.arguments };
        for (const name of names) {
            try {
                const written = await this.runtime.inferForWorker({
                    workerId: worker.id, ...(processorId ? { processorId } : {}), contract: composedArgumentContract,
                    contextScope: "minimal",
                    instruction: `Write the "${name}" for the operation below, exactly as it should be stored or sent.\nOperation: ${definition.name}: ${definition.description}${settled ? `\nAlready decided: ${settled}` : ""}${this.view.taskContext(worker)}\nUser request: ${this.view.currentMessage(worker)}${this.view.conversationInstruction(worker)}`,
                    actor: actor("tool-content")
                });
                const text = typeof written.response.structured?.text === "string" ? written.response.structured.text : "";
                if (!text.trim())
                    return null;
                arguments_[name] = text;
            }
            catch {
                return null;
            }
        }
        return { ...intent, arguments: arguments_ };
    }
}
// The operation is identified by its non-composed arguments; written content
// differs on every attempt and does not make an operation new.
// Shortcut S11 (docs/COGNITIVE_SHORTCUTS.md).
export function structuralArguments(definition, value) {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.fromEntries(Object.entries(record).filter(([name]) => !definition.inputSchema[name]?.composed));
}
//# sourceMappingURL=tool-step.js.map