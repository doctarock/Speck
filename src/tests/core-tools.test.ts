import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
import { registerSpeckCoreTools } from "../tools/core.js";

test("Speck core tools provide governed files, queue access, and cognitive memory without plugins", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-core-tools-"));
  const runtime = new SpeckRuntime({ databasePath: path.join(directory, "speck.sqlite"), embeddingRuntime: { enabled: false } });
  try {
    await runtime.initialize();
    await registerSpeckCoreTools(runtime, path.join(directory, "workspace"));
    const names = runtime.toolRegistry.list().map((tool) => tool.name);
    assert.deepEqual(names.sort(), [
      "browser_read_page", "browser_search", "document_index", "document_search", "list_files", "memory_list", "memory_read", "memory_record", "memory_search", "queue_enqueue",
      "queue_get", "queue_list", "read_file", "workspace_transaction_apply", "workspace_transaction_preview", "workspace_transaction_rollback", "write_file"
    ].sort());
    const queueDefinition = runtime.toolRegistry.list().find((tool) => tool.name === "queue_list")!;
    assert.ok(queueDefinition.intents.includes("summarize_completed_tasks"));
    assert.deepEqual(Object.keys(queueDefinition.inputSchema), ["status", "from", "to", "limit"]);

    const worker = await runtime.createWorker("Exercise core tools");
    const writeIntent = {
      intent: "write_workspace_file", arguments: { scope: "workspace", file: "notes/result.txt", content: "first" },
      expectedOutcome: "file saved"
    };
    await assert.rejects(() => runtime.executeToolIntent({ workerId: worker.id, intent: writeIntent }), /requires explicit approval/);
    const written = await runtime.executeToolIntent({
      workerId: worker.id, intent: writeIntent,
      authorization: { approved: true, approvedBy: "test-operator" }
    });
    assert.equal(written.record.actualOutcome, "succeeded");

    const read = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "read_workspace_file", arguments: { scope: "workspace", file: "notes/result.txt" }, expectedOutcome: "file read" }
    });
    assert.equal((read.record.output as any).content, "first");

    const transaction = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: {
        intent: "preview_multi_file_changes",
        arguments: { changes: [{ file: "notes/result.txt", operation: "write", content: "second" }, { file: "notes/extra.txt", operation: "write", content: "semantic spacecraft handbook" }] },
        expectedOutcome: "changes previewed"
      }
    });
    const transactionId = (transaction.record.output as any).transactionId;
    assert.ok(transactionId);
    const applied = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "apply_workspace_transaction", arguments: { transactionId }, expectedOutcome: "changes applied" },
      authorization: { approved: true, approvedBy: "test-operator" }
    });
    assert.equal(applied.record.actualOutcome, "succeeded");
    assert.equal(fs.readFileSync(path.join(directory, "workspace", "notes", "result.txt"), "utf8"), "second");

    const indexed = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "index_workspace", arguments: {}, expectedOutcome: "documents indexed" },
      authorization: { approved: true, approvedBy: "test-operator" }
    });
    assert.equal(indexed.record.actualOutcome, "succeeded");
    const documentSearch = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "search_documents", arguments: { query: "spacecraft handbook" }, expectedOutcome: "documents found" }
    });
    assert.equal((documentSearch.record.output as any).matches[0].file, "notes/extra.txt");

    const rolledBack = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "rollback_workspace_transaction", arguments: { transactionId }, expectedOutcome: "changes rolled back" },
      authorization: { approved: true, approvedBy: "test-operator" }
    });
    assert.equal(rolledBack.record.actualOutcome, "succeeded");
    assert.equal(fs.readFileSync(path.join(directory, "workspace", "notes", "result.txt"), "utf8"), "first");
    assert.equal(fs.existsSync(path.join(directory, "workspace", "notes", "extra.txt")), false);
    const escaped = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "read_workspace_file", arguments: { scope: "workspace", file: "../outside.txt" }, expectedOutcome: "file read" }
    });
    assert.equal(escaped.record.actualOutcome, "failed");

    const remembered = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "record_memory", arguments: { type: "semantic", content: "Core memory is globally available", shared: true }, expectedOutcome: "memory recorded" },
      authorization: { approved: true, approvedBy: "test-operator" }
    });
    assert.equal(remembered.record.actualOutcome, "succeeded");
    const globallyDefaulted = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "record_memory", arguments: { type: "semantic", content: "Global is the default" }, expectedOutcome: "memory recorded" },
      authorization: { approved: true, approvedBy: "test-operator" }
    });
    assert.ok((globallyDefaulted.record.output as any).sharedMemoryId);
    const searched = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "search_memory", arguments: { query: "globally available" }, expectedOutcome: "memory found" }
    });
    assert.ok((searched.record.output as any).shared.length > 0);
    const listed = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "recent_memories", arguments: { type: "all", limit: 5 }, expectedOutcome: "recent memories listed" }
    });
    assert.ok((listed.record.output as any).memories.some((memory: any) => memory.content === "Core memory is globally available"));

    const queued = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: { intent: "enqueue_task", arguments: { objective: "Queued from core tool" }, expectedOutcome: "worker queued" },
      authorization: { approved: true, approvedBy: "test-operator" }
    });
    assert.equal((queued.record.output as any).worker.status, "ready");

    let completed = await runtime.createWorker("Completed history item");
    completed = await runtime.transitionWorker(completed.id, "ready");
    completed = await runtime.transitionWorker(completed.id, "executing");
    await runtime.setWorldState({
      workerId: completed.id, key: "genesis.resultSummary", value: "Durable task result", epistemicStatus: "observed", confidence: 1
    });
    completed = await runtime.transitionWorker(completed.id, "completed");
    const history = await runtime.executeToolIntent({
      workerId: worker.id,
      intent: {
        intent: "summarize_completed_tasks",
        arguments: { status: "completed", from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() },
        expectedOutcome: "completed task history returned"
      }
    });
    assert.deepEqual((history.record.output as any).workers.map((item: any) => ({ objective: item.objective.description, result: item.resultSummary })), [
      { objective: "Completed history item", result: "Durable task result" }
    ]);
  } finally {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
