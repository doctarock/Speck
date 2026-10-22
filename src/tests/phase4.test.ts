import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerGenesisBrainProcessors } from "../models/genesis.js";
import { ContextOverflowError, OllamaProcessor, OpenAiCompatibleProcessor, requestContextWindow } from "../models/providers.js";
import { ModelRegistry } from "../models/registry.js";
import { contractInstruction, parseModelCompletion } from "../models/response.js";
import type {
  ConfiguredModelProcessor, ModelProcessor, ModelProcessorDescriptor, StructuredOutputContract
} from "../models/types.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

const actionContract: StructuredOutputContract = {
  name: "next-action",
  required: ["action", "reason"],
  properties: {
    action: { type: "string", enum: ["inspect", "wait"] },
    reason: { type: "string" }
  },
  additionalProperties: false
};

function descriptor(id: string, provider: ConfiguredModelProcessor["provider"] = "ollama"): ModelProcessorDescriptor {
  return {
    id, provider, model: `${id}-model`, tier: 1, contextSize: 4_096,
    specialties: ["general", "coding"], enabled: true
  };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase4-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath });
  return { directory, databasePath, runtime };
}

test("ACA response envelopes survive thinking text and enforce Speck contracts", () => {
  const parsed = parseModelCompletion(
    '<think>{not the answer}</think>```json\n{"confidence":1.7,"response":{"action":"inspect","reason":"verify first"}}\n```',
    actionContract
  );
  assert.equal(parsed.confidence, 1);
  assert.deepEqual(parsed.structured, { action: "inspect", reason: "verify first" });
  const flat = parseModelCompletion(
    '{"action":"complete","response":"finished","madeProgress":true,"confidence":0.8}',
    {
      name: "flat-action", required: ["action", "response", "madeProgress"],
      properties: { action: { type: "string" }, response: { type: "string" }, madeProgress: { type: "boolean" } },
      additionalProperties: true
    }
  );
  assert.equal(flat.structured?.response, "finished");
  const named = parseModelCompletion(
    '{"flat-action":{"action":"complete","response":"finished","madeProgress":true}}',
    {
      name: "flat-action", required: ["action", "response", "madeProgress"],
      properties: { action: { type: "string" }, response: { type: "string" }, madeProgress: { type: "boolean" } },
      additionalProperties: false
    }
  );
  assert.equal(named.structured?.response, "finished");
  assert.throws(
    () => parseModelCompletion('{"confidence":0.9,"response":{"action":"invent"}}', actionContract),
    /missing required field|must be one of/
  );
  const stringArrayContract: StructuredOutputContract = {
    name: "string-array", required: ["facts"],
    properties: { facts: { type: "array", items: { type: "string" } } }, additionalProperties: false
  };
  assert.deepEqual(parseModelCompletion('{"facts":["grounded fact"]}', stringArrayContract).structured?.facts, ["grounded fact"]);
  assert.throws(() => parseModelCompletion('{"facts":[{"claim":"not a string"}]}', stringArrayContract), /facts\[0\] must be string/);
  // Undeclared keys carry nothing Speck reads; they are dropped, not retried.
  assert.deepEqual(
    parseModelCompletion('{"action":"wait","reason":"dependency","expectedOutcome":"later"}', actionContract).structured,
    { action: "wait", reason: "dependency" }
  );
  // The formatter's example, when given, must itself satisfy the validator,
  // otherwise the contract induces the failures it then reports.
  const shapeOnly: StructuredOutputContract = { name: "notes", required: ["summary", "points"], properties: { summary: { type: "string" }, points: { type: "array", items: { type: "string" } } } };
  const example = contractInstruction(shapeOnly).match(/^Example: (\{.*\})$/m)?.[1];
  assert.ok(example);
  assert.deepEqual(parseModelCompletion(example!, shapeOnly).structured, JSON.parse(example!));
  // A choice has no example: any valid value would be shown as the answer.
  assert.doesNotMatch(contractInstruction(actionContract), /^Example:/m);
  for (const choice of [{ type: "boolean" as const }, { type: "number" as const }, { type: "string" as const, enum: ["a", "b"] }]) {
    assert.doesNotMatch(contractInstruction({ name: "c", required: ["value"], properties: { value: choice } }), /^Example:/m);
  }
  // Every allowed value of a required enum is stated, and Speck's internal
  // contract name is not shown to the model.
  assert.match(contractInstruction(actionContract), /action \(required\): exactly one of "inspect", "wait"/);
  assert.equal(contractInstruction(actionContract).includes(actionContract.name), false);
  const fallback = parseModelCompletion("plain useful text");
  assert.equal(fallback.text, "plain useful text");
  assert.equal(fallback.confidence, 0.5);
});

test("registry retries invalid structured output and records reliability", async () => {
  const registry = new ModelRegistry();
  let calls = 0;
  const processor: ModelProcessor = {
    async infer() {
      calls += 1;
      return { text: calls === 1 ? "not json" : '{"confidence":0.8,"response":{"action":"wait","reason":"dependency"}}' };
    }
  };
  registry.register(descriptor("retry-model"), processor);
  const response = await registry.infer({ processorId: "retry-model", prompt: "decide", contract: actionContract, maxAttempts: 2 });
  assert.equal(response.attempts, 2);
  assert.equal(response.confidence, 0.8);
  assert.deepEqual(response.structured, { action: "wait", reason: "dependency" });
  const snapshot = registry.list()[0]!;
  assert.equal(snapshot.calls, 2);
  assert.equal(snapshot.successes, 1);
  assert.equal(snapshot.failures, 1);
  // A serialization mismatch is an interface failure, not evidence that the
  // processor is unreliable or unavailable.
  assert.equal(snapshot.contractFailures, 1);
  assert.equal(snapshot.transportFailures, 0);
  assert.equal(snapshot.historicalReliability, 1);
  assert.equal(snapshot.available, true);
});

test("registry keeps a processor available after exhausting retries on contract failures only", async () => {
  const registry = new ModelRegistry();
  registry.register(descriptor("prose-model"), { async infer() { return { text: "plain prose" }; } });
  await assert.rejects(registry.infer({ processorId: "prose-model", prompt: "decide", contract: actionContract, maxAttempts: 2 }));
  const snapshot = registry.list()[0]!;
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.lastFailureKind, "contract");
  assert.equal(snapshot.historicalReliability, 0.5);
});

test("Ollama and OpenAI-compatible adapters use their native HTTP contracts", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/ps") { response.end(JSON.stringify({ models: [] })); return; }
      requests.push({ url: request.url ?? "", body: JSON.parse(body) });
      if (request.url === "/api/generate") {
        response.end(JSON.stringify({ response: "ollama answer", prompt_eval_count: 4, eval_count: 2 }));
      } else {
        response.end(JSON.stringify({
          choices: [{ message: { content: "compatible answer" } }],
          usage: { prompt_tokens: 5, completion_tokens: 3 }
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const common = { prompt: "hello", temperature: 0.2, timeoutMs: 2_000 };
    const ollamaDescriptor: ConfiguredModelProcessor = { ...descriptor("ollama", "ollama"), baseUrl };
    const openAiDescriptor: ConfiguredModelProcessor = { ...descriptor("llama", "llama.cpp"), baseUrl: `${baseUrl}/v1` };
    const ollama = await new OllamaProcessor(ollamaDescriptor).infer(common);
    const compatible = await new OpenAiCompatibleProcessor(openAiDescriptor).infer(common);
    assert.equal(ollama.text, "ollama answer");
    assert.equal(ollama.inputTokens, 4);
    assert.equal(compatible.text, "compatible answer");
    assert.equal(compatible.outputTokens, 3);
    assert.equal(requests[0]?.url, "/api/generate");
    assert.equal(requests[0]?.body.stream, false);
    assert.equal(requests[0]?.body.format, undefined, "plain completions are not constrained");
    assert.equal(requests[1]?.url, "/v1/chat/completions");
    assert.equal(requests[1]?.body.messages[0].content, "hello");
    // llama.cpp gets the same reply cap, and a thinking mode is switched off
    // through the chat template, as think:false does for Ollama.
    assert.equal(requests[1]?.body.max_tokens, 1_024);
    assert.deepEqual(requests[1]?.body.chat_template_kwargs, { enable_thinking: false });
    // The window is always set explicitly, never left to the server default.
    assert.equal(requests[0]?.body.options.num_ctx, 4_096);
    // A reply that filled the window was produced from a truncated prompt.
    await assert.rejects(
      new OllamaProcessor({ ...ollamaDescriptor, contextSize: 6, runtimeContextSize: 6 }).infer(common),
      ContextOverflowError
    );
    const registry = new ModelRegistry();
    registry.register(descriptor("small-window"), new OllamaProcessor({ ...ollamaDescriptor, contextSize: 6, runtimeContextSize: 6 }));
    await assert.rejects(registry.infer({ processorId: "small-window", prompt: "hello", maxAttempts: 3 }), ContextOverflowError);
    const snapshot = registry.list()[0]!;
    assert.equal(snapshot.calls, 1, "the same prompt is not retried into the same window");
    assert.equal(snapshot.lastFailureKind, "context");
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.transportFailures, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a Worker switches processors without losing persistent cognitive state", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const first: ModelProcessor = { infer: async () => ({ text: '{"confidence":0.7,"response":{"action":"inspect","reason":"first"}}' }) };
    const second: ModelProcessor = { infer: async () => ({ text: '{"confidence":0.9,"response":{"action":"wait","reason":"second"}}' }) };
    f.runtime.registerModelProcessor(descriptor("small"), first);
    f.runtime.registerModelProcessor({ ...descriptor("large"), tier: 3 }, second);
    const worker = await f.runtime.createWorker("Preserve state while switching models");
    const memory = await f.runtime.recordMemory({ workerId: worker.id, type: "semantic", content: "durable state" });
    await f.runtime.admitToWorkingMemory(worker.id, memory.id);
    await f.runtime.setWorldState({ workerId: worker.id, key: "service.ready", value: true, epistemicStatus: "observed" });

    await f.runtime.assignModelProcessor(worker.id, "small");
    const firstResult = await f.runtime.inferForWorker({ workerId: worker.id, contract: actionContract });
    assert.equal(firstResult.response.processorId, "small");
    assert.match(firstResult.context.text, /durable state/);
    await f.runtime.assignModelProcessor(worker.id, "large");
    const secondResult = await f.runtime.inferForWorker({ workerId: worker.id, contract: actionContract });
    assert.equal(secondResult.response.processorId, "large");
    assert.equal(secondResult.object.provenance.kind, "model");
    assert.equal(secondResult.object.confidence, 0.9);
    const switched = f.runtime.getWorker(worker.id)!;
    assert.deepEqual(switched.workingMemory, [memory.id]);
    assert.equal(switched.worldState["service.ready"]?.value, true);
    assert.deepEqual(switched.modelAssignment, { processorId: "large", tier: 3 });

    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    await restored.initialize();
    assert.deepEqual(restored.getWorker(worker.id)?.modelAssignment, { processorId: "large", tier: 3 });
    assert.deepEqual(restored.getWorker(worker.id)?.workingMemory, [memory.id]);
  } finally {
    restored?.close();
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Genesis brain capabilities adapt into Speck processors", async () => {
  const registry = new ModelRegistry();
  const count = await registerGenesisBrainProcessors({
    registry,
    listBrains: async () => [{ id: "coder", model: "qwen-7b", specialty: "coding", contextSize: 16_384, enabled: true }],
    generate: async ({ brainId }: { brainId: string }) => ({ ok: true, text: `{"confidence":0.6,"response":"${brainId} answered"}` })
  });
  assert.equal(count, 1);
  assert.equal(registry.list()[0]?.provider, "genesis");
  assert.equal(registry.list()[0]?.tier, 2);
  const response = await registry.infer({ processorId: "genesis.coder", prompt: "hello" });
  assert.equal(response.text, "coder answered");
});

test("Ollama native tool calling is detected from model capabilities and converted to Speck's tool payload", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  let toolCalls: unknown[] = [{ function: { name: "service_status", arguments: { service: "nginx" } } }];
  let proseOnly = false;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/ps") { response.end(JSON.stringify({ models: [] })); return; }
      requests.push({ url: request.url ?? "", body: JSON.parse(body) });
      const parsedBody = JSON.parse(body);
      if (request.url === "/api/show") response.end(JSON.stringify({ capabilities: ["completion", "tools"] }));
      else if (parsedBody.tools?.[0]?.function?.name === "record_number" && proseOnly) {
        response.end(JSON.stringify({ message: { role: "assistant", content: "You can simply write it down." } }));
      } else if (parsedBody.tools?.[0]?.function?.name === "record_number") {
        response.end(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "record_number", arguments: { number: 7 } } }] } }));
      } else response.end(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: toolCalls }, prompt_eval_count: 40, eval_count: 9 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const processorDescriptor: ConfiguredModelProcessor = { ...descriptor("tools-model", "ollama"), baseUrl };
    const registry = new ModelRegistry();
    registry.register(processorDescriptor, new OllamaProcessor(processorDescriptor));
    const contract: StructuredOutputContract = {
      name: "tool-intent", required: ["intent", "arguments"],
      properties: { intent: { type: "string", enum: ["service_status", "none"] }, arguments: { type: "object" } },
      additionalProperties: false
    };
    const tools = [{
      name: "service_status", description: "Read a service status.",
      parameters: { type: "object" as const, properties: { service: { type: "string" } }, required: ["service"] }
    }];
    // Capability is detected by the processor; the protocol is chosen by the
    // runtime from competence and passed to the registry.
    assert.equal(await registry.supportsNativeTools("tools-model"), true);
    const called = await registry.infer({ processorId: "tools-model", prompt: "Is nginx up?", system: "Call a tool if needed.", contract, tools, protocol: "native" });
    assert.equal(called.toolCalling, "native");
    assert.deepEqual(called.structured, { intent: "service_status", arguments: { service: "nginx" } });
    const chats = requests.filter((entry) => entry.url === "/api/chat");
    assert.equal(chats[0]?.body.tools[0].function.name, "record_number", "the reported capability is verified before use");
    const chat = chats.find((entry) => entry.body.tools[0].function.name === "service_status")!;
    assert.deepEqual(chat.body.tools, [{ type: "function", function: tools[0] }]);
    assert.deepEqual(chat.body.messages, [{ role: "system", content: "Call a tool if needed." }, { role: "user", content: "Is nginx up?" }]);
    assert.equal(chat.body.format, undefined, "the JSON format constraint is not applied to native tool calls");
    assert.equal(requests.filter((entry) => entry.url === "/api/show").length, 1);
    // No tool call is the model saying no tool needs to run.
    toolCalls = [];
    const declined = await registry.infer({ processorId: "tools-model", prompt: "What is 2 plus 2?", contract, tools, protocol: "native" });
    assert.deepEqual(declined.structured, { intent: "none", arguments: {} });
    assert.equal(requests.filter((entry) => entry.url === "/api/show").length, 1, "capabilities are asked once per processor");
    // A model that reports the capability but answers the verification in
    // prose is used through the JSON contract instead.
    const proseDescriptor: ConfiguredModelProcessor = { ...descriptor("prose-tools", "ollama"), model: "prose-model", baseUrl };
    proseOnly = true;
    assert.equal(await new OllamaProcessor(proseDescriptor).supportsNativeTools(), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the request window grows to fit the prompt being sent", () => {
  const configured: ConfiguredModelProcessor = { ...descriptor("sized", "ollama"), baseUrl: "http://127.0.0.1:1", contextSize: 32_768 };
  const small = { prompt: "hello", temperature: 0.2, timeoutMs: 1_000 };
  assert.equal(requestContextWindow(configured, 2_048, small), 2_048);
  const large = { ...small, prompt: "x".repeat(7_800) };
  assert.equal(requestContextWindow(configured, 2_048, large), 4_096, "2,600 estimated tokens plus a reply do not fit 2,048");
  assert.equal(requestContextWindow({ ...configured, contextSize: 3_000 }, 2_048, large), 3_000, "never beyond the model's trained size");
});

test("a reply that copies the contract's instructions is unusable", () => {
  const contract: StructuredOutputContract = {
    name: "reply", description: "reply: your message to the user. asksUser: true only if the reply asks the user for information.",
    required: ["reply", "asksUser"], properties: { reply: { type: "string" }, asksUser: { type: "boolean" } }, additionalProperties: false
  };
  assert.throws(
    () => parseModelCompletion('{"reply":"Your message to the user. asksUser: true only if the reply asks the user for information.","asksUser":false}', contract),
    /reply repeats the instructions/
  );
  assert.equal(parseModelCompletion('{"reply":"Nice to meet you, Sam.","asksUser":false}', contract).structured?.reply, "Nice to meet you, Sam.");
});

test("a model keeps the largest window it was given, so it is not reloaded for a smaller one", async () => {
  const windows: number[] = [];
  let loadedWith = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/ps") { response.end(JSON.stringify({ models: loadedWith ? [{ name: "resident-model", context_length: loadedWith }] : [] })); return; }
      windows.push(JSON.parse(body).options.num_ctx);
      response.end(JSON.stringify({ response: "ok", prompt_eval_count: 4, eval_count: 1 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const processor = new OllamaProcessor({ ...descriptor("resident", "ollama"), baseUrl: `http://127.0.0.1:${address.port}`, contextSize: 32_768, runtimeContextSize: 2_048 });
    const small = { prompt: "hello", temperature: 0.2, timeoutMs: 2_000 };
    const large = { ...small, prompt: "x".repeat(7_800) };
    for (const request of [small, large, small, small]) await processor.infer(request);
    assert.deepEqual(windows, [2_048, 4_096, 4_096, 4_096]);
    // A model Ollama already holds keeps the window it is loaded with.
    loadedWith = 8_192;
    windows.length = 0;
    const restarted = new OllamaProcessor({ ...descriptor("resident", "ollama"), model: "resident-model", baseUrl: `http://127.0.0.1:${address.port}`, contextSize: 32_768, runtimeContextSize: 2_048 });
    await restarted.infer(small);
    assert.deepEqual(windows, [8_192]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
