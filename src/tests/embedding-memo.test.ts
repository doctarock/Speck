// Encoder vectors are memoised for the process: a text already embedded for
// the same encoder and purpose is not requested again (2026-10-21, from the
// developed version's amplification work).

import assert from "node:assert/strict";
import test from "node:test";
import { EmbeddingClient, embeddingOptions } from "../memory/embedding.js";

test("only texts not yet embedded are requested, and vectors come back in order", async () => {
  const requested: string[][] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const input = (JSON.parse(init.body) as { input: string[] }).input;
    requested.push(input);
    return { ok: true, json: async () => ({ embeddings: input.map((text) => [text.length, 1]) }) };
  }) as unknown as typeof fetch;
  try {
    const config = { provider: "ollama", baseUrl: "http://encoder", model: "memo-test", timeoutMs: 1_000, batchSize: 16, dimensions: 2 } as never;
    const client = new EmbeddingClient();
    const first = await client.embed(config, ["alpha", "beta"], "document");
    const second = await client.embed(config, ["beta", "gamma", "alpha"], "document");
    await client.embed(config, ["alpha"], "query");
    assert.deepEqual(requested, [["search_document: alpha", "search_document: beta"], ["search_document: gamma"], ["search_query: alpha"]]);
    assert.deepEqual(second[0], first[1]);
    assert.deepEqual(second[2], first[0]);
    embeddingOptions.memo = false;
    await client.embed(config, ["alpha"], "document");
    assert.equal(requested.length, 4, "with the memo off every call is requested");
  } finally {
    embeddingOptions.memo = true;
    globalThis.fetch = original;
  }
});
