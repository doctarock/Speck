import { createAirchatClient } from "./lib/airchat-client.js";

const tools = [
  ["airchat_check_work", "check_work", {}, "Check mentions and tasks waiting on this agent."],
  ["airchat_check_board", "check_board", {}, "Summarise recent board activity."],
  ["airchat_list_channels", "list_channels", { type: "string" }, "List available channels."],
  ["airchat_read_messages", "read_messages", { channel: "string", limit: "number", before: "string", full: "boolean" }, "Read recent channel messages."],
  ["airchat_search_messages", "search_messages", { query: "string", channel: "string" }, "Search board messages."],
  ["airchat_find_agents", "find_agents", { capability: "string", active_within: "string" }, "Find agents by capability."],
  ["airchat_send_message", "send_message", { channel: "string", content: "string", parent_message_id: "string" }, "Send a channel message."],
  ["airchat_send_direct_message", "send_direct_message", { target_agent: "string", content: "string" }, "Send a direct message to an agent."],
  ["airchat_mark_mentions_read", "mark_mentions_read", { mention_ids: "array" }, "Mark handled mentions read."],
  ["airchat_post_task", "post_task", { channel: "string", title: "string", body: "string", capability_tags: "array" }, "Post a task for another agent."],
  ["airchat_check_tasks", "check_tasks", { status: "string", capability: "string", mine: "string", channel: "string", limit: "number" }, "Review AirChat tasks."],
  ["airchat_update_task", "update_task", { task_id: "string", action: "string", result: "string" }, "Claim, complete or cancel a task."],
  ["airchat_read_note", "read_note", { slug: "string", channel: "string", full: "boolean" }, "Read a shared note."],
  ["airchat_write_note", "write_note", { slug: "string", title: "string", body_md: "string", channel: "string" }, "Write a shared note."],
  ["airchat_list_notes", "list_notes", { channel: "string", query: "string", limit: "number" }, "List or search shared notes."],
  ["airchat_list_models", "list_models", {}, "List models on the AirChat fleet."],
  ["airchat_run_model", "run_model", { prompt: "string", model: "string", wait_seconds: "number" }, "Run a one-shot fleet model prompt."]
];

const readOnly = new Set(["check_work", "check_board", "list_channels", "read_messages", "search_messages", "find_agents", "check_tasks", "read_note", "list_notes", "list_models"]);

export default function createAirchatPlugin() {
  return {
    id: "airchat",
    name: "AirChat",
    version: "2.0.0",
    description: "AirChat board messages, tasks, notes and fleet models over MCP.",
    manifest: {
      schemaVersion: 1,
      permissions: { routes: false, uiPanels: false, data: false, capabilities: [], hooks: [], runtimeContext: [], tools: ["airchat_status", ...tools.map(([name]) => name)] },
      dependencies: { requiredCapabilities: ["speck:secret-get"], optionalCapabilities: [] },
      security: { isolation: "inprocess" },
      // What this plugin is about (Genesis core API 1.5.0): read by the host to
      // decide when to offer its tools.
      topics: {
        "keywords": [
          "AirChat",
          "agent message board",
          "channels",
          "mentions",
          "direct messages to other agents",
          "tasks for other agents",
          "claiming and completing agent tasks",
          "shared notes",
          "agent discovery",
          "agent fleet",
          "fleet models"
        ],
        "examples": [
          "What is new on the AirChat board?",
          "Tell the agents in the ops channel that the deploy is done",
          "Is any agent asking me for something?",
          "Hand this job to an agent that can translate",
          "Read the team runbook note on AirChat",
          "Run this prompt on one of the fleet models"
        ]
      }
    },
    init(api) {
      const getSecret = api.getCapability("speck:secret-get");
      let cached = null;
      const connection = async () => {
        const url = String(await getSecret({ handle: "airchat.url" }) || "").trim();
        const token = String(await getSecret({ handle: "airchat.token" }) || "").trim();
        if (!url || !token) throw new Error("configure airchat.url and airchat.token in Speck secrets");
        const endpoint = new URL(url);
        if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname))) {
          throw new Error("AirChat endpoint must be HTTPS or local HTTP");
        }
        if (!cached || cached.url !== url || cached.token !== token) cached = { url, token, client: createAirchatClient({ url, token, clientName: "speck" }) };
        return cached.client;
      };
      api.registerTool({ name: "airchat_status", description: "Check whether AirChat credentials are configured.", scopes: ["worker"], parameters: {} }, async () => ({
        configured: Boolean(await getSecret({ handle: "airchat.url" }) && await getSecret({ handle: "airchat.token" }))
      }));
      for (const [name, remoteName, parameters, description] of tools) {
        api.registerTool({ name, description, scopes: ["worker"], risk: readOnly.has(remoteName) ? "read-only" : "high", parameters }, async (args) => {
          const client = await connection();
          const clean = Object.fromEntries(Object.entries(args || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""));
          if (typeof clean.channel === "string") clean.channel = clean.channel.replace(/^#/, "").toLowerCase();
          return client.callTool(remoteName, clean, { timeoutMs: remoteName === "run_model" ? 620000 : 30000 });
        });
      }
    }
  };
}
