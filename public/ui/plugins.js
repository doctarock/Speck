// The Plugins panel and plugin-provided tabs.

import { state, $, $$, escapeHtml, formatTime, adminFetch, adminJson, showToast } from "./core.js";
import { refreshWorkspace } from "./workspace.js";

export function renderPluginsPanel() {
  const catalog = state.plugins || {};
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const panels = Array.isArray(catalog.uiPanels) ? catalog.uiPanels : [];
  // Primary tabs have their own views in the rail.
  const tabs = [catalog.uiTabs, catalog.uiSecretsTabs]
    .flatMap((value) => Array.isArray(value) ? value : []);
  $("#panelContent").innerHTML = `<div class="toolbar">
      <input id="pluginFile" type="file" accept=".js,.mjs,.cjs,.zip" />
      <button id="installPlugin" class="ghost-button">Install package</button>
    </div>
    <div class="plugin-stack" id="pluginList">${plugins.map(pluginRow).join("") || `<div class="empty-state">No plugins installed. Speck remains small until you add one.</div>`}</div>
    ${panels.map(pluginPanel).join("")}
    <div id="pluginTabHosts"></div>`;
  $$('[data-plugin-toggle]').forEach((input) => input.addEventListener("change", togglePlugin));
  $$('[data-plugin-action]').forEach((button) => button.addEventListener("click", runPluginAction));
  $("#installPlugin")?.addEventListener("click", installPlugin);
  mountPluginTabs(tabs).catch((error) => showToast(error.message, true));
}

export function pluginPrimaryTabs() {
  const tabs = Array.isArray(state.plugins?.uiPrimaryTabs) ? state.plugins.uiPrimaryTabs : [];
  return tabs.filter((tab) => tab?.scriptUrl && tab.enabled !== false)
    .sort((left, right) => Number(left.order ?? 100) - Number(right.order ?? 100));
}

export const pluginViewId = (tab) => `plugin:${tab.pluginId}:${tab.id}`;

export function renderPluginView(tab) {
  $("#panelEyebrow").textContent = tab.pluginName || tab.pluginId || "Plugin";
  $("#panelTitle").textContent = tab.title || tab.id;
  $("#panelDescription").textContent = `Provided by the ${tab.pluginName || tab.pluginId} plugin.`;
  $("#panelContent").innerHTML = `<div class="plugin-view-host" data-mount></div>`;
  const root = $("#panelContent [data-mount]");
  mountPluginTab(tab, root).catch((error) => {
    root.innerHTML = `<div class="empty-state">${escapeHtml(tab.title || tab.id)} could not load.<br>${escapeHtml(error.message)}</div>`;
  });
}

export function pluginRow(plugin) {
  return `<article class="plugin-row"><div><h3>${escapeHtml(plugin.name || plugin.id)}</h3>
    <p>${escapeHtml(plugin.description || "No description")} · ${Number(plugin.capabilityCount || 0)} capabilities · ${Number(plugin.routeCount || 0)} routes</p></div>
    <label class="switch"><input type="checkbox" data-plugin-toggle="${escapeHtml(plugin.id)}" ${plugin.enabled !== false ? "checked" : ""}/><i></i></label></article>`;
}

export function pluginPanel(panel, index) {
  const key = `plugin-panel-${index}`;
  const fields = Array.isArray(panel.fields) ? panel.fields : [];
  const actions = Array.isArray(panel.actions) ? panel.actions : [];
  return `<section class="plugin-panel" data-panel-index="${index}"><h3>${escapeHtml(panel.title || panel.id)}</h3><p>${escapeHtml(panel.description || "Plugin-provided interface")}</p>
    <div class="plugin-fields">${fields.map((field) => `<label class="plugin-field">${escapeHtml(field.label || field.id)}${field.type === "textarea"
      ? `<textarea data-field="${escapeHtml(field.id)}" placeholder="${escapeHtml(field.placeholder || "")}"></textarea>`
      : `<input data-field="${escapeHtml(field.id)}" type="${field.type === "number" ? "number" : field.type === "checkbox" ? "checkbox" : "text"}" placeholder="${escapeHtml(field.placeholder || "")}" />`}</label>`).join("")}</div>
    <div class="plugin-actions">${actions.map((action, actionIndex) => `<button class="ghost-button" data-plugin-action="${index}:${actionIndex}">${escapeHtml(action.label || action.id || "Run")}</button>`).join("")}</div>
    <pre class="plugin-result" data-plugin-result="${key}">Ready.</pre></section>`;
}

export async function togglePlugin(event) {
  const input = event.currentTarget;
  input.disabled = true;
  try {
    await adminJson(`/api/plugins/${encodeURIComponent(input.dataset.pluginToggle)}/toggle`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: input.checked })
    });
    await refreshWorkspace({ quiet: true });
    showToast(`Plugin ${input.checked ? "enabled" : "disabled"}`);
  } catch (error) { input.checked = !input.checked; showToast(error.message, true); }
  finally { input.disabled = false; }
}

export async function runPluginAction(event) {
  const button = event.currentTarget;
  const [panelIndex, actionIndex] = button.dataset.pluginAction.split(":").map(Number);
  const panel = state.plugins.uiPanels[panelIndex];
  const action = panel.actions[actionIndex];
  const root = button.closest(".plugin-panel");
  const values = {};
  $$('[data-field]', root).forEach((input) => { values[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value; });
  let endpoint = String(action.endpoint || "");
  const query = new URLSearchParams();
  (action.queryFields || []).forEach((field) => { if (values[field] !== "") query.set(field, values[field]); });
  if (query.size) endpoint += `${endpoint.includes("?") ? "&" : "?"}${query}`;
  const method = String(action.method || "GET").toUpperCase();
  const body = { ...(action.staticBody || {}) };
  (action.bodyFields || []).forEach((field) => { body[field] = values[field]; });
  const result = $('[data-plugin-result]', root);
  button.disabled = true; result.textContent = "Working…";
  try {
    const options = { method, headers: {} };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) { options.headers["content-type"] = "application/json"; options.body = JSON.stringify(body); }
    const response = endpoint.startsWith("/api/plugins/") ? await adminFetch(endpoint, options) : await fetch(endpoint, options);
    const text = await response.text();
    if (!response.ok) throw new Error(text || `${response.status} ${response.statusText}`);
    try { result.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch { result.textContent = text || "Done."; }
  } catch (error) { result.textContent = `Error: ${error.message}`; }
  finally { button.disabled = false; }
}

export async function installPlugin() {
  const file = $("#pluginFile")?.files?.[0];
  if (!file) return showToast("Choose a plugin package first", true);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  try {
    await adminJson("/api/plugins/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attachment: { name: file.name, type: file.type, size: file.size, contentBase64: btoa(binary) }, autoRestart: false }) });
    showToast("Plugin installed. Restart Speck to load it.");
  } catch (error) { showToast(error.message, true); }
}

export async function mountPluginTabs(tabs) {
  const hostRoot = $("#pluginTabHosts");
  if (!hostRoot || !tabs.length) return;
  const { createObserverBrowserHost } = await import("/observer-compat/browser/plugin-host.js");
  const host = createObserverBrowserHost({
    api: async (url, options = {}) => adminJson(url, options),
    adminFetch, pluginAdminFetch: adminFetch,
    refreshAll: () => refreshWorkspace({ quiet: true }),
    loadTaskQueue: () => refreshWorkspace({ quiet: true }),
    loadCronJobs: () => refreshWorkspace({ quiet: true }),
    formatTime, formatDateTime: (value) => new Date(Number(value || 0)).toLocaleString()
  });
  window.ObserverApp = { ...(window.ObserverApp || {}), ...host };
  for (const tab of tabs) {
    if (!tab?.scriptUrl || tab.enabled === false) continue;
    const section = document.createElement("section");
    section.className = "plugin-tab-host";
    section.innerHTML = `<span class="eyebrow">${escapeHtml(tab.pluginId || "plugin")}</span><h2>${escapeHtml(tab.title || tab.id)}</h2><div data-mount></div>`;
    hostRoot.appendChild(section);
    await mountPluginTab(tab, $("[data-mount]", section));
  }
}

export const pluginTabModuleCache = new Map();

export async function mountPluginTab(tab, root) {
  const { createObserverBrowserHost, mountObserverPluginTab } = await import("/observer-compat/browser/plugin-host.js");
  if (!window.ObserverApp?.api) {
    const host = createObserverBrowserHost({
      api: async (url, options = {}) => adminJson(url, options),
      adminFetch, pluginAdminFetch: adminFetch,
      refreshAll: () => refreshWorkspace({ quiet: true }),
      loadTaskQueue: () => refreshWorkspace({ quiet: true }),
      loadCronJobs: () => refreshWorkspace({ quiet: true }),
      formatTime, formatDateTime: (value) => new Date(Number(value || 0)).toLocaleString()
    });
    window.ObserverApp = { ...(window.ObserverApp || {}), ...host };
  }
  let moduleExports = pluginTabModuleCache.get(tab.scriptUrl);
  if (!moduleExports) {
    moduleExports = await import(tab.scriptUrl);
    pluginTabModuleCache.set(tab.scriptUrl, moduleExports);
  }
  await mountObserverPluginTab(moduleExports, { root, tab, host: window.ObserverApp });
}
