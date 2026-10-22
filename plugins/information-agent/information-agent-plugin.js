import dns from "node:dns/promises";
import net from "node:net";
import { createInformationAgentDomain } from "./lib/information-agent-domain.js";

const definitions = [
  { name: "info_agent_save_interest", description: "Save a topic to monitor for assistant or campaign research.", parameters: { id: "string", name: "string", prompt: "string", keywords: "array|string", categories: "array|string", priority: "number" } },
  { name: "info_agent_add_source", description: "Add a public web source to a monitored topic.", parameters: { interestId: "string", id: "string", type: "blog|news|social|finance|shopping|web", label: "string", url: "string", intervalMinutes: "number" } },
  { name: "info_agent_run_scan", description: "Scan due sources and report changes.", parameters: { sourceId: "string", limit: "number", emitBaseline: "boolean" } },
  { name: "info_agent_list_updates", description: "List monitored sources and recent changes.", parameters: { onlyUnacknowledged: "boolean", limit: "number" } },
  { name: "info_agent_ack_update", description: "Acknowledge an information update.", parameters: { updateId: "string", acknowledged: "boolean" } }
];

export default function createInformationAgentPlugin() {
  return {
    id: "information-agent",
    name: "Information Agent",
    version: "2.0.0",
    description: "On-demand monitoring of chosen public web sources for assistant and campaign research.",
    manifest: {
      schemaVersion: 1,
      permissions: { routes: false, uiPanels: false, data: true, capabilities: [], hooks: [], runtimeContext: [], tools: definitions.map((tool) => tool.name) },
      dependencies: { requiredCapabilities: [], optionalCapabilities: [] },
      security: { isolation: "inprocess" },
      // What this plugin is about (Genesis core API 1.5.0): read by the host to
      // decide when to offer its tools.
      topics: {
        "keywords": [
          "monitoring websites",
          "watching pages for changes",
          "competitor tracking",
          "following news",
          "price changes",
          "change summaries",
          "monitored sources",
          "research interests"
        ],
        "examples": [
          "Let me know when this page changes",
          "Track a competitor pricing page",
          "Follow news on a topic for me",
          "What changed on the sites you are watching?",
          "Check the monitored sources now"
        ]
      }
    },
    init(api) {
      const domain = createInformationAgentDomain({ dataApi: api.data, broadcast: (event) => api.broadcast(event) });
      const actions = {
        info_agent_save_interest: (args) => domain.saveInterest(args),
        info_agent_add_source: async (args) => {
          await assertPublicUrl(args.url, false);
          return domain.saveSource(args);
        },
        info_agent_run_scan: (args) => args.sourceId
          ? domain.scanSource(args.sourceId, { fetchText: fetchPublicText, emitBaseline: args.emitBaseline === true })
          : domain.runDueScans({ fetchText: fetchPublicText, limit: args.limit, emitBaseline: args.emitBaseline === true }),
        info_agent_list_updates: async (args) => {
          const state = await domain.listState();
          return { ...state, updates: state.updates.filter((update) => !args.onlyUnacknowledged || !update.acknowledged).slice(0, Math.min(100, Math.max(1, Number(args.limit || 25)))) };
        },
        info_agent_ack_update: (args) => domain.acknowledgeUpdate(args.updateId, args.acknowledged)
      };
      for (const tool of definitions) api.registerTool({ ...tool, scopes: ["worker"], risk: tool.name === "info_agent_list_updates" ? "normal" : "medium" }, actions[tool.name]);
    }
  };
}

async function assertPublicUrl(value, resolveDns = true) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("source must be a public HTTP(S) URL without credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("private source URL is not allowed");
  if (!resolveDns && !net.isIP(host)) return url;
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("private source URL is not allowed");
  return url;
}

function isPrivateAddress(address) {
  const value = String(address).toLowerCase();
  if (value.includes(":")) return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80") || value.startsWith("::ffff:") || value.startsWith("2001:db8:");
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

async function fetchPublicText(source) {
  let url = await assertPublicUrl(source.url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, { redirect: "manual", headers: { accept: "text/html,text/plain", "user-agent": "Speck Information Agent/2.0" }, signal: AbortSignal.timeout(25000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("source redirect has no location");
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`source returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("source returned no content");
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); throw new Error("source exceeds 1 MB"); }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  throw new Error("source redirected too many times");
}
