import path from "node:path";

const REQUIRED_PROFILE_FIELDS = [
  "id",
  "name",
  "description",
  "enabledPlugins",
  "disabledPlugins",
  "defaultProvider",
  "systemPromptAddons",
  "ui",
  "runtime"
];

let activeProfile = null;
let activeProfileSelection = {
  requestedProfileId: "default",
  selectedProfileId: "default",
  source: "default",
  pendingProfileId: ""
};

function normalizeId(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
}

function normalizeStringList(value = []) {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))]
    : [];
}

function mergeStringLists(base = [], overlay = []) {
  return [...new Set([...normalizeStringList(base), ...normalizeStringList(overlay)])];
}

function deepMergeProfile(base = {}, overlay = {}) {
  const merged = {
    ...base,
    ...overlay,
    enabledPlugins: mergeStringLists(base.enabledPlugins, overlay.enabledPlugins),
    disabledPlugins: mergeStringLists(base.disabledPlugins, overlay.disabledPlugins),
    forceEnabledPlugins: mergeStringLists(base.forceEnabledPlugins, overlay.forceEnabledPlugins),
    hiddenPlugins: mergeStringLists(base.hiddenPlugins, overlay.hiddenPlugins),
    systemPromptAddons: mergeStringLists(base.systemPromptAddons, overlay.systemPromptAddons),
    tools: {
      ...(base.tools && typeof base.tools === "object" ? base.tools : {}),
      ...(overlay.tools && typeof overlay.tools === "object" ? overlay.tools : {}),
      allow: mergeStringLists(base.tools?.allow, overlay.tools?.allow),
      deny: mergeStringLists(base.tools?.deny, overlay.tools?.deny)
    },
    ui: {
      ...(base.ui && typeof base.ui === "object" ? base.ui : {}),
      ...(overlay.ui && typeof overlay.ui === "object" ? overlay.ui : {}),
      hiddenTabs: mergeStringLists(base.ui?.hiddenTabs, overlay.ui?.hiddenTabs)
    },
    runtime: {
      ...(base.runtime && typeof base.runtime === "object" ? base.runtime : {}),
      ...(overlay.runtime && typeof overlay.runtime === "object" ? overlay.runtime : {})
    }
  };
  return normalizeProfile(merged);
}

function normalizeProfile(profile = {}) {
  const normalized = {
    ...profile,
    id: normalizeId(profile.id || "default") || "default",
    name: String(profile.name || profile.id || "Default Profile").trim(),
    description: String(profile.description || "").trim(),
    enabledPlugins: normalizeStringList(profile.enabledPlugins).map(normalizeId).filter(Boolean),
    disabledPlugins: normalizeStringList(profile.disabledPlugins).map(normalizeId).filter(Boolean),
    forceEnabledPlugins: normalizeStringList(profile.forceEnabledPlugins).map(normalizeId).filter(Boolean),
    hiddenPlugins: normalizeStringList(profile.hiddenPlugins).map(normalizeId).filter(Boolean),
    defaultProvider: String(profile.defaultProvider || "").trim(),
    systemPromptAddons: normalizeStringList(profile.systemPromptAddons),
    tools: {
      allow: normalizeStringList(profile.tools?.allow),
      deny: normalizeStringList(profile.tools?.deny)
    },
    ui: {
      title: String(profile.ui?.title || profile.name || "Genesis").trim(),
      hiddenTabs: normalizeStringList(profile.ui?.hiddenTabs).map(normalizeId).filter(Boolean),
      defaultTab: normalizeId(profile.ui?.defaultTab || "queue") || "queue"
    },
    runtime: {
      ...(profile.runtime && typeof profile.runtime === "object" ? profile.runtime : {}),
      allowGeneralAssistant: profile.runtime?.allowGeneralAssistant !== false
    }
  };
  return normalized;
}

function validateProfile(profile = {}) {
  const missing = REQUIRED_PROFILE_FIELDS.filter((field) => !(field in profile));
  if (missing.length) {
    throw new Error(`profile ${profile.id || "unknown"} is missing required field(s): ${missing.join(", ")}`);
  }
  if (!profile.ui || typeof profile.ui !== "object") {
    throw new Error(`profile ${profile.id || "unknown"} has invalid ui config`);
  }
  if (!profile.runtime || typeof profile.runtime !== "object") {
    throw new Error(`profile ${profile.id || "unknown"} has invalid runtime config`);
  }
  return normalizeProfile(profile);
}

const NO_PROFILE_FALLBACK = Symbol("NO_PROFILE_FALLBACK");

async function readProfileJson(fs, filePath, fallback = NO_PROFILE_FALLBACK) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(String(raw || "{}"));
  } catch (error) {
    if (fallback !== NO_PROFILE_FALLBACK) {
      return fallback;
    }
    throw error;
  }
}

async function readProfileSelection(fs, preferencePath = "") {
  if (!preferencePath) {
    return "";
  }
  try {
    const raw = await fs.readFile(preferencePath, "utf8");
    const parsed = JSON.parse(String(raw || "{}"));
    return normalizeId(parsed?.profileId || parsed?.selectedProfileId || "");
  } catch {
    return "";
  }
}

export async function saveProfileSelection({
  fs,
  preferencePath = "",
  profileId = ""
} = {}) {
  if (!fs || typeof fs.writeFile !== "function") {
    throw new Error("profile selection requires fs.writeFile");
  }
  const selectedProfileId = normalizeId(profileId);
  if (!selectedProfileId) {
    throw new Error("profileId is required");
  }
  const payload = {
    profileId: selectedProfileId,
    updatedAt: Date.now()
  };
  if (typeof fs.mkdir === "function" && preferencePath) {
    await fs.mkdir(path.dirname(preferencePath), { recursive: true });
  }
  await fs.writeFile(preferencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  activeProfileSelection = {
    ...activeProfileSelection,
    pendingProfileId: selectedProfileId
  };
  return payload;
}

export async function loadActiveProfile({
  fs,
  rootDir = process.cwd(),
  preferencePath = "",
  env = process.env,
  logger = console
} = {}) {
  if (!fs || typeof fs.readFile !== "function") {
    throw new Error("profile manager requires fs.readFile");
  }
  const profilesRoot = path.join(rootDir, "profiles");
  const defaultPath = path.join(profilesRoot, "default.json");
  const defaultProfile = validateProfile(await readProfileJson(fs, defaultPath));
  const envProfileId = normalizeId(env?.GENESIS_PROFILE || "");
  const savedProfileId = envProfileId ? "" : await readProfileSelection(fs, preferencePath);
  const requestedProfileId = envProfileId || savedProfileId || normalizeId(defaultProfile.id || "default") || "default";
  const selectionSource = envProfileId ? "env" : savedProfileId ? "preference" : "default";
  let selectedProfile = null;
  if (requestedProfileId && requestedProfileId !== "default") {
    const selectedPath = path.join(profilesRoot, `${requestedProfileId}.json`);
    selectedProfile = await readProfileJson(fs, selectedPath, null);
    if (!selectedProfile && logger && typeof logger.warn === "function") {
      logger.warn(`[genesis] profile ${requestedProfileId} not found; using default profile.`);
    }
  }
  activeProfile = selectedProfile
    ? deepMergeProfile(defaultProfile, validateProfile(selectedProfile))
    : defaultProfile;
  activeProfileSelection = {
    requestedProfileId,
    selectedProfileId: activeProfile.id,
    source: selectedProfile ? selectionSource : "default",
    pendingProfileId: ""
  };
  return activeProfile;
}

export async function listAvailableProfiles({
  fs,
  rootDir = process.cwd()
} = {}) {
  if (!fs || typeof fs.readdir !== "function") {
    throw new Error("profile listing requires fs.readdir");
  }
  const profilesRoot = path.join(rootDir, "profiles");
  const entries = await fs.readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries) {
    if (!entry?.isFile?.() || !/\.json$/i.test(String(entry.name || ""))) {
      continue;
    }
    const filePath = path.join(profilesRoot, entry.name);
    try {
      const profile = validateProfile(await readProfileJson(fs, filePath));
      profiles.push(buildPublicProfile(profile));
    } catch {
      // Ignore malformed profiles in the selector; startup validation will still fail when selected.
    }
  }
  return profiles.sort((left, right) => {
    if (left.id === "default") return -1;
    if (right.id === "default") return 1;
    return String(left.name || left.id).localeCompare(String(right.name || right.id));
  });
}

export function setActiveProfile(profile = {}) {
  activeProfile = normalizeProfile(profile);
  return activeProfile;
}

export function getActiveProfile() {
  return activeProfile || normalizeProfile({ id: "default", name: "Default Profile", ui: {}, runtime: {} });
}

export function getProfileValue(pathExpression = "", fallback = undefined) {
  const parts = String(pathExpression || "").split(".").map((part) => part.trim()).filter(Boolean);
  let current = getActiveProfile();
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return fallback;
    }
    current = current[part];
  }
  return current == null ? fallback : current;
}

export function wildcardMatch(pattern = "", value = "") {
  const normalizedPattern = String(pattern || "").trim();
  const normalizedValue = String(value || "").trim();
  if (!normalizedPattern || !normalizedValue) {
    return false;
  }
  if (normalizedPattern === "*") {
    return true;
  }
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(normalizedValue);
}

export function profileAllowsTool(profile = getActiveProfile(), toolName = "") {
  const name = String(toolName || "").trim();
  if (!name) {
    return false;
  }
  const allow = normalizeStringList(profile.tools?.allow);
  const deny = normalizeStringList(profile.tools?.deny);
  if (allow.length && !allow.some((pattern) => wildcardMatch(pattern, name))) {
    return false;
  }
  if (deny.some((pattern) => wildcardMatch(pattern, name))) {
    return false;
  }
  return true;
}

export function filterToolsByProfile(tools = [], profile = getActiveProfile()) {
  return (Array.isArray(tools) ? tools : []).filter((tool) => profileAllowsTool(profile, tool?.name || ""));
}

export function resolveProfilePluginState(profile = getActiveProfile(), pluginId = "", manualEnabled = undefined) {
  const id = normalizeId(pluginId);
  if (!id) {
    return { enabled: false, source: "invalid" };
  }
  const forceEnabled = new Set(normalizeStringList(profile.forceEnabledPlugins).map(normalizeId));
  const disabled = new Set(normalizeStringList(profile.disabledPlugins).map(normalizeId));
  const enabled = new Set(normalizeStringList(profile.enabledPlugins).map(normalizeId));
  if (forceEnabled.has(id)) {
    return { enabled: true, source: "profile-force-enabled" };
  }
  if (disabled.has(id)) {
    return { enabled: false, source: "profile-disabled" };
  }
  if (manualEnabled === false) {
    return { enabled: false, source: "manual-disabled" };
  }
  if (enabled.has(id)) {
    return { enabled: true, source: "profile-enabled" };
  }
  return { enabled: manualEnabled !== false, source: manualEnabled === true ? "manual-enabled" : "default" };
}

export function isPluginEnabledByProfile(pluginId = "", manualEnabled = undefined) {
  return resolveProfilePluginState(getActiveProfile(), pluginId, manualEnabled).enabled === true;
}

export function isPluginHiddenByProfile(profile = getActiveProfile(), pluginId = "") {
  const id = normalizeId(pluginId);
  return Boolean(id && normalizeStringList(profile.hiddenPlugins).map(normalizeId).includes(id));
}

export function buildPublicProfile(profile = getActiveProfile()) {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    defaultProvider: profile.defaultProvider,
    ui: profile.ui,
    runtime: profile.runtime,
    tools: profile.tools,
    enabledPlugins: profile.enabledPlugins,
    disabledPlugins: profile.disabledPlugins,
    forceEnabledPlugins: profile.forceEnabledPlugins,
    hiddenPlugins: profile.hiddenPlugins
  };
}

export function getActiveProfileSelection() {
  return { ...activeProfileSelection };
}

export const profileManagerInternals = {
  deepMergeProfile,
  normalizeProfile,
  validateProfile
};
