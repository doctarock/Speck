import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createGenesisSpeckHost } from "../genesis-host.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

test("Speck hosts Genesis plugins and exposes host-owned cognitive capabilities", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-genesis-host-"));
  const genesisRuntimePath = path.join(directory, "genesis");
  const pluginDirectory = path.join(directory, "plugins");
  const externalPluginDirectory = path.join(directory, "external-plugins");
  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.mkdirSync(externalPluginDirectory, { recursive: true });
  fs.mkdirSync(path.join(genesisRuntimePath, "modules"), { recursive: true });
  const ignoredPlugin = `export default () => ({ id: "must-not-load", name: "Must Not Load", version: "1.0.0", init() {} });`;
  fs.writeFileSync(path.join(externalPluginDirectory, "must-not-load.js"), ignoredPlugin, "utf8");
  fs.writeFileSync(path.join(genesisRuntimePath, "modules", "must-not-load.js"), ignoredPlugin, "utf8");
  fs.mkdirSync(path.join(directory, "profiles"), { recursive: true });
  const profile = JSON.stringify({
    id: "minimal", name: "Test minimal", description: "Test profile", defaultProvider: "",
    enabledPlugins: [], disabledPlugins: [],
    systemPromptAddons: [], ui: {}, runtime: { allowGeneralAssistant: true }
  });
  fs.writeFileSync(path.join(directory, "profiles", "minimal.json"), profile, "utf8");
  fs.writeFileSync(path.join(directory, "profiles", "default.json"), profile, "utf8");
  fs.writeFileSync(path.join(pluginDirectory, "compat-test-plugin.js"), `
    export default function createCompatTestPlugin() {
      let listWorkers;
      return {
        id: "compat-test",
        name: "Compatibility Test",
        version: "1.0.0",
        manifest: {
          schemaVersion: 1,
          permissions: { routes: false, uiPanels: false, data: false, capabilities: ["test:host-worker-count"], hooks: ["intake:received"], runtimeContext: [], tools: ["get_compat_value"] },
          compatibility: { coreApiMin: "1.4.0", coreApiMax: "" },
          dependencies: { requiredCapabilities: ["speck:worker-list"], optionalCapabilities: [] },
          security: { isolation: "inprocess" }
        },
        init(api) {
          listWorkers = api.getCapability("speck:worker-list");
          api.provideCapability("test:host-worker-count", () => listWorkers({}).length);
          api.registerTool({ name: "get_compat_value", description: "Get a compatibility value", scopes: ["worker"], risk: "normal", parameters: { key: "string" } }, async (args) => ({ value: args.key }));
          api.addHook("intake:received", (payload) => ({ ...payload, objective: "hooked: " + payload.objective }));
        }
      };
    }
  `, "utf8");

  const config = loadConfig({
    databasePath: path.join(directory, "speck.sqlite"),
    genesisRuntimePath,
    pluginImportMode: "permissive",
    genesisProfile: "minimal"
  });
  const runtime = new SpeckRuntime(config);
  let host: Awaited<ReturnType<typeof createGenesisSpeckHost>> | null = null;
  let server: Server | null = null;
  const priorExternalPluginDirectory = process.env.GENESIS_PLUGIN_DIR;
  try {
    process.env.GENESIS_PLUGIN_DIR = externalPluginDirectory;
    await runtime.initialize();
    host = await createGenesisSpeckHost(runtime, config, { speckRoot: directory });
    assert.deepEqual(host.pluginLoadErrors, []);
    const descriptor = host.pluginManager.listPlugins().find((plugin) => plugin.id === "compat-test");
    assert.equal(descriptor?.failureCount, 0);
    assert.equal(host.pluginManager.listPlugins().some((plugin) => plugin.id === "must-not-load"), false);
    const countWorkers = host.pluginManager.getCapability("test:host-worker-count");
    assert.equal(countWorkers?.({}), 0);
    assert.equal(typeof host.pluginManager.getCapability("speck:memory-retrieve"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:association-reinforce"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:domain-link"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:working-memory-compete"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:context-build"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:model-list"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:model-assign"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:model-infer"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:tool-list"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:tool-intent"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:tool-execute"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:prediction-create"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:prediction-compare"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:hypothesis-rank"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:belief-revise"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:confidence-calibrate"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:impasse-resolve"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:model-escalate"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:tier-resources"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:procedure-learn"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:procedure-execute"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:known-answer-record"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:known-answer-lookup"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:plan-create"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:plan-get"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:worker-message"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:evidence-share"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:subtask-report"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:plan-aggregate"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:background-run"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:background-state"), "function");
    assert.equal(typeof host.pluginManager.getCapability("speck:benchmark-manifest"), "function");
    for (const coreTool of ["list_files", "read_file", "write_file", "queue_list", "queue_get", "queue_enqueue", "memory_search", "memory_read", "memory_record"]) {
      assert.equal(runtime.toolRegistry.list().some((tool) => tool.name === coreTool && tool.source === "speck-core"), true);
    }
    assert.equal(runtime.toolRegistry.list().some((tool) => tool.name === "get_compat_value"), true);
    const intake = await host.pluginManager.runHook("intake:received", { objective: "diagnose" });
    assert.equal(intake.objective, "hooked: diagnose");
    await runtime.createWorker(intake.objective);
    assert.equal(countWorkers?.({}), 1);
    const worker = runtime.listWorkers()[0]!;
    const toolResult = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "get_compat_value", arguments: { key: "works" }, expectedOutcome: "value returned" }
    });
    assert.deepEqual(toolResult.record.output, { value: "works" });

    server = host.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const tokenResponse = await fetch(`${origin}/api/admin-token`, { headers: { origin } });
    assert.equal(tokenResponse.status, 200);
    const token = String((await tokenResponse.json() as { token?: string }).token ?? "");
    assert.ok(token);
    const uploadResponse = await fetch(`${origin}/api/inspect/upload?file=sample.bin`, {
      method: "POST",
      headers: { origin, "x-admin-token": token, "content-type": "application/octet-stream" },
      body: Buffer.from([0, 1, 2, 255])
    });
    assert.equal(uploadResponse.status, 201);
    assert.deepEqual(
      fs.readFileSync(path.join(genesisRuntimePath, "workspace", "inbox", "sample.bin")),
      Buffer.from([0, 1, 2, 255])
    );
    const duplicateResponse = await fetch(`${origin}/api/inspect/upload?file=sample.bin`, {
      method: "POST",
      headers: { origin, "x-admin-token": token, "content-type": "application/octet-stream" },
      body: Buffer.from("replacement")
    });
    assert.equal(duplicateResponse.status, 409);
  } finally {
    if (priorExternalPluginDirectory === undefined) delete process.env.GENESIS_PLUGIN_DIR;
    else process.env.GENESIS_PLUGIN_DIR = priorExternalPluginDirectory;
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await host?.close();
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
