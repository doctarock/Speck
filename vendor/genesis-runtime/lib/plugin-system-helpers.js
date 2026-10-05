import { normalizePluginId, normalizePriority } from "../observer-compat/server/plugin-manifest.js";

export const CORE_PLUGIN_API_VERSION = "1.5.0";
export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 12000;

export { normalizePluginId, normalizePriority };

export function uniquePluginList(plugins = []) {
  const seenFactory = new Set();
  const seenIds = new Set();
  const normalized = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    if (!plugin) {
      continue;
    }
    if (typeof plugin === "function") {
      if (seenFactory.has(plugin)) {
        continue;
      }
      seenFactory.add(plugin);
      normalized.push(plugin);
      continue;
    }
    const id = normalizePluginId(plugin.id || plugin.name);
    if (!id || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    normalized.push(plugin);
  }
  return normalized;
}

export function normalizeStartupPriority(value = 100) {
  return normalizePriority(value);
}

export function parseSemver(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0)
  };
}

export function compareSemver(left = "", right = "") {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);
  if (!leftParsed && !rightParsed) {
    return 0;
  }
  if (!leftParsed) {
    return -1;
  }
  if (!rightParsed) {
    return 1;
  }
  if (leftParsed.major !== rightParsed.major) {
    return leftParsed.major - rightParsed.major;
  }
  if (leftParsed.minor !== rightParsed.minor) {
    return leftParsed.minor - rightParsed.minor;
  }
  return leftParsed.patch - rightParsed.patch;
}

export function sanitizePluginUploadName(value = "", fallback = "plugin-package") {
  const normalized = String(value || "").trim().replace(/[/\\]+/g, " ");
  const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || fallback;
}

export function inferPluginPackageIdFromName(fileName = "") {
  const baseName = String(fileName || "")
    .trim()
    .replace(/\.zip$/i, "")
    .replace(/-plugin\.(?:m?js|cjs)$/i, "")
    .replace(/\.(?:m?js|cjs)$/i, "")
    .trim();
  return normalizePluginId(baseName);
}

export function canProcessAutoRestart() {
  return Boolean(
    String(process.env.pm_id || "").trim()
    || String(process.env.PM2_HOME || "").trim()
    || String(process.env.__daemon || "").trim()
    || String(process.env.FOREVER_ROOT || "").trim()
  );
}

export function sortByPriorityThenOrder(entries = []) {
  return entries
    .slice()
    .sort((left, right) => {
      const priorityDelta = Number(left?.priority || 100) - Number(right?.priority || 100);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return Number(left?.order || 0) - Number(right?.order || 0);
    });
}
