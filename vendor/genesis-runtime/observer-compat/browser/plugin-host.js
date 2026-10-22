const TRUST_LEVELS = ["unknown", "known", "trusted"];
const TRUST_RANK = new Map([
  ["unknown", 0],
  ["known", 1],
  ["trusted", 2]
]);
const TRUST_LABELS = new Map([
  ["unknown", "Unknown"],
  ["known", "Known"],
  ["trusted", "Trusted"]
]);

function normalizeTrustLevel(value, fallback = "unknown") {
  const key = String(value || "").trim().toLowerCase();
  if (TRUST_LEVELS.includes(key)) return key;
  const safeFallback = String(fallback || "").trim().toLowerCase();
  return TRUST_LEVELS.includes(safeFallback) ? safeFallback : "unknown";
}

function getTrustLevelRank(level) {
  return TRUST_RANK.get(normalizeTrustLevel(level)) ?? TRUST_RANK.get("unknown");
}

function trustLevelLabel(level) {
  const key = normalizeTrustLevel(level);
  return TRUST_LABELS.get(key) || TRUST_LABELS.get("unknown");
}

function isTrustLevelAtLeast(level, minimum) {
  return getTrustLevelRank(level) >= getTrustLevelRank(minimum);
}

function formatTimeValue(value, options = {}) {
  const date = new Date(Number(value || 0));
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString(options.locale || undefined);
}

function formatDateTimeValue(value, options = {}) {
  const date = new Date(Number(value || 0));
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(options.locale || undefined);
}

function formatDurationMsValue(value = 0) {
  const ms = Math.max(0, Number(value || 0));
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

export function createObserverBrowserHost(options = {}) {
  const missingMethods = new Set();
  const warnMissing = (name = "") => {
    if (!name || missingMethods.has(name)) return;
    missingMethods.add(name);
    if (typeof options.onMissingMethod === "function") {
      options.onMissingMethod(name);
    }
  };
  const fetcher = typeof options.fetch === "function"
    ? options.fetch
    : (...args) => globalThis.fetch(...args);
  const api = typeof options.api === "function"
    ? options.api
    : async (path, requestOptions = {}) => {
      const response = await fetcher(path, requestOptions);
      return response.json();
    };
  const adminFetch = typeof options.adminFetch === "function"
    ? options.adminFetch
    : fetcher;
  const refreshAll = typeof options.refreshAll === "function"
    ? options.refreshAll
    : async () => {};

  const host = {
    ...options.extra,
    api,
    adminFetch,
    pluginAdminFetch: typeof options.pluginAdminFetch === "function" ? options.pluginAdminFetch : adminFetch,
    refreshAll,
    refreshStatus: options.refreshStatus || refreshAll,
    loadRuntimeOptions: options.loadRuntimeOptions || refreshAll,
    loadTaskQueue: options.loadTaskQueue || refreshAll,
    loadCronJobs: options.loadCronJobs || refreshAll,
    loadSecretsCatalog: options.loadSecretsCatalog || refreshAll,
    formatTime: options.formatTime || ((value) => formatTimeValue(value, options)),
    formatDateTime: options.formatDateTime || ((value) => formatDateTimeValue(value, options)),
    formatDurationMs: options.formatDurationMs || formatDurationMsValue,
    formatEntityRef: options.formatEntityRef || ((kind, id) => `${String(kind || "entity")}:${String(id || "unknown")}`),
    normalizeTrustLevel,
    trustLevelLabel,
    isTrustLevelAtLeast,
    setStatus: options.setStatus || ((el, text = "", tone = "") => {
      if (!el) return;
      el.textContent = String(text || "");
      if (tone && el.classList) el.classList.add(String(tone));
    }),
    enqueueUpdate: options.enqueueUpdate || ((payload = {}) => {
      warnMissing("enqueueUpdate");
      return payload;
    }),
    registerTaskJobTypeHandler: options.registerTaskJobTypeHandler || ((jobType = "", handler = null) => {
      warnMissing("registerTaskJobTypeHandler");
      return { jobType, handler };
    }),
    storeSecretHandle: options.storeSecretHandle || (async () => {
      warnMissing("storeSecretHandle");
      return { ok: false, error: "storeSecretHandle unavailable" };
    }),
    clearSecretHandle: options.clearSecretHandle || (async () => {
      warnMissing("clearSecretHandle");
      return { ok: false, error: "clearSecretHandle unavailable" };
    }),
    capabilities: options.capabilities && typeof options.capabilities === "object" ? options.capabilities : {}
  };
  return host;
}

export async function mountObserverPluginTab(moduleExports = {}, { root = null, tab = {}, host = null } = {}) {
  const observerApp = host || createObserverBrowserHost();
  const pluginAdminFetch = observerApp.pluginAdminFetch || observerApp.adminFetch;
  if (typeof moduleExports?.mountPluginTab === "function") {
    return moduleExports.mountPluginTab({ tab, root, observerApp, pluginAdminFetch });
  }
  const mount = typeof moduleExports?.mount === "function"
    ? moduleExports.mount
    : typeof moduleExports?.default === "function"
      ? moduleExports.default
      : null;
  if (mount) {
    return mount(root, observerApp);
  }
  return null;
}
