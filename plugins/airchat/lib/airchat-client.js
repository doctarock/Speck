const PROTOCOL_VERSION = "2025-06-18";

// AirChat wraps tool output in an untrusted-data fence; strip it before parsing.
const DATA_FENCE_START = /^\s*\[AIRCHAT DATA[^\]]*\]\s*/;
const DATA_FENCE_END = /\s*\[END AIRCHAT DATA\]\s*$/;

function parseSseJsonBody(text = "", id) {
  const candidates = [String(text), ...String(text).split(/\r?\n\r?\n/).map((event) =>
    event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n"))];
  for (const payload of candidates) {
    try {
      const json = JSON.parse(payload);
      if (json?.id === id && ("result" in json || "error" in json)) return json;
    } catch {
      continue;
    }
  }
  return null;
}

export function unwrapAirchatText(text = "") {
  const inner = String(text || "").replace(DATA_FENCE_START, "").replace(DATA_FENCE_END, "");
  try {
    return JSON.parse(inner);
  } catch {
    return inner;
  }
}

export function createAirchatClient({ url = "", token = "", clientName = "speck" } = {}) {
  const endpoint = String(url || "").trim();
  const bearer = String(token || "").trim();
  let sessionId = "";
  let initialized = false;
  let initializing = null;
  let requestId = 0;

  async function post(body, { timeoutMs = 30000 } = {}) {
    if (!endpoint || !bearer) {
      throw new Error("AirChat url/token not configured");
    }
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
      "mcp-protocol-version": PROTOCOL_VERSION
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const returnedSessionId = res.headers.get("mcp-session-id");
    if (returnedSessionId) {
      sessionId = returnedSessionId;
    }
    const text = await res.text();
    return { status: res.status, text };
  }

  async function rpc(method, params = {}, options = {}) {
    const id = ++requestId;
    const { status, text } = await post({ jsonrpc: "2.0", id, method, params }, options);
    if (status === 404 && sessionId) {
      // Session expired server-side; caller retries after re-initialising.
      sessionId = "";
      initialized = false;
      const error = new Error("AirChat session expired");
      error.sessionExpired = true;
      throw error;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`AirChat HTTP ${status}: ${String(text || "").slice(0, 200)}`);
    }
    const json = parseSseJsonBody(text, id);
    if (!json) {
      throw new Error("could not parse AirChat MCP response");
    }
    if (json.error) {
      throw new Error(json.error.message || "AirChat MCP error");
    }
    return json.result;
  }

  async function ensureSession() {
    if (initialized) {
      return;
    }
    if (initializing) return initializing;
    initializing = (async () => {
      await rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" }
      });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => null);
      initialized = true;
    })();
    try {
      await initializing;
    } finally {
      initializing = null;
    }
  }

  async function callTool(name, args = {}, options = {}) {
    await ensureSession();
    let result;
    try {
      result = await rpc("tools/call", { name, arguments: args }, options);
    } catch (error) {
      if (!error?.sessionExpired) {
        throw error;
      }
      await ensureSession();
      result = await rpc("tools/call", { name, arguments: args }, options);
    }
    const text = Array.isArray(result?.content)
      ? result.content.filter((entry) => entry?.type === "text").map((entry) => entry.text).join("\n")
      : "";
    if (result?.isError) {
      throw new Error(text || `AirChat tool ${name} failed`);
    }
    return result?.structuredContent ?? (text ? unwrapAirchatText(text) : result);
  }

  return { callTool };
}
