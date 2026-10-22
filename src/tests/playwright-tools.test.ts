import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { BrowserRuntimeConfig } from "../config.js";
import { playwrightHealth, playwrightReadPage, playwrightSearch } from "../tools/playwright.js";

test("Playwright browser client searches and reads through its closed endpoint set", async () => {
  const requests: Array<{ path: string; body: any }> = [];
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, browser: true, endpoints: ["/api/search", "/api/page"] }));
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ path: request.url || "", body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/search") response.end(JSON.stringify({ query: body.query, results: [{ title: "Result", url: "https://example.com", snippet: "Text" }] }));
      else if (request.url === "/api/page") response.end(JSON.stringify({ url: body.url, title: "Example", text: "Page text", links: [] }));
      else { response.statusCode = 404; response.end(JSON.stringify({ error: "Not found" })); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const config: BrowserRuntimeConfig = { enabled: true, baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2_000, searchLimit: 6 };
  try {
    assert.equal((await playwrightHealth(config)).browser, true);
    const searched = await playwrightSearch(config, "current Speck release", 3);
    assert.match(String(searched.warning), /untrusted content/);
    assert.equal((searched.data as any).results[0].title, "Result");
    const page = await playwrightReadPage(config, "https://example.com/article");
    assert.equal((page.data as any).title, "Example");
    assert.deepEqual(requests.map((entry) => entry.path), ["/api/search", "/api/page"]);
    assert.deepEqual(requests[0]?.body, { query: "current Speck release", limit: 3 });
    await assert.rejects(() => playwrightReadPage(config, "http://192.168.0.1/private"), /public web URLs/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
