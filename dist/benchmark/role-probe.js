import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ContextOverflowError, createConfiguredProcessor, MAX_OUTPUT_TOKENS, runtimeContextSize } from "../models/providers.js";
import { nativeToolPayload } from "../models/registry.js";
import { parseModelCompletion } from "../models/response.js";
import { SpeckController } from "../runtime/controller.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
const includes = (haystack, ...needles) => needles.every((needle) => haystack.toLowerCase().includes(needle.toLowerCase()));
const disclosed = (objects) => objects.filter((object) => object.data.verification === "validated-user-disclosure");
export const ROLE_PROBE_CASES = [
    {
        id: "conversation", role: "intake", objective: "Hi there, how is your day going?",
        check: ({ status, summary, objects, toolCalls }) => status !== "completed" || !summary.trim() ? `status ${status}`
            : toolCalls.length ? `called ${toolCalls.map((call) => call.tool).join(", ")} on a social turn`
                : disclosed(objects).length ? "stored facts from a social turn" : null
    },
    {
        // Fact capture is independent of routing, so these oracles check only what
        // was stored and where, never how the turn was classified.
        id: "disclosure", role: "fact-extraction", objective: "My name is Dana and I live in Ballarat.",
        check: ({ objects }) => {
            const shared = disclosed(objects).filter((object) => object.workerId === null).map((object) => object.content).join(" | ");
            return includes(shared, "Dana") && includes(shared, "Ballarat") ? null : `shared facts: ${shared || "none"}`;
        }
    },
    {
        // Grounding: a paraphrased fact ("Oz") must survive; the name must be shared.
        id: "disclosure-paraphrase", role: "grounding", objective: "Hi, I'm Dana and I'm from Oz.",
        check: ({ objects }) => {
            const facts = disclosed(objects);
            const shared = facts.filter((object) => object.workerId === null).map((object) => object.content).join(" | ");
            if (!includes(shared, "Dana"))
                return `shared facts: ${shared || "none"}`;
            const all = facts.map((object) => object.content).join(" | ");
            return /\b(oz|australia)/i.test(all) ? null : `origin not retained: ${all}`;
        }
    },
    {
        id: "disclosure-restricted", role: "retention", objective: "Only for this task, and do not share it anywhere else: my budget is 400 dollars.",
        check: ({ objects }) => {
            const facts = disclosed(objects);
            if (!facts.some((object) => includes(object.content, "400")))
                return "budget fact was not retained locally";
            return facts.some((object) => object.workerId === null) ? "restricted fact was written to shared memory" : null;
        }
    },
    {
        id: "direct-answer", statesNoFacts: true, role: "worker+validator", objective: "What is 17 plus 25?",
        check: ({ status, summary }) => status !== "completed" ? `status ${status}` : summary.includes("42") ? null : `answer: ${summary}`
    },
    {
        id: "read-tool", statesNoFacts: true, role: "worker+tool-caller", objective: "Is the nginx service running right now?",
        check: ({ status, toolCalls, summary }) => {
            const call = toolCalls.find((entry) => entry.tool === "service_status");
            if (!call)
                return "service_status was not invoked";
            if (!includes(String(call.arguments.service ?? ""), "nginx"))
                return `service argument ${JSON.stringify(call.arguments)}`;
            return status === "completed" && /run|active|up/i.test(summary) ? null : `status ${status}; answer: ${summary}`;
        }
    },
    {
        id: "write-tool", statesNoFacts: true, role: "worker+tool-caller", objective: "Write a two-line poem about rain and save it to the file rain dot txt",
        check: ({ status, toolCalls }) => {
            const call = toolCalls.find((entry) => entry.tool === "write_file");
            if (!call)
                return "write_file was not invoked";
            if (call.arguments.file !== "rain.txt")
                return `file argument ${JSON.stringify(call.arguments.file)}`;
            if (!String(call.arguments.content ?? "").trim())
                return "empty content";
            return status === "completed" ? null : `status ${status}`;
        }
    }
];
// Past user statements seeded into each probe runtime, standing in for the
// history a running Speck accumulates. They share no topic with the cases.
export const PROBE_HISTORY = [
    "Can you summarise yesterday's meeting notes?", "Please restart the web server.", "What time is it in London?",
    "Remind me to call the plumber tomorrow.", "Draft an email to the landlord about the heater.", "How many tasks are queued?",
    "Show me the latest build log.", "Translate this paragraph into French.", "Book a table for two on Friday.",
    "Which files changed in the last commit?", "Turn the office lights off at six.", "Find the invoice from March.",
    "List the open pull requests.", "Set a timer for twenty minutes.", "Compare the two quotes for the roof.",
    "Archive the old project folder."
];
export async function runRoleProbe(input) {
    const startedAt = new Date().toISOString();
    const cases = input.caseIds?.length ? ROLE_PROBE_CASES.filter((entry) => input.caseIds.includes(entry.id)) : ROLE_PROBE_CASES;
    if (!cases.length)
        throw new TypeError(`No probe cases match ${input.caseIds?.join(", ")}`);
    const subjects = input.bare
        ? input.processors.map((processor) => ({
            id: `${processor.id}:bare`, model: processor.model, parameters: processor.parameters ?? null,
            processors: [processor], roles: { intake: "", planner: "", worker: "", toolCaller: "", specialists: {} }
        }))
        : input.configuredRoles
            ? [{
                    id: "configured-roles",
                    model: Object.entries(input.configuredRoles).filter(([, value]) => typeof value === "string" && value)
                        .map(([role, id]) => `${role}=${input.processors.find((processor) => processor.id === id)?.model ?? id}`).join(", "),
                    parameters: Math.max(0, ...input.processors.map((processor) => processor.parameters ?? 0)) || null,
                    processors: input.processors,
                    roles: input.configuredRoles
                }]
            // A single-model run gives every role to that model. The other processors
            // are registered only so that its replies can be judged independently.
            : input.processors.map((processor) => ({
                id: processor.id, model: processor.model, parameters: processor.parameters ?? null,
                processors: input.processors,
                roles: { intake: processor.id, planner: processor.id, worker: processor.id, toolCaller: processor.id, specialists: {} }
            }));
    const results = [];
    for (const subject of subjects) {
        for (const probe of cases) {
            for (let repetition = 0; repetition < Math.max(1, input.repetitions ?? 1); repetition += 1) {
                const result = input.bare
                    ? await runBareCase(subject.processors[0], probe, repetition, input.timeoutMs)
                    : await runCase(subject, probe, repetition, input.timeoutMs, input.embeddingRuntime, input.history ?? [], input.competencePath, input.routing);
                results.push(result);
                input.onResult?.(result);
            }
        }
    }
    return { schema: "speck-role-probe/v1", startedAt, completedAt: new Date().toISOString(), results, summary: summarize(subjects, results) };
}
async function runCase(subject, probe, repetition, timeoutMs, embeddingRuntime, history, competencePath, routing) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-probe-"));
    const processors = subject.processors.map((processor) => ({ ...processor, enabled: true }));
    const runtime = new SpeckRuntime({
        databasePath: path.join(directory, "speck.sqlite"),
        genesisRuntimePath: directory,
        modelRuntime: {
            processors, roles: subject.roles, ...(timeoutMs ? { timeoutMs } : {}),
            ...(competencePath ? { competencePath } : {}), ...(routing ? { routing } : {})
        },
        ...(embeddingRuntime ? { embeddingRuntime } : {})
    });
    for (const statement of history)
        await runtime.createWorker(statement);
    const transcript = [];
    const calls = [];
    const kinds = [];
    let modelMs = 0;
    let capabilityCheckMs = 0;
    for (const descriptor of processors) {
        const live = createConfiguredProcessor(descriptor);
        runtime.modelRegistry.upsert(descriptor, {
            supportsNativeTools: async () => {
                const began = performance.now();
                try {
                    return await (live.supportsNativeTools?.() ?? false);
                }
                finally {
                    capabilityCheckMs += performance.now() - began;
                }
            },
            infer: async (request) => {
                const contract = request.contract?.name ?? null;
                let completion;
                const began = performance.now();
                try {
                    completion = await live.infer(request);
                    modelMs += performance.now() - began;
                }
                catch (error) {
                    modelMs += performance.now() - began;
                    kinds.push(error instanceof ContextOverflowError ? "context" : "transport");
                    transcript.push({ contract, prompt: request.prompt, completion: `[${descriptor.id} error] ${error instanceof Error ? error.message : String(error)}` });
                    throw error;
                }
                // The registry's own parser decides whether this reply was usable, so
                // each call is classified exactly as Speck treated it.
                const native = Boolean(request.tools?.length);
                const payload = native ? nativeToolPayload(completion.toolCalls) : completion.text;
                let kind = "ok";
                // Native calls are mapped onto their contract by the caller, so only
                // the JSON path is re-parsed here.
                if (!native) {
                    try {
                        parseModelCompletion(payload, request.contract);
                    }
                    catch {
                        kind = "contract";
                    }
                }
                kinds.push(kind);
                transcript.push({
                    contract: native ? `${contract} (native)` : contract, prompt: request.prompt,
                    completion: native ? `${payload}${completion.text.trim() ? ` | text: ${completion.text.trim()}` : ""}` : completion.text
                });
                calls.push({ contract, inputTokens: completion.inputTokens ?? null, outputTokens: completion.outputTokens ?? null, ms: Math.round(performance.now() - began) });
                return completion;
            }
        });
    }
    const toolCalls = [];
    runtime.toolRegistry.register({
        name: "service_status", description: "Read whether a system service is currently running.", intents: ["read_service_status"],
        inputSchema: { service: { type: "string", required: true } },
        risk: "read-only", sideEffects: [], requiredPermissions: [], source: "role-probe"
    }, async (args) => {
        toolCalls.push({ tool: "service_status", arguments: { ...args } });
        return { service: args.service, active: true, state: "running" };
    });
    runtime.toolRegistry.register({
        name: "write_file", description: "Write text content to a file in the workspace.", intents: ["write_workspace_file"],
        inputSchema: { file: { type: "string", required: true }, content: { type: "string", required: true, composed: true } },
        risk: "reversible-mutation", sideEffects: ["writes a workspace file"], requiredPermissions: [], source: "role-probe"
    }, async (args) => {
        toolCalls.push({ tool: "write_file", arguments: { ...args } });
        return { ok: true, file: args.file };
    });
    const started = performance.now();
    let status = "error";
    let summary = "";
    let error = null;
    try {
        let worker = await runtime.createWorker(probe.objective);
        worker = await runtime.transitionWorker(worker.id, "ready");
        const outcome = await new SpeckController(runtime, {
            isToolApproved: () => true,
            getToolAuthorization: () => ({ approved: true, approvedBy: "role-probe" })
        }).run(worker.id);
        status = outcome.status;
        summary = outcome.summary;
    }
    catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    }
    const stats = runtime.modelRegistry.list();
    const routed = Object.fromEntries(["intake", "worker", "toolCaller"].map((role) => [role, runtime.processorForRole(role)]));
    const grounding = { baseline: 0, lexical: 0, grounded: 0, rejected: 0 };
    for (const object of runtime.mentalObjects.listAll()) {
        const decisions = object.data.grounding?.decisions ?? [];
        for (const decision of decisions) {
            grounding[decision.method === "baseline" ? "baseline" : "lexical"] += 1;
            grounding[decision.grounded ? "grounded" : "rejected"] += 1;
        }
    }
    const events = {};
    for (const event of runtime.listEvents(undefined, 0, 1_000_000))
        events[event.type] = (events[event.type] ?? 0) + 1;
    const objects = runtime.mentalObjects.listAll();
    const falseFacts = probe.statesNoFacts ? disclosed(objects).map((object) => object.content) : [];
    const reason = error ?? (falseFacts.length ? `stored non-facts: ${falseFacts.join(" | ")}` : probe.check({ status, summary, toolCalls, objects }));
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
    const contractFailures = kinds.filter((kind) => kind === "contract").length;
    const transportFailures = kinds.filter((kind) => kind === "transport").length;
    // A failed case is attributed to the call that ended it. If the last call
    // was usable, the outcome was a judgment the model got wrong.
    const last = kinds.at(-1) ?? "ok";
    const failureKind = reason === null ? null : last === "ok" ? "semantic" : last;
    return {
        processorId: subject.id, model: subject.model, parameters: subject.parameters,
        caseId: probe.id, role: probe.role, repetition, passed: reason === null, failureKind,
        reason: reason ?? (contractFailures ? `passed after ${contractFailures} recovered contract failure(s)` : "passed"),
        status, summary, modelCalls: kinds.length, contractFailures, transportFailures,
        lastModelError: stats.map((entry) => entry.lastError).filter(Boolean).at(-1) ?? null,
        durationMs: Math.round(performance.now() - started),
        calls,
        work: { modelMs: Math.round(modelMs), capabilityCheckMs: Math.round(capabilityCheckMs), events, grounding, routed },
        ...(reason === null ? {} : { transcript })
    };
}
function summarize(subjects, results) {
    return subjects.map((subject) => {
        const own = results.filter((result) => result.processorId === subject.id);
        const byRole = {};
        for (const caseId of [...new Set(own.map((result) => result.caseId))]) {
            const runs = own.filter((result) => result.caseId === caseId);
            byRole[caseId] = `${runs.filter((result) => result.passed).length}/${runs.length}`;
        }
        const failures = { transport: 0, context: 0, contract: 0, semantic: 0 };
        for (const result of own)
            if (result.failureKind)
                failures[result.failureKind] += 1;
        return {
            processorId: subject.id, model: subject.model, parameters: subject.parameters,
            passed: own.filter((result) => result.passed).length, total: own.length, byRole, failures
        };
    });
}
// The bare baseline: the model alone in an ordinary native tool-calling chat
// loop, with the same stub tools plus a memory tool, and none of Speck's
// roles, validation, normalization, or policy. Only Ollama is supported.
const BARE_TOOLS = [
    { name: "service_status", description: "Read whether a system service is currently running.",
        parameters: { type: "object", properties: { service: { type: "string" } }, required: ["service"] } },
    { name: "write_file", description: "Write text content to a file in the workspace.",
        parameters: { type: "object", properties: { file: { type: "string" }, content: { type: "string" } }, required: ["file", "content"] } },
    { name: "remember", description: "Store a lasting fact the user told you about themselves or their situation. Use scope \"task\" if the user limited it to this task, otherwise \"shared\". Do not store anything the user asked you not to keep.",
        parameters: { type: "object", properties: { fact: { type: "string" }, scope: { type: "string", enum: ["shared", "task"] } }, required: ["fact", "scope"] } }
];
async function runBareCase(processor, probe, repetition, timeoutMs = 120_000) {
    const started = performance.now();
    const toolCalls = [];
    const remembered = [];
    const transcript = [];
    const calls = [];
    const messages = [
        { role: "system", content: "You are a helpful assistant. Use the tools when they are needed, then reply to the user." },
        { role: "user", content: probe.objective }
    ];
    let status = "waiting";
    let summary = "";
    let error = null;
    let transportFailures = 0;
    try {
        for (let round = 0; round < 4 && status !== "completed"; round += 1) {
            const response = await fetch(`${processor.baseUrl.replace(/\/+$/, "")}/api/chat`, {
                method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
                body: JSON.stringify({
                    model: processor.model, messages, tools: BARE_TOOLS.map((tool) => ({ type: "function", function: tool })),
                    stream: false, think: false, options: { temperature: 0.2, num_ctx: runtimeContextSize(processor), num_predict: MAX_OUTPUT_TOKENS }
                })
            });
            if (!response.ok) {
                transportFailures += 1;
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }
            const parsed = await response.json();
            const message = parsed.message ?? {};
            calls.push({ contract: "bare-chat", inputTokens: parsed.prompt_eval_count ?? null, outputTokens: parsed.eval_count ?? null });
            transcript.push({ contract: "bare-chat", prompt: JSON.stringify(messages.at(-1)), completion: JSON.stringify(message) });
            messages.push({ role: "assistant", content: message.content ?? "", ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) });
            if (!message.tool_calls?.length) {
                summary = String(message.content ?? "").trim();
                status = "completed";
                break;
            }
            for (const call of message.tool_calls) {
                const name = String(call.function?.name ?? "");
                let args = call.function?.arguments ?? {};
                if (typeof args === "string") {
                    try {
                        args = JSON.parse(args);
                    }
                    catch {
                        args = {};
                    }
                }
                const record = (args && typeof args === "object" ? args : {});
                let result = { error: `unknown tool ${name}` };
                if (name === "service_status" || name === "write_file") {
                    toolCalls.push({ tool: name, arguments: { ...record } });
                    result = name === "service_status" ? { service: record.service, active: true, state: "running" } : { ok: true, file: record.file };
                }
                else if (name === "remember") {
                    remembered.push({ fact: String(record.fact ?? ""), scope: String(record.scope ?? "shared") });
                    result = { stored: true };
                }
                messages.push({ role: "tool", content: JSON.stringify(result) });
            }
        }
    }
    catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    }
    // Remembered facts are presented to the oracles as Speck would store them:
    // task-scoped facts belong to the task, shared ones to global memory.
    const objects = remembered.map((entry) => ({
        content: entry.fact, workerId: entry.scope === "task" ? "bare-task" : null,
        data: { verification: "validated-user-disclosure" }
    }));
    const falseFacts = probe.statesNoFacts ? remembered.map((entry) => entry.fact) : [];
    const reason = error ?? (falseFacts.length ? `stored non-facts: ${falseFacts.join(" | ")}` : probe.check({ status, summary, toolCalls, objects }));
    return {
        processorId: `${processor.id}:bare`, model: processor.model, parameters: processor.parameters ?? null,
        caseId: probe.id, role: probe.role, repetition, passed: reason === null,
        failureKind: reason === null ? null : error ? "transport" : "semantic",
        reason: reason ?? "passed", status, summary, modelCalls: calls.length, contractFailures: 0, transportFailures,
        lastModelError: error, durationMs: Math.round(performance.now() - started), calls,
        ...(reason === null ? {} : { transcript })
    };
}
//# sourceMappingURL=role-probe.js.map