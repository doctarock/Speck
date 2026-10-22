// The toolbelt's cards read what a plugin declares it covers.

import assert from "node:assert/strict";
import test from "node:test";
import { toolCard } from "../cognition/toolbelt.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerGenesisTools } from "../tools/genesis.js";

test("a plugin's declared topics reach its tools' family and the card the encoder reads", () => {
  const registry = new ToolRegistry();
  const [tool] = registerGenesisTools(registry, {
    listTools: () => [{ name: "social_compose_posts", description: "Draft platform-specific social posts for a saved product.", pluginId: "social-media-manager", risk: "medium" }],
    listPlugins: () => [{
      id: "social-media-manager", name: "Social Media Manager", description: "Campaign products, drafts and publishing.",
      manifest: { topics: { keywords: ["LinkedIn", "Reddit"], examples: ["Write a launch post for our new product"] } }
    }],
    runHook: async () => ({ handled: false })
  });
  assert.deepEqual(tool!.family, {
    id: "social-media-manager", name: "Social Media Manager", description: "Campaign products, drafts and publishing.",
    topics: { keywords: ["LinkedIn", "Reddit"], examples: ["Write a launch post for our new product"] }
  });
  assert.equal(toolCard(tool!),
    "social compose posts: Social Media Manager (Campaign products, drafts and publishing.). Covers: LinkedIn, Reddit. For example: Write a launch post for our new product. Draft platform-specific social posts for a saved product.");
});

test("a plugin that declares no topics keeps the card it had", () => {
  const registry = new ToolRegistry();
  const [tool] = registerGenesisTools(registry, {
    listTools: () => [{ name: "airchat_check_board", description: "Summarise recent board activity.", pluginId: "airchat", risk: "read-only" }],
    listPlugins: () => [{ id: "airchat", name: "AirChat", description: "AirChat board messages.", manifest: null }],
    runHook: async () => ({ handled: false })
  });
  assert.equal(toolCard(tool!), "airchat check board: AirChat (AirChat board messages.). Summarise recent board activity.");
});
