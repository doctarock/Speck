// Switches on the System → Cognition page for default-path components that
// add time or features without improving answers; components that improve
// answers have none and are always on.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { admittedComponents, componentSwitches, normalizeComponentSwitches } from "../speck/components/index.js";

const ids = (switches?: Record<string, boolean>) => admittedComponents(switches).map((component) => component.id);

test("feature components are switchable and on by default; rule learning has no switch", () => {
  assert.deepEqual(ids(), ["rule", "memory", "files", "pages"]);
  assert.deepEqual(componentSwitches().map((entry) => [entry.id, entry.enabled]), [["memory", true], ["files", true], ["pages", true]]);
  assert.ok(componentSwitches().every((entry) => entry.label && entry.description && entry.cost));
});

test("a switched-off component leaves the path; the rule component cannot be switched off", () => {
  assert.deepEqual(ids({ files: false }), ["rule", "memory", "pages"]);
  assert.deepEqual(ids({ memory: false, files: false, pages: false, rule: false }), ["rule"]);
  assert.deepEqual(normalizeComponentSwitches({ files: false, rule: false, unknown: true, memory: "no" }), { files: false });
});

test("the page and the interface carry the switches", () => {
  const ui = fs.readFileSync(path.resolve("public", "ui", "system.js"), "utf8");
  assert.match(ui, /\/api\/speck\/components/);
  assert.match(ui, /data-speck-component/);
  const routes = fs.readFileSync(path.resolve("src", "genesis-ui", "routes", "config.ts"), "utf8");
  assert.match(routes, /app\.post\("\/api\/speck\/components"/);
  const agent = fs.readFileSync(path.resolve("src", "genesis-ui", "routes", "agent.ts"), "utf8");
  assert.match(agent, /admittedComponents\(state\.components\)/);
});
