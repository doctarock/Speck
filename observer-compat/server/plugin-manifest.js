export function normalizePluginId(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function normalizePriority(value = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1000, Math.round(parsed))) : 100;
}

export function normalizePermissionRules(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : value === true
      ? ["*"]
      : [];
}

export function normalizeManifestPermissions(permissions = {}) {
  return {
    routes: permissions.routes === true,
    uiPanels: permissions.uiPanels === true,
    data: permissions.data === true,
    capabilities: normalizePermissionRules(permissions.capabilities),
    hooks: normalizePermissionRules(permissions.hooks),
    runtimeContext: normalizePermissionRules(permissions.runtimeContext),
    tools: normalizePermissionRules(permissions.tools)
  };
}

export function normalizePluginManifest(manifest = {}) {
  return {
    schemaVersion: Number(manifest?.schemaVersion || 1),
    startupPriority: normalizePriority(manifest?.startupPriority),
    permissions: normalizeManifestPermissions(manifest?.permissions || {}),
    compatibility: {
      coreApiMin: String(manifest?.compatibility?.coreApiMin || "").trim(),
      coreApiMax: String(manifest?.compatibility?.coreApiMax || "").trim()
    },
    dependencies: {
      requiredCapabilities: Array.isArray(manifest?.dependencies?.requiredCapabilities)
        ? manifest.dependencies.requiredCapabilities.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [],
      optionalCapabilities: Array.isArray(manifest?.dependencies?.optionalCapabilities)
        ? manifest.dependencies.optionalCapabilities.map((entry) => String(entry || "").trim()).filter(Boolean)
        : []
    },
    security: {
      isolation: String(manifest?.security?.isolation || "inprocess").trim().toLowerCase() === "process"
        ? "process"
        : "inprocess"
    }
  };
}

export function hasManifestPermission(rules = [], name = "") {
  if (!Array.isArray(rules) || !rules.length) {
    return false;
  }
  if (rules.includes("*")) {
    return true;
  }
  const normalizedName = String(name || "").trim();
  return rules.some((rule) => {
    const normalizedRule = String(rule || "").trim();
    if (!normalizedRule) return false;
    if (normalizedRule.endsWith("*")) {
      return normalizedName.startsWith(normalizedRule.slice(0, -1));
    }
    return normalizedRule === normalizedName;
  });
}

export function normalizeUiPanelDescriptor(pluginId = "", panel = {}) {
  if (!panel || typeof panel !== "object") return null;
  const panelId = normalizePluginId(panel.id || panel.name || panel.title);
  if (!panelId) return null;
  return {
    id: panelId,
    pluginId: normalizePluginId(pluginId),
    title: String(panel.title || panel.name || panel.id || panelId).trim() || panelId,
    description: String(panel.description || "").trim(),
    fields: Array.isArray(panel.fields) ? panel.fields : [],
    actions: Array.isArray(panel.actions) ? panel.actions : []
  };
}

export function normalizeUiTabDescriptor(pluginId = "", tab = {}, { includeIcon = true } = {}) {
  if (!tab || typeof tab !== "object") return null;
  const tabId = normalizePluginId(tab.id || tab.name || tab.title || pluginId);
  const scriptUrl = String(tab.scriptUrl || tab.script || "").trim();
  if (!tabId || !scriptUrl || !scriptUrl.startsWith("/")) return null;
  const normalized = {
    id: tabId,
    pluginId: normalizePluginId(pluginId),
    title: String(tab.title || tab.name || tabId).trim() || tabId,
    order: Number.isFinite(Number(tab.order)) ? Number(tab.order) : 100,
    scriptUrl
  };
  if (includeIcon) {
    normalized.icon = String(tab.icon || tab.iconText || tabId.slice(0, 1).toUpperCase()).trim().slice(0, 4) || tabId.slice(0, 1).toUpperCase();
  }
  return normalized;
}
