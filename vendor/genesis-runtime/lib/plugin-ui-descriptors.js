import { normalizePluginId } from "./plugin-system-helpers.js";

export function normalizeUiPanelDescriptor(pluginId = "", panel = {}) {
  if (!panel || typeof panel !== "object") {
    return null;
  }
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId) {
    return null;
  }
  const panelId = normalizePluginId(panel.id || panel.name || panel.title);
  if (!panelId) {
    return null;
  }
  const title = String(panel.title || panel.name || panel.id || panelId).trim() || panelId;
  const description = String(panel.description || "").trim();
  const fields = Array.isArray(panel.fields)
    ? panel.fields
        .map((field) => {
          if (!field || typeof field !== "object") {
            return null;
          }
          const fieldId = normalizePluginId(field.id || field.name || field.label);
          if (!fieldId) {
            return null;
          }
          const type = String(field.type || "text").trim().toLowerCase();
          const normalizedType = ["text", "number", "checkbox", "textarea"].includes(type) ? type : "text";
          return {
            id: fieldId,
            label: String(field.label || fieldId).trim() || fieldId,
            type: normalizedType,
            placeholder: String(field.placeholder || "").trim(),
            required: field.required === true,
            defaultValue: field.defaultValue == null ? "" : field.defaultValue,
            min: field.min == null ? null : Number(field.min),
            max: field.max == null ? null : Number(field.max),
            step: field.step == null ? null : Number(field.step),
            format: String(field.format || "").trim().toLowerCase() || ""
          };
        })
        .filter(Boolean)
    : [];
  const actions = Array.isArray(panel.actions)
    ? panel.actions
        .map((action) => {
          if (!action || typeof action !== "object") {
            return null;
          }
          const actionId = normalizePluginId(action.id || action.name || action.label);
          const endpoint = String(action.endpoint || "").trim();
          if (!actionId || !endpoint) {
            return null;
          }
          const method = String(action.method || "GET").trim().toUpperCase() || "GET";
          return {
            id: actionId,
            label: String(action.label || actionId).trim() || actionId,
            method,
            endpoint,
            queryFields: Array.isArray(action.queryFields)
              ? action.queryFields.map((entry) => normalizePluginId(entry)).filter(Boolean)
              : [],
            bodyFields: Array.isArray(action.bodyFields)
              ? action.bodyFields.map((entry) => normalizePluginId(entry)).filter(Boolean)
              : [],
            staticBody: action.staticBody && typeof action.staticBody === "object"
              ? action.staticBody
              : {},
            expects: String(action.expects || "json").trim().toLowerCase() || "json",
            confirm: String(action.confirm || "").trim()
          };
        })
        .filter(Boolean)
    : [];
  return {
    id: panelId,
    pluginId: normalizedPluginId,
    title,
    description,
    fields,
    actions
  };
}

export function normalizeUiTabDescriptorBase(pluginId = "", tab = {}, { includeIcon = false } = {}) {
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId || !tab || typeof tab !== "object") {
    return null;
  }
  const tabId = normalizePluginId(tab.id || tab.name || tab.title || normalizedPluginId);
  const scriptUrl = String(tab.scriptUrl || tab.script || "").trim();
  if (!tabId || !scriptUrl || !scriptUrl.startsWith("/")) {
    return null;
  }
  return {
    id: tabId,
    pluginId: normalizedPluginId,
    title: String(tab.title || tab.name || tabId).trim() || tabId,
    ...(includeIcon
      ? { icon: String(tab.icon || tab.iconText || tabId.slice(0, 1).toUpperCase()).trim().slice(0, 4) || tabId.slice(0, 1).toUpperCase() }
      : {}),
    order: Number.isFinite(Number(tab.order)) ? Number(tab.order) : 100,
    scriptUrl
  };
}

export function normalizeUiPrimaryTabDescriptor(pluginId = "", tab = {}) {
  return normalizeUiTabDescriptorBase(pluginId, tab);
}

export function normalizeUiSecretsTabDescriptor(pluginId = "", tab = {}) {
  return normalizeUiTabDescriptorBase(pluginId, tab);
}

export function normalizeUiTabDescriptor(pluginId = "", tab = {}) {
  return normalizeUiTabDescriptorBase(pluginId, tab, { includeIcon: true });
}

export function normalizeUiSystemTabDescriptor(pluginId = "", tab = {}) {
  return normalizeUiSecretsTabDescriptor(pluginId, tab);
}

export function listPluginUiEntries(store, pluginId = "") {
  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId) {
    return [];
  }
  return (store.get(normalizedPluginId) || []).slice();
}
