// The components of Speck's default path. ADMITTED are on the path by
// default, in order; each entry names the measurement that admitted it.
// CANDIDATES can be switched on for a gate run (recovery harness gate.mjs)
// but are not on the path until admitted. docs/REINTEGRATION.md keeps the
// order components return in and each gate result.

import type { Component } from "../component.js";
import { memory } from "./memory.js";
import { files } from "./files.js";
import { ledger } from "./ledger.js";
import { pages, web } from "./web.js";
import { ruleLearning } from "./rule-learning.js";

export const ADMITTED: ReadonlyArray<{ component: Component; admittedBy: string }> = [
  { component: ruleLearning, admittedBy: "docs/remediation/reader-2026-10-20/DEFAULT-PATH-RESULTS.md (2026-10-20)" },
  { component: memory, admittedBy: "docs/REINTEGRATION.md, gate results 2026-10-21 (memory-set/1 and held-out memory-set/2)" },
  { component: files, admittedBy: "docs/REINTEGRATION.md, gate results 2026-10-21 (tools-set/1 and held-out tools-set/2)" },
  { component: pages, admittedBy: "docs/REINTEGRATION.md, gate results 2026-10-22 (web-set/1 and web-set/2)" }
];

export const CANDIDATES: Readonly<Record<string, Component>> = { ledger, web };

// The admitted components on the path: every one without a switch, and each
// switchable one that is on (the saved setting, else its default).
export function admittedComponents(switches: Readonly<Record<string, boolean>> = {}): Component[] {
  return ADMITTED.map((entry) => entry.component)
    .filter((component) => !component.option || (switches[component.id] ?? component.option.enabledByDefault));
}

// The switches the System → Cognition page shows, with their current state.
export function componentSwitches(switches: Readonly<Record<string, boolean>> = {}) {
  return ADMITTED.filter((entry) => entry.component.option).map(({ component, admittedBy }) => ({
    id: component.id, ...component.option!, enabled: switches[component.id] ?? component.option!.enabledByDefault, admittedBy
  }));
}

// A saved setting keeps only real switches, as booleans.
export function normalizeComponentSwitches(value: unknown): Record<string, boolean> {
  const given = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const known = new Set(ADMITTED.filter((entry) => entry.component.option).map((entry) => entry.component.id));
  return Object.fromEntries(Object.entries(given).filter(([id, on]) => known.has(id) && typeof on === "boolean")) as Record<string, boolean>;
}

// Components by id, admitted first then candidates; unknown ids are an error.
export function componentsById(ids: readonly string[]): Component[] {
  const all = new Map<string, Component>([...ADMITTED.map((entry) => [entry.component.id, entry.component] as const), ...Object.entries(CANDIDATES).map(([, c]) => [c.id, c] as const)]);
  return ids.map((id) => {
    const found = all.get(id);
    if (!found) throw new Error(`No component "${id}" (known: ${[...all.keys()].join(", ")})`);
    return found;
  });
}
