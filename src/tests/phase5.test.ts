import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import { classifyGenesisRisk, registerGenesisTools } from "../tools/genesis.js";
import type { ToolDefinition } from "../tools/types.js";

function fixture(toolRuntime: { timeoutMs?: number } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-phase5-"));
  const databasePath = path.join(directory, "speck.sqlite");
  const runtime = new SpeckRuntime({ databasePath, toolRuntime });
  return { directory, databasePath, runtime };
}

function definition(name: string, risk: ToolDefinition["risk"] = "read-only"): ToolDefinition {
  return {
    name,
    description: `Perform ${name}`,
    intents: [name.replace("tool", "configuration")],
    inputSchema: { target: { type: "string", required: true } },
    risk,
    sideEffects: risk === "read-only" ? [] : ["changes state"],
    requiredPermissions: [],
    source: "test"
  };
}

test("semantic intent resolves only through the closed registry and validates parameters", async () => {
  const f = fixture();
  try {
    f.runtime.toolRegistry.register(definition("inspect_tool"), async (args) => ({ inspected: args.target }));
    assert.equal(f.runtime.toolRegistry.resolve({
      intent: "inspect_configuration", arguments: { target: "nginx" }, expectedOutcome: "configuration returned"
    }).definition.name, "inspect_tool");
    assert.throws(() => f.runtime.toolRegistry.resolve({
      intent: "run_arbitrary_shell", arguments: {}, expectedOutcome: "anything"
    }), /No registered tool/);
    assert.throws(() => f.runtime.toolRegistry.validateArguments(f.runtime.toolRegistry.list()[0]!, {}), /missing required/);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("read-only execution persists prediction, outcome, evidence, and a complete invocation record", async () => {
  const f = fixture();
  try {
    f.runtime.toolRegistry.register(definition("inspect_tool"), async (args) => ({ text: `state:${args.target}` }));
    const worker = await f.runtime.createWorker("Inspect nginx safely");
    const result = await f.runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "inspect_configuration", target: "nginx", arguments: { target: "nginx" }, expectedOutcome: "configuration returned" }
    });
    assert.equal(result.record.actualOutcome, "succeeded");
    assert.equal(result.record.stdout, "state:nginx");
    assert.equal(result.prediction.data.toolExecution && (result.prediction.data.toolExecution as any).status, "succeeded");
    assert.equal(result.outcome.kind, "tool-outcome");
    assert.equal(result.evidence.kind, "evidence");
    assert.ok(f.runtime.getWorker(worker.id)?.evidence.includes(result.evidence.id));
    assert.ok(f.runtime.listEvents(worker.id).some((event) => event.type === "tool.execution-completed"));
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("mutations require explicit authorization and model confidence cannot substitute for it", async () => {
  const f = fixture();
  let calls = 0;
  try {
    f.runtime.toolRegistry.register(definition("change_tool", "reversible-mutation"), async () => { calls += 1; return { ok: true }; });
    const worker = await f.runtime.createWorker("Change config");
    const intent = { intent: "change_configuration", arguments: { target: "nginx" }, expectedOutcome: "configuration changed" };
    await assert.rejects(() => f.runtime.executeToolIntent({ workerId: worker.id, intent }), /requires explicit approval/);
    assert.equal(calls, 0);
    const result = await f.runtime.executeToolIntent({
      workerId: worker.id, intent,
      authorization: { approved: true, approvedBy: "operator-1" }
    });
    assert.equal(calls, 1);
    assert.equal(result.record.authorizedBy, "operator-1");
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("declared permissions are enforced independently of risk approval", async () => {
  const f = fixture();
  try {
    const secured = { ...definition("inspect_tool"), requiredPermissions: ["config:read"] };
    f.runtime.toolRegistry.register(secured, async () => ({ ok: true }));
    const worker = await f.runtime.createWorker("Inspect config");
    const intent = { intent: "inspect_configuration", arguments: { target: "nginx" }, expectedOutcome: "configuration returned" };
    await assert.rejects(() => f.runtime.executeToolIntent({ workerId: worker.id, intent }), /requires permission/);
    const result = await f.runtime.executeToolIntent({
      workerId: worker.id, intent,
      authorization: { approved: false, approvedBy: "policy", permissions: ["config:read"] }
    });
    assert.equal(result.record.actualOutcome, "succeeded");
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("timed-out tools are unknown-outcome, never falsely recorded as failed", async () => {
  const f = fixture({ timeoutMs: 10 });
  try {
    f.runtime.toolRegistry.register(definition("inspect_tool"), async () => await new Promise(() => {}));
    const worker = await f.runtime.createWorker("Inspect slowly");
    const result = await f.runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "inspect_configuration", arguments: { target: "slow" }, expectedOutcome: "result" }
    });
    assert.equal(result.record.actualOutcome, "unknown-outcome");
    assert.equal(result.evidence.data.reliability, 0);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("startup recovery marks pending durable executions as unknown-outcome", async () => {
  const f = fixture();
  let restored: SpeckRuntime | null = null;
  try {
    const worker = await f.runtime.createWorker("Recover execution");
    const prediction = await f.runtime.createMentalObject({
      workerId: worker.id, kind: "prediction", content: "external state changes",
      data: { toolExecution: { executionId: "unfinished", status: "pending", tool: "change_tool" } }
    });
    f.runtime.close();
    restored = new SpeckRuntime({ databasePath: f.databasePath });
    const recovery = await restored.initialize();
    assert.equal(recovery.recoveredToolExecutions, 1);
    assert.equal((restored.mentalObjects.get(prediction.id)?.data.toolExecution as any).status, "unknown-outcome");
    assert.equal(restored.listEvents(worker.id).at(-1)?.type, "tool.execution-recovered");
  } finally {
    restored?.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Genesis tools adapt conservatively and execute through the manager contract", async () => {
  const f = fixture();
  try {
    const calls: any[] = [];
    registerGenesisTools(f.runtime.toolRegistry, {
      listTools: () => [{ name: "get_mail_status", description: "Read mail status", parameters: {}, risk: "normal", scopes: ["intake"], pluginId: "mail" }],
      runHook: async () => null,
      executeTool: async (name, args) => { calls.push({ name, args }); return { handled: true, result: { ready: true } }; }
    });
    assert.equal(f.runtime.toolRegistry.list()[0]?.risk, "read-only");
    assert.equal(classifyGenesisRisk({ name: "wordpress_update_plugins", risk: "normal" }), "reversible-mutation");
    const worker = await f.runtime.createWorker("Check mail");
    const result = await f.runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "get_mail_status", arguments: {}, expectedOutcome: "mail status returned" }
    });
    assert.equal(result.record.actualOutcome, "succeeded");
    assert.deepEqual(calls, [{ name: "get_mail_status", args: {} }]);
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Genesis plugin tools preserve JSON Schema parameters", () => {
  const f = fixture();
  try {
    registerGenesisTools(f.runtime.toolRegistry, {
      listTools: () => [{
        name: "search_records", pluginId: "records",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            scope: { type: "string", enum: ["local", "global"] }
          }
        }
      }],
      runHook: async () => null
    });
    const schema = f.runtime.toolRegistry.list()[0]?.inputSchema;
    assert.deepEqual(schema, {
      query: { type: "string", required: true },
      limit: { type: "number" },
      scope: { type: "string", enum: ["local", "global"] }
    });
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Genesis plugins cannot replace host-owned core tools", () => {
  const f = fixture();
  try {
    f.runtime.toolRegistry.register({ ...definition("memory_search"), source: "speck-core" }, async () => ({ core: true }));
    const registered = registerGenesisTools(f.runtime.toolRegistry, {
      listTools: () => [{ name: "memory_search", pluginId: "collision" }],
      runHook: async () => ({ handled: true, result: { core: false } })
    });
    assert.deepEqual(registered, []);
    assert.equal(f.runtime.toolRegistry.list()[0]?.source, "speck-core");
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a Worker can reason into a semantic intent, execute it, and observe evidence", async () => {
  const f = fixture();
  try {
    f.runtime.modelRegistry.register({
      id: "intent-model", provider: "ollama", model: "intent-model", tier: 1,
      contextSize: 4_096, specialties: ["tool-use"], enabled: true
    }, {
      async infer() {
        return {
          text: JSON.stringify({
            confidence: 1,
            response: {
              intent: "inspect_configuration",
              target: "nginx",
              arguments: { target: "nginx" },
              expectedOutcome: "configuration returned"
            }
          })
        };
      }
    });
    f.runtime.toolRegistry.register(definition("inspect_tool"), async (args) => ({ text: `observed:${args.target}` }));
    const worker = await f.runtime.createWorker("Inspect nginx before making changes");
    const proposed = await f.runtime.proposeToolIntent({
      workerId: worker.id, request: "Inspect nginx", processorId: "intent-model"
    });
    const executed = await f.runtime.executeToolIntent({ workerId: worker.id, intent: proposed.intent });
    assert.equal(proposed.intent.intent, "inspect_configuration");
    assert.equal(executed.record.stdout, "observed:nginx");
    assert.ok(f.runtime.getCognitiveState(worker.id).evidence.some((entry) => entry?.id === executed.evidence.id));
  } finally {
    f.runtime.close();
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
