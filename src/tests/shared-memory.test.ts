import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-shared-memory-"));
  const databasePath = path.join(directory, "speck.sqlite");
  return { directory, databasePath, runtime: new SpeckRuntime({ databasePath }) };
}

test("global semantic memory is relevance-filtered into another worker's context", async () => {
  const f = fixture();
  try {
    const source = await f.runtime.createWorker("Remember a deployment fact");
    const shared = await f.runtime.recordSharedMemory({
      type: "semantic",
      content: "The Speck deployment port is 4310.",
      sourceWorkerId: source.id,
      confidence: 1,
      audience: ["intake", "planner", "worker"],
      actor: { kind: "user", source: "test" }
    });
    const target = await f.runtime.createWorker("Which deployment port does Speck use?");
    const imported = await f.runtime.importSharedMemories({
      workerId: target.id,
      query: target.objective.description,
      role: "intake"
    });
    assert.equal(imported.length, 1);
    assert.equal(imported[0]?.memoryRoles.includes("semantic"), true);
    assert.equal((imported[0]?.data.sharedMemoryImport as Record<string, unknown>)?.sourceId, shared.id);
    const context = f.runtime.buildContext({ workerId: target.id });
    assert.match(context.text, /RELEVANT SHARED MEMORY/);
    assert.match(context.text, /deployment port is 4310/);
  } finally { f.runtime.close(); fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("shared episodic and semantic memories survive restart and retain audience boundaries", async () => {
  const f = fixture();
  try {
    await f.runtime.recordSharedMemory({ type: "episodic", content: "The user asked for a lunar release plan.", audience: ["planner"] });
    await f.runtime.recordSharedMemory({ type: "semantic", content: "Lunar releases require an offline rollback package.", audience: ["planner", "worker"] });
    f.runtime.close();
    const restored = new SpeckRuntime({ databasePath: f.databasePath });
    try {
      const planner = await restored.retrieveSharedMemories({ query: "lunar release rollback", role: "planner", limit: 10 });
      assert.equal(planner.length, 2);
      assert.ok(planner.some(({ object }) => object.memoryRoles.includes("episodic")));
      assert.ok(planner.some(({ object }) => object.memoryRoles.includes("semantic")));
      const intake = await restored.retrieveSharedMemories({ query: "lunar release rollback", role: "intake", limit: 10 });
      assert.equal(intake.length, 0);
    } finally { restored.close(); }
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
