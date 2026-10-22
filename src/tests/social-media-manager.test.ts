import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { createGenesisSpeckHost } from "../genesis-host.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";

type Domain = Record<string, (...args: any[]) => Promise<any>>;

async function createDomain(initial: unknown = {}): Promise<{ domain: Domain; stored: () => any }> {
  const modulePath = path.resolve("plugins", "social-media-manager", "lib", "social-media-manager-domain.js");
  const { createSocialMediaManagerDomain } = await import(pathToFileURL(modulePath).href);
  let saved: unknown = structuredClone(initial);
  const dataApi = {
    readJson: async (_key: string, fallback: unknown) => structuredClone(saved ?? fallback),
    writeJson: async (_key: string, value: unknown) => { saved = structuredClone(value); }
  };
  return { domain: createSocialMediaManagerDomain({ dataApi }), stored: () => saved };
}

test("each property keeps its own products, channels and posts", async () => {
  const { domain } = await createDomain();
  const printing = await domain.saveProperty!({ name: "Example Prints", website: "https://print.example", platforms: ["facebook", "Instagram"] });
  const cafe = await domain.saveProperty!({ name: "Corner Cafe", platforms: "linkedin, x", voice: "concise" });
  assert.equal(printing.id, "example-prints");
  assert.deepEqual(printing.channels.map((channel: any) => channel.platform), ["facebook", "instagram"]);
  assert.deepEqual(cafe.channels.map((channel: any) => channel.platform), ["linkedin", "x"]);

  await assert.rejects(domain.saveProduct!({ name: "Prints", description: "Custom prints" }), /Several properties exist; pass propertyId.*Example Prints/);
  const prints = await domain.saveProduct!({ propertyId: printing.id, name: "Custom prints", description: "Prints made to order" });
  const sameName = await domain.saveProduct!({ propertyId: "Corner Cafe", name: "Custom prints", description: "Cakes made to order" });
  assert.notEqual(prints.id, sameName.id, "the same product name in another property is a different product");
  assert.equal(sameName.propertyId, cafe.id);

  await assert.rejects(domain.composePosts!({ productId: prints.id, platform: "linkedin" }), /LinkedIn is not one of Example Prints's channels: Facebook Page, Instagram/);
  const [draft] = await domain.composePosts!({ productId: prints.id, count: 1 });
  assert.equal(draft.platform, "facebook", "a draft without a platform goes to the property's first channel");
  assert.equal(draft.propertyId, printing.id);
  assert.match(draft.body, /https:\/\/print\.example/, "the property website stands in for a product without a URL");
  assert.match(draft.body, /\n\n/, "drafts keep their paragraphs");

  const scoped = await domain.listState!({ propertyId: cafe.id });
  assert.deepEqual(scoped.products.map((product: any) => product.id), [sameName.id]);
  assert.equal(scoped.posts.length, 0);
  assert.equal(scoped.allProperties.length, 2);
  assert.equal(scoped.allProperties.find((entry: any) => entry.id === printing.id).summary.drafts, 1);

  const report = await domain.buildReport!({});
  assert.match(report.text, /all 2 properties/);
  assert.match(report.text, /Example Prints: 1 products, 1 posts/);

  const removed = await domain.removeProperty!(printing.id);
  assert.deepEqual(removed.removed, { products: 1, opportunities: 0, posts: 1, interactions: 0, publishingTargets: 0 });
  const remaining = await domain.listState!();
  assert.deepEqual(remaining.properties.map((entry: any) => entry.id), [cafe.id]);
  assert.equal(remaining.posts.length, 0);
});

test("records saved before properties existed join a default property", async () => {
  const { domain, stored } = await createDomain({
    products: [{ id: "product-old", name: "Old product", description: "Saved by version 2" }],
    posts: [{ id: "post-old", productId: "product-old", platform: "LinkedIn", body: "Hello" }],
    interactions: [{ id: "interaction-old", postId: "post-old", text: "Nice" }]
  });
  const state = await domain.listState!();
  assert.deepEqual(state.properties.map((entry: any) => entry.id), ["default"]);
  assert.equal(state.products[0].propertyId, "default");
  assert.equal(state.posts[0].propertyId, "default");
  assert.equal(state.posts[0].platform, "linkedin");
  assert.equal(state.interactions[0].propertyId, "default");
  await assert.rejects(domain.saveProperty!({ id: "default" }), /real name/);
  const renamed = await domain.saveProperty!({ id: "default", name: "Main Store", platforms: ["linkedin"] });
  assert.equal(renamed.id, "default");
  assert.equal((stored() as any).products[0].propertyId, "default");
  // With one property, requests need not name it.
  const product = await domain.saveProduct!({ name: "New product", url: "https://store.example/new" });
  assert.equal(product.propertyId, "default");
});

test("a property's own publishing target is preferred over a shared one", async () => {
  const { domain } = await createDomain();
  const first = await domain.saveProperty!({ name: "First", platforms: ["x"] });
  const second = await domain.saveProperty!({ name: "Second", platforms: ["x"] });
  const target = { platform: "x", composerUrl: "https://x.example/compose", bodySelector: "#body", submitSelector: "#send" };
  await domain.savePublishingTarget!({ ...target, accountId: "shared", label: "Shared X" });
  const own = await domain.savePublishingTarget!({ ...target, accountId: "second", label: "Second X", propertyId: second.id });
  assert.equal((await domain.findPublishingTarget!({ platform: "x", propertyId: second.id })).id, own.id);
  assert.equal((await domain.findPublishingTarget!({ platform: "x", propertyId: first.id })).accountId, "shared");
  assert.equal((await domain.listState!({ propertyId: first.id })).publishingTargets.length, 1);
});

test("the Social tab manages properties through admin routes and publishes with a property's webhook", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-social-"));
  const root = path.resolve();
  fs.cpSync(path.join(root, "plugins"), path.join(directory, "plugins"), { recursive: true });
  fs.rmSync(path.join(directory, "plugins", ".runtime", "plugin-state.json"), { force: true });
  fs.cpSync(path.join(root, "profiles"), path.join(directory, "profiles"), { recursive: true });
  const config = loadConfig({
    databasePath: path.join(directory, "speck.sqlite"),
    genesisRuntimePath: path.join(directory, "genesis"),
    genesisProfile: "minimal"
  });
  const runtime = new SpeckRuntime(config);
  let host: Awaited<ReturnType<typeof createGenesisSpeckHost>> | null = null;
  let server: Server | null = null;
  const originalFetch = globalThis.fetch;
  try {
    await runtime.initialize();
    host = await createGenesisSpeckHost(runtime, config, { speckRoot: directory });
    assert.deepEqual(host.pluginLoadErrors, []);
    server = host.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const token = String(((await (await fetch(`${origin}/api/admin-token`, { headers: { origin } })).json()) as { token?: string }).token ?? "");
    const call = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${origin}/api/plugins/social-media-manager${route}`, {
        method,
        headers: { origin, "x-admin-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const payload = await response.json() as any;
      if (!response.ok) throw new Error(payload.error);
      return payload;
    };

    const catalog = await (await fetch(`${origin}/api/plugins/list`, { headers: { origin, "x-admin-token": token } })).json() as any;
    const tab = catalog.uiPrimaryTabs.find((entry: any) => entry.pluginId === "social-media-manager");
    assert.equal(tab?.title, "Social");
    const script = await fetch(`${origin}${tab.scriptUrl}`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(await script.text(), /export async function mountPluginTab/);
    assert.equal((await fetch(`${origin}/api/plugins/social-media-manager/state`, { headers: { origin } })).status, 403, "data routes need the admin token");

    const { property: store } = await call("/properties", "POST", { name: "Store", platforms: ["linkedin"] });
    await call("/properties", "POST", { name: "Studio", platforms: ["linkedin"] });
    const { product } = await call("/products", "POST", { propertyId: store.id, name: "Widget", url: "https://store.example/widget" });
    const { posts: [post] } = await call("/posts/compose", "POST", { productId: product.id, propertyId: store.id, count: 1 });
    assert.equal(post.platform, "linkedin");
    await call(`/posts/${post.id}`, "PATCH", { status: "approved" });

    const before = await call(`/properties/${store.id}/secrets`);
    assert.deepEqual(before.secrets.channels[0].handles, { url: "social.store.linkedin.webhook-url", token: "social.store.linkedin.webhook-token" });
    assert.equal(before.secrets.channels[0].webhookUrl, false);
    await assert.rejects(call(`/properties/${store.id}/secrets`, "POST", { platform: "linkedin", kind: "url", value: "http://insecure.example" }), /HTTPS/);
    await call(`/properties/${store.id}/secrets`, "POST", { platform: "linkedin", kind: "url", value: "https://store-hook.example/publish" });
    await host.pluginManager.getCapability("speck:secret-set")?.({ handle: "social.linkedin.webhook-url", value: "https://shared-hook.example/publish" });
    assert.equal((await call(`/properties/${store.id}/secrets`)).secrets.channels[0].webhookUrl, true);

    const hooks: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input instanceof URL ? input.href : input);
      if (!url.includes("-hook.example")) return originalFetch(input, init);
      hooks.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ url: "https://linkedin.example/post/1" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const published = await call(`/posts/${post.id}/publish`, "POST", {});
    assert.equal(published.post.status, "published");
    assert.equal(hooks[0]?.url, "https://store-hook.example/publish", "the property's own webhook is used before the shared one");
    assert.equal(hooks[0]?.body.propertyId, store.id);

    const studioState = (await call("/state?propertyId=Studio")).state;
    assert.equal(studioState.posts.length, 0);
    assert.equal(studioState.allProperties.length, 2);
    const listed = await host.pluginManager.executeTool("social_list_properties");
    assert.deepEqual(listed.result.properties.map((entry: any) => entry.name), ["Store", "Studio"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await host?.close();
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
