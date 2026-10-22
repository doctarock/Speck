import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EmbeddingClient } from "../memory/embedding.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

test("shared memory uses a learned encoder for document storage and semantic query retrieval", async () => {
  const inputs: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const values = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      inputs.push(...values);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: values.map((value: string, index: number) => ({
        object: "embedding", index, embedding: /cobalt orchard|deactivate.*crisis/i.test(value) ? [3, 0, 0] : [0, 3, 0]
      })) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test encoder failed to listen");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-embedding-model-"));
  const runtime = new SpeckRuntime({
    databasePath: path.join(directory, "speck.sqlite"),
    embeddingRuntime: {
      enabled: true, provider: "llama.cpp", baseUrl: `http://127.0.0.1:${address.port}`,
      model: "nomic-test", dimensions: 3, timeoutMs: 2_000, batchSize: 8, allowHashFallback: false
    }
  });
  try {
    const memory = await runtime.recordSharedMemory({ type: "semantic", content: "The shutdown phrase is cobalt orchard." });
    const embedding = memory.data.embedding as Record<string, unknown>;
    assert.equal(embedding.model, "nomic-test");
    assert.equal(embedding.provider, "llama.cpp");
    assert.equal(embedding.dimensions, 3);
    assert.equal(embedding.fallback, false);
    const recalled = await runtime.retrieveSharedMemories({ query: "What words deactivate everything in a crisis?", role: "planner" });
    assert.equal(recalled[0]?.object.id, memory.id);
    assert.match(inputs[0]!, /^search_document: /);
    assert.match(inputs[1]!, /^search_query: /);
  } finally {
    runtime.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("encoder failure is persisted as an explicit feature-hash fallback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-embedding-fallback-"));
  const runtime = new SpeckRuntime({
    databasePath: path.join(directory, "speck.sqlite"),
    embeddingRuntime: {
      enabled: true, provider: "ollama", baseUrl: "http://127.0.0.1:1", model: "unavailable",
      dimensions: 768, timeoutMs: 100, batchSize: 8, allowHashFallback: true
    }
  });
  try {
    const memory = await runtime.recordSharedMemory({ type: "episodic", content: "An encoder outage occurred." });
    const embedding = memory.data.embedding as Record<string, unknown>;
    assert.equal(embedding.model, "speck-feature-hash-v1");
    assert.equal(embedding.provider, "feature-hash");
    assert.equal(embedding.fallback, true);
  } finally {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an Ollama embedding model set to the CPU is asked to load no layers on the GPU", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { input: string[] };
      bodies.push(parsed);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ embeddings: parsed.input.map(() => [1, 0]) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const config = { enabled: true, provider: "ollama" as const, baseUrl: `http://127.0.0.1:${address.port}`, model: "embed", dimensions: 2, timeoutMs: 2_000, batchSize: 4, allowHashFallback: false };
    const client = new EmbeddingClient();
    await client.embed({ ...config, device: "cpu" }, ["a"], "document");
    await client.embed(config, ["b"], "document");
    assert.deepEqual(bodies[0]!.options, { num_gpu: 0 });
    assert.equal(bodies[1]!.options, undefined, "the GPU is Ollama's default and is left to it");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
