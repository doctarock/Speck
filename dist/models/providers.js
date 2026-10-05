import { atomicEntailmentContract } from "../metacognition/qualification.js";
import { contractJsonSchema } from "./response.js";
class HttpModelProcessor {
    descriptor;
    constructor(descriptor) {
        this.descriptor = descriptor;
    }
    async post(url, body, request) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
        const abort = () => controller.abort();
        request.signal?.addEventListener("abort", abort, { once: true });
        const apiKey = this.descriptor.apiKeyEnv ? process.env[this.descriptor.apiKeyEnv] : undefined;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            if (!response.ok)
                throw new Error(`model endpoint returned HTTP ${response.status}: ${await response.text()}`);
            return await response.json();
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError")
                throw new Error(`model request timed out after ${request.timeoutMs}ms`);
            throw error;
        }
        finally {
            clearTimeout(timeout);
            request.signal?.removeEventListener("abort", abort);
        }
    }
}
// Ollama silently drops the start of a prompt that does not fit its context
// window, which would surface as an apparent model failure. Speck sets the
// window explicitly and treats a completion that filled it as unusable.
export class ContextOverflowError extends Error {
    used;
    window;
    constructor(used, window) {
        super(`prompt and completion filled the ${window}-token runtime context (${used} tokens)`);
        this.used = used;
        this.window = window;
        this.name = "ContextOverflowError";
    }
}
// Measured on the role probe: the largest prompt plus reply was under 800
// tokens, and Speck's context budget bounds prompts well below this window.
// Shortcut S9 (docs/COGNITIVE_SHORTCUTS.md).
export const DEFAULT_RUNTIME_CONTEXT = 4_096;
// Role replies are short structured payloads; a generation that runs past this
// is a runaway, cut off instead of occupying the processor until timeout.
export const MAX_OUTPUT_TOKENS = 1_024;
// A configured window wins; otherwise the window learned from competence;
// otherwise the default.
export function runtimeContextSize(descriptor, learned) {
    return descriptor.runtimeContextSize ?? Math.min(descriptor.contextSize, learned ?? DEFAULT_RUNTIME_CONTEXT);
}
// Shortcut S9 (docs/COGNITIVE_SHORTCUTS.md): a conservative token estimate for
// a prompt Speck is about to send, from its length.
const CHARACTERS_PER_TOKEN_ESTIMATE = 3;
// The window for one request: the configured or learned window, doubled
// until the prompt Speck is about to send, plus room for a reply, fits.
// Speck knows the prompt's size before sending it, so a window known to be
// too small is never used.
export function requestContextWindow(descriptor, learned, request) {
    const characters = request.prompt.length + (request.system?.length ?? 0) + (request.tools ? JSON.stringify(request.tools).length : 0);
    const needed = Math.ceil(characters / CHARACTERS_PER_TOKEN_ESTIMATE) + MAX_OUTPUT_TOKENS;
    let window = runtimeContextSize(descriptor, learned);
    while (window < needed && window < descriptor.contextSize)
        window *= 2;
    return Math.min(window, descriptor.contextSize);
}
export class OllamaProcessor extends HttpModelProcessor {
    nativeTools = null;
    learnedWindow = null;
    // The largest window this processor has been given. Ollama reloads a model
    // whenever a request asks for a window other than the one it is loaded
    // with (measured: 1.5 to 6.3 s for SmolLM3, against 0.1 s for a call that
    // keeps it), so the window grows when a prompt needs more and is never
    // shrunk again while Speck runs.
    residentWindow = 0;
    // Whether the window the model is already loaded with has been read.
    loadedWindowRead = false;
    setContextWindow(tokens) { this.learnedWindow = tokens; }
    // On the first request, a model Ollama already holds (from before a
    // restart, or another runtime) keeps the window it is loaded with when
    // that is large enough, instead of being reloaded at a smaller one.
    async windowFor(request) {
        if (!this.loadedWindowRead) {
            this.loadedWindowRead = true;
            try {
                const loaded = await (await fetch(`${trimUrl(this.descriptor.baseUrl)}/api/ps`, { signal: AbortSignal.timeout(2_000) })).json();
                const name = this.descriptor.model.toLowerCase();
                const held = loaded.models?.find((model) => [model.name, model.model].some((value) => value?.toLowerCase() === name));
                if (held?.context_length)
                    this.residentWindow = Math.max(this.residentWindow, Math.min(held.context_length, this.descriptor.contextSize));
            }
            catch { /* not known; the window is chosen as if nothing were loaded */ }
        }
        this.residentWindow = Math.max(this.residentWindow, requestContextWindow(this.descriptor, this.learnedWindow, request));
        return this.residentWindow;
    }
    // Ollama reports each model's capabilities, but a reported "tools"
    // capability is a claim about the template, not the model's behaviour, so
    // Speck also verifies it with one unambiguous call. Asked once per model.
    supportsNativeTools() {
        if (this.descriptor.toolCalling === "native")
            return Promise.resolve(true);
        if (this.descriptor.toolCalling === "json")
            return Promise.resolve(false);
        this.nativeTools ??= fetch(`${trimUrl(this.descriptor.baseUrl)}/api/show`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: this.descriptor.model })
        }).then(async (response) => {
            if (!response.ok)
                return false;
            const shown = await response.json();
            if (!Array.isArray(shown.capabilities) || !shown.capabilities.includes("tools"))
                return false;
            return verifiesNativeToolCall((request) => this.inferWithTools(request));
        }).catch(() => false);
        return this.nativeTools;
    }
    async infer(request) {
        if (request.tools?.length)
            return this.inferWithTools(request);
        const window = await this.windowFor(request);
        const parsed = await this.post(`${trimUrl(this.descriptor.baseUrl)}/api/generate`, {
            model: this.descriptor.model,
            prompt: request.prompt,
            stream: false,
            think: false,
            ...(request.contract ? { format: contractJsonSchema(request.contract) } : {}),
            options: { temperature: request.temperature, num_ctx: window, num_predict: Math.min(MAX_OUTPUT_TOKENS, Math.floor(window / 2)) }
        }, request);
        if (typeof parsed?.response !== "string" || !parsed.response.trim())
            throw new TypeError("Ollama response missing response text");
        const used = Number(parsed.prompt_eval_count ?? 0) + Number(parsed.eval_count ?? 0);
        if (used >= window)
            throw new ContextOverflowError(used, window);
        return {
            text: parsed.response,
            ...(Number.isFinite(parsed.prompt_eval_count) ? { inputTokens: parsed.prompt_eval_count } : {}),
            ...(Number.isFinite(parsed.eval_count) ? { outputTokens: parsed.eval_count } : {})
        };
    }
    // Native tool calling goes through the chat endpoint with the tools in the
    // format the model was fine-tuned on.
    async inferWithTools(request) {
        const window = await this.windowFor(request);
        const parsed = await this.post(`${trimUrl(this.descriptor.baseUrl)}/api/chat`, {
            model: this.descriptor.model,
            messages: [
                ...(request.system ? [{ role: "system", content: request.system }] : []),
                { role: "user", content: request.prompt }
            ],
            tools: request.tools.map((tool) => ({ type: "function", function: tool })),
            stream: false,
            think: false,
            options: { temperature: request.temperature, num_ctx: window, num_predict: Math.min(MAX_OUTPUT_TOKENS, Math.floor(window / 2)) }
        }, request);
        const message = parsed?.message ?? {};
        const used = Number(parsed?.prompt_eval_count ?? 0) + Number(parsed?.eval_count ?? 0);
        if (used >= window)
            throw new ContextOverflowError(used, window);
        return {
            text: typeof message.content === "string" ? message.content : "",
            toolCalls: nativeToolCalls(message.tool_calls),
            ...(Number.isFinite(parsed?.prompt_eval_count) ? { inputTokens: parsed.prompt_eval_count } : {}),
            ...(Number.isFinite(parsed?.eval_count) ? { outputTokens: parsed.eval_count } : {})
        };
    }
}
// One request where a tool call is the only reasonable reply. A model whose
// native tool calling works returns the call; one that only claims the
// capability answers in prose.
// Shortcut S7 (docs/COGNITIVE_SHORTCUTS.md).
async function verifiesNativeToolCall(infer) {
    const completion = await infer({
        prompt: "Record the number 7.",
        temperature: 0,
        timeoutMs: 60_000,
        tools: [{
                name: "record_number", description: "Record a number.",
                parameters: { type: "object", properties: { number: { type: "number" } }, required: ["number"] }
            }]
    });
    const call = completion.toolCalls?.[0];
    return call?.name === "record_number" && Number(call.arguments.number) === 7;
}
// Providers return arguments either as an object (Ollama) or as a JSON string
// (OpenAI-compatible); both are the same call.
function nativeToolCalls(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((entry) => {
        const fn = entry && typeof entry === "object" ? entry.function : undefined;
        const name = typeof fn?.name === "string" ? fn.name.trim() : "";
        if (!name)
            return [];
        let args = fn?.arguments ?? {};
        if (typeof args === "string") {
            try {
                args = JSON.parse(args);
            }
            catch {
                args = {};
            }
        }
        return [{ name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} }];
    });
}
export class OpenAiCompatibleProcessor extends HttpModelProcessor {
    nativeTools = null;
    // OpenAI-compatible servers do not report capabilities, so native tool
    // calling is used when configured, or when "auto" and the verification
    // call succeeds.
    supportsNativeTools() {
        if (this.descriptor.toolCalling === "native")
            return Promise.resolve(true);
        if (this.descriptor.toolCalling !== "auto")
            return Promise.resolve(false);
        this.nativeTools ??= verifiesNativeToolCall((request) => this.infer(request)).catch(() => false);
        return this.nativeTools;
    }
    async infer(request) {
        const native = Boolean(request.tools?.length);
        const parsed = await this.post(openAiChatUrl(this.descriptor.baseUrl), {
            model: this.descriptor.model,
            messages: [
                ...(request.system ? [{ role: "system", content: request.system }] : []),
                { role: "user", content: request.prompt }
            ],
            temperature: request.temperature,
            // The same reply cap as every other provider.
            max_tokens: MAX_OUTPUT_TOKENS,
            // llama.cpp passes this to the chat template, as Ollama's think:false
            // does: a model with a thinking mode (Qwen3, Ling) answers without it.
            ...(this.descriptor.provider === "llama.cpp" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            ...(native ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
            ...(request.contract && !native ? { response_format: { type: "json_object" } } : {})
        }, request);
        const message = parsed?.choices?.[0]?.message ?? {};
        const text = typeof message.content === "string" ? message.content : "";
        const toolCalls = nativeToolCalls(message.tool_calls);
        if (!native && !text.trim())
            throw new TypeError("OpenAI-compatible response missing choices[0].message.content");
        return {
            text,
            ...(native ? { toolCalls } : {}),
            ...(Number.isFinite(parsed?.usage?.prompt_tokens) ? { inputTokens: parsed.usage.prompt_tokens } : {}),
            ...(Number.isFinite(parsed?.usage?.completion_tokens) ? { outputTokens: parsed.usage.completion_tokens } : {})
        };
    }
}
// An NLI cross-encoder served by the sidecar in sidecars/nli: a premise and a
// hypothesis in, entailment / contradiction / neutral out. It answers only the
// atomic-entailment judgment, from the request's input fields; it reads no
// prompt, so there is nothing else it could be asked.
export class NliProcessor extends HttpModelProcessor {
    async infer(request) {
        const premise = request.input?.premise;
        const hypothesis = request.input?.hypothesis;
        if (request.contract?.name !== atomicEntailmentContract.name || typeof premise !== "string" || typeof hypothesis !== "string") {
            throw new Error(`NLI processor ${this.descriptor.id} answers only ${atomicEntailmentContract.name} with a premise and a hypothesis`);
        }
        const judged = await this.post(`${trimUrl(this.descriptor.baseUrl)}/classify`, { model: this.descriptor.model, premise, hypothesis }, request);
        const scores = judged?.scores && typeof judged.scores === "object" ? judged.scores : {};
        return { text: JSON.stringify({ confidence: Number(scores[judged?.label] ?? 0.5), response: { label: judged?.label } }) };
    }
}
export function createConfiguredProcessor(descriptor) {
    if (descriptor.provider === "nli")
        return new NliProcessor(descriptor);
    return descriptor.provider === "ollama"
        ? new OllamaProcessor(descriptor)
        : new OpenAiCompatibleProcessor(descriptor);
}
function trimUrl(value) { return value.replace(/\/+$/, ""); }
function openAiChatUrl(value) {
    const base = trimUrl(value);
    return `${base}${base.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
}
//# sourceMappingURL=providers.js.map