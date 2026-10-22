import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createGenesisSpeckHost } from "../genesis-host.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

test("ported assistant plugins load through the Genesis host", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-ported-plugins-"));
  const root = path.resolve();
  fs.cpSync(path.join(root, "plugins"), path.join(directory, "plugins"), { recursive: true });
  fs.cpSync(path.join(root, "profiles"), path.join(directory, "profiles"), { recursive: true });
  const config = loadConfig({
    databasePath: path.join(directory, "speck.sqlite"),
    genesisRuntimePath: path.join(directory, "genesis"),
    genesisProfile: "minimal"
  });
  const runtime = new SpeckRuntime(config);
  let host: Awaited<ReturnType<typeof createGenesisSpeckHost>> | null = null;
  try {
    await runtime.initialize();
    host = await createGenesisSpeckHost(runtime, config, { speckRoot: directory });
    assert.deepEqual(host.pluginLoadErrors, []);
    const plugins = host.pluginManager.listPlugins();
    assert.ok(plugins.some((plugin) => plugin.id === "social-media-manager" && plugin.failureCount === 0));
    assert.ok(plugins.some((plugin) => plugin.id === "airchat" && plugin.failureCount === 0));
    assert.ok(plugins.some((plugin) => plugin.id === "information-agent" && plugin.failureCount === 0));
    assert.equal(runtime.toolRegistry.list().find((tool) => tool.name === "social_publish_post")?.risk, "external-side-effect");
    assert.equal(runtime.toolRegistry.list().find((tool) => tool.name === "airchat_read_messages")?.risk, "read-only");
    assert.equal(runtime.toolRegistry.list().find((tool) => tool.name === "info_agent_list_updates")?.risk, "read-only");

    const save = await host.pluginManager.executeTool("social_save_product", {
      name: "Example Service", description: "A real service with an explanatory description", url: "https://example.com/service"
    });
    assert.equal(save.handled, true);
    const listed = await host.pluginManager.executeTool("social_list_campaign");
    assert.equal(listed.result.products.length, 1);
    const drafts = await host.pluginManager.executeTool("social_compose_posts", {
      productId: save.result.id, platform: "linkedin", count: 1
    });
    const postId = drafts.result[0].id;
    await assert.rejects(host.pluginManager.executeTool("social_publish_post", { postId }), /approve the draft/);
    await host.pluginManager.executeTool("social_update_post", { postId, status: "approved" });
    await host.pluginManager.getCapability("speck:secret-set")?.({
      handle: "social.linkedin.webhook-url", value: "https://example.test/publish"
    });
    const originalFetch = globalThis.fetch;
    let publishCount = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      assert.equal(init?.method, "POST");
      publishCount += 1;
      if (publishCount === 1) assert.equal(JSON.parse(String(init?.body)).postId, postId);
      return new Response(JSON.stringify(publishCount === 1
        ? { id: "remote-post-1", url: "https://example.test/post/1" }
        : { id: "queued-job-2" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    try {
      const published = await host.pluginManager.executeTool("social_publish_post", { postId });
      assert.equal(published.result.post.status, "published");
      const anotherDraft = await host.pluginManager.executeTool("social_compose_posts", {
        productId: save.result.id, platform: "linkedin", count: 1
      });
      const anotherPostId = anotherDraft.result[0].id;
      await host.pluginManager.executeTool("social_update_post", { postId: anotherPostId, status: "approved" });
      const pending = await host.pluginManager.executeTool("social_publish_post", { postId: anotherPostId });
      assert.equal(pending.result.post.status, "submitted");
      await assert.rejects(host.pluginManager.executeTool("social_publish_post", { postId: anotherPostId }), /approve the draft/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const status = await host.pluginManager.executeTool("airchat_status");
    assert.deepEqual(status.result, { configured: false });
    await host.pluginManager.getCapability("speck:secret-set")?.({ handle: "airchat.url", value: "https://airchat.example.test/mcp" });
    await host.pluginManager.getCapability("speck:secret-set")?.({ handle: "airchat.token", value: "test-token" });
    const beforeAirchatFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer test-token");
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "tools/call"
        ? { structuredContent: { summary: "board ready" } } : {} }), {
        status: 200, headers: { "content-type": "application/json", "mcp-session-id": "test-session" }
      });
    }) as typeof fetch;
    try {
      const board = await host.pluginManager.executeTool("airchat_check_board");
      assert.deepEqual(board.result, { summary: "board ready" });
    } finally {
      globalThis.fetch = beforeAirchatFetch;
    }
    const interest = await host.pluginManager.executeTool("info_agent_save_interest", { name: "Campaign competitors" });
    assert.ok(interest.result.id);
    await assert.rejects(host.pluginManager.executeTool("info_agent_add_source", {
      interestId: interest.result.id, label: "Private", url: "http://127.0.0.1/admin"
    }), /private source URL/);
    await host.pluginManager.executeTool("info_agent_add_source", {
      interestId: interest.result.id, label: "Public", url: "https://example.com/updates"
    });
    const updates = await host.pluginManager.executeTool("info_agent_list_updates");
    assert.equal(updates.result.summary.interestCount, 1);
    assert.equal(updates.result.summary.sourceCount, 1);
  } finally {
    await host?.close();
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
