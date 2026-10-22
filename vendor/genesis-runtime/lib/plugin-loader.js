import crypto from "crypto";
import { pathToFileURL } from "url";

export function createNoopPluginManager({ app = null, runtimeRoot = "", loadErrors = [] } = {}) {
  const normalizedLoadErrors = Array.isArray(loadErrors)
    ? loadErrors.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  return {
    getCapability: () => null,
    initialize: async () => {},
    listCapabilityProviders: () => [],
    listTools: () => [],
    listRegressionSuites: () => [],
    listPlugins: () => [],
    registerRoutes: async () => {
      if (!app) {
        return;
      }
      app.get("/api/plugins/list", async (_req, res) => {
        res.json({
          ok: true,
          plugins: [],
          capabilities: [],
          capabilityProviders: {},
          hooks: [],
          hookProviders: {},
          tools: [],
          failures: [],
          uiPanels: [],
          runtimeRoot,
          disabled: true,
          message: "Plugin runtime unavailable. Genesis is running without plugins.",
          loadErrors: normalizedLoadErrors
        });
      });
    },
    runInternalRegressionCase: async () => null,
    runHook: async (_name = "", payload = undefined) => payload,
    setActiveProfile: () => {},
    setRuntimeContext: () => {},
    shutdown: async () => {},
    use: () => {}
  };
}

function summarizeOptionalModuleLoadError(error, modulePath = "") {
  const reason = String(error?.message || error || "unknown error").trim() || "unknown error";
  return `failed to load ${modulePath}: ${reason}`;
}

async function loadOptionalNamedExport(modulePath = "", exportName = "") {
  try {
    const loaded = await import(modulePath);
    const candidate = loaded?.[exportName];
    if (typeof candidate !== "function") {
      throw new Error(`missing export ${exportName}`);
    }
    return { ok: true, exported: candidate };
  } catch (error) {
    return { ok: false, exported: null, error };
  }
}

function parsePluginDirectoryEnv(value = "", pathModule) {
  return String(value || "")
    .split(pathModule.delimiter)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((entry) => pathModule.resolve(entry));
}

function pluginDirectoryCandidates({ pathModule, pluginRuntimeRoot, rootDir, pluginDirectories = [] }) {
  const defaultDir = pathModule.join(rootDir, "plugins");
  const runtimeDir = pathModule.join(pluginRuntimeRoot, "modules");
  const envDirs = parsePluginDirectoryEnv(process.env.GENESIS_PLUGIN_DIR || "", pathModule);
  const unique = new Set();
  const ordered = [];
  for (const candidate of [defaultDir, runtimeDir, ...envDirs, ...(Array.isArray(pluginDirectories) ? pluginDirectories : [])]) {
    const normalized = String(candidate || "").trim();
    if (!normalized || unique.has(normalized)) {
      continue;
    }
    unique.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function normalizePluginImportPolicyMode(value = "", fallback = "allowlist") {
  return String(value || "").trim().toLowerCase() === "permissive"
    ? "permissive"
    : fallback;
}

async function loadPluginImportTrustPolicy({ fs, pathModule, pluginRuntimeRoot, modeOverride = "" }) {
  const policyPath = pathModule.join(pluginRuntimeRoot, "plugin-trust.json");
  let mode = normalizePluginImportPolicyMode(process.env.GENESIS_EXTERNAL_PLUGIN_IMPORT_MODE || "", "allowlist");
  let allowlist = {};
  try {
    const raw = await fs.readFile(policyPath, "utf8");
    const parsed = JSON.parse(raw);
    mode = normalizePluginImportPolicyMode(parsed?.mode || mode, mode);
    allowlist = parsed?.allowlist && typeof parsed.allowlist === "object"
      ? parsed.allowlist
      : {};
  } catch {
    // Default external plugin imports to allowlist mode when no trust file exists.
  }
  if (String(modeOverride || "").trim()) {
    mode = normalizePluginImportPolicyMode(modeOverride, mode);
  }
  return {
    mode,
    allowlist
  };
}

function isPathWithinDirectory(candidatePath = "", directoryPath = "", pathModule) {
  const candidate = String(candidatePath || "").trim();
  const directory = String(directoryPath || "").trim();
  if (!candidate || !directory) {
    return false;
  }
  const resolvedCandidate = pathModule.resolve(candidate);
  const resolvedDirectory = pathModule.resolve(directory);
  const relative = pathModule.relative(resolvedDirectory, resolvedCandidate);
  return !relative || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
}

async function readPluginModuleHash(modulePath = "", { fs, pathModule }) {
  const absoluteModulePath = pathModule.resolve(String(modulePath || "").trim());
  try {
    const fileContents = await fs.readFile(absoluteModulePath);
    return {
      ok: true,
      modulePath: absoluteModulePath,
      moduleHash: crypto.createHash("sha256").update(fileContents).digest("hex"),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      modulePath: absoluteModulePath,
      moduleHash: "",
      error
    };
  }
}

function inferPluginTrustPolicyKeys(modulePath = "", pathModule) {
  const baseName = String(pathModule.basename(String(modulePath || "").trim()) || "")
    .replace(/-plugin\.(?:m?js|cjs)$/i, "")
    .trim()
    .toLowerCase();
  const slug = baseName.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [...new Set([baseName, slug].filter(Boolean))];
}

function pluginHashAllowedByImportPolicy({ modulePath = "", moduleHash = "", trustPolicy = {}, pathModule }) {
  if (String(trustPolicy?.mode || "").trim().toLowerCase() !== "allowlist") {
    return true;
  }
  const normalizedHash = String(moduleHash || "").trim().toLowerCase();
  if (!normalizedHash) {
    return false;
  }
  for (const key of inferPluginTrustPolicyKeys(modulePath, pathModule)) {
    const rule = trustPolicy?.allowlist?.[key];
    if (!rule) {
      continue;
    }
    if (Array.isArray(rule?.hashes)) {
      const hashes = rule.hashes.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
      if (hashes.includes(normalizedHash)) {
        return true;
      }
      continue;
    }
    if (typeof rule === "string" && String(rule).trim().toLowerCase() === normalizedHash) {
      return true;
    }
  }
  return false;
}

async function discoverPluginModulePaths({ directories = [], skipFiles = new Set(), fs, pathModule }) {
  const discovered = [];
  const seen = new Set();
  const visitedDirs = new Set();
  const queuedDirs = [];
  for (const directory of Array.isArray(directories) ? directories : []) {
    const normalized = String(directory || "").trim();
    if (!normalized) {
      continue;
    }
    const absolute = pathModule.resolve(normalized);
    if (visitedDirs.has(absolute)) {
      continue;
    }
    visitedDirs.add(absolute);
    queuedDirs.push(absolute);
  }
  while (queuedDirs.length) {
    const directory = queuedDirs.shift();
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry?.isDirectory?.()) {
          const childDirectory = pathModule.join(directory, String(entry.name || "").trim());
          if (!visitedDirs.has(childDirectory)) {
            visitedDirs.add(childDirectory);
            queuedDirs.push(childDirectory);
          }
          continue;
        }
        if (!entry?.isFile?.()) {
          continue;
        }
        const fileName = String(entry.name || "").trim();
        if (!/-plugin\.(?:m?js|cjs)$/i.test(fileName) || skipFiles.has(fileName)) {
          continue;
        }
        const absolutePath = pathModule.join(directory, fileName);
        if (!seen.has(absolutePath)) {
          seen.add(absolutePath);
          discovered.push(absolutePath);
        }
      }
    } catch {
      // Ignore unreadable plugin directories.
    }
  }
  return discovered.sort((left, right) => left.localeCompare(right));
}

async function loadOptionalPluginFactory(modulePath = "", preferredExportName = "", { fs, pathModule }) {
  const normalizedModulePath = String(modulePath || "").trim();
  if (!normalizedModulePath) {
    return {
      ok: false,
      factory: null,
      exportName: "",
      modulePath: "",
      moduleHash: "",
      error: new Error("module path is required")
    };
  }
  const modulePathIsUrl = /^(?:[a-z]+:)?\/\//i.test(normalizedModulePath);
  const absoluteModulePath = modulePathIsUrl ? normalizedModulePath : pathModule.resolve(normalizedModulePath);
  try {
    const importUrl = modulePathIsUrl ? normalizedModulePath : pathToFileURL(absoluteModulePath).href;
    const [loaded, fileContents] = await Promise.all([
      import(importUrl),
      modulePathIsUrl ? Promise.resolve(null) : fs.readFile(absoluteModulePath).catch(() => null)
    ]);
    const moduleHash = fileContents ? crypto.createHash("sha256").update(fileContents).digest("hex") : "";
    if (preferredExportName && typeof loaded?.[preferredExportName] === "function") {
      return { ok: true, factory: loaded[preferredExportName], exportName: preferredExportName, modulePath: absoluteModulePath, moduleHash, error: null };
    }
    if (typeof loaded?.default === "function") {
      return { ok: true, factory: loaded.default, exportName: "default", modulePath: absoluteModulePath, moduleHash, error: null };
    }
    const candidates = Object.entries(loaded || {}).filter(([name, value]) => typeof value === "function" && (/^create.*plugin$/i.test(name) || /plugin/i.test(name)));
    if (candidates.length === 1) {
      const [name, value] = candidates[0];
      return { ok: true, factory: value, exportName: name, modulePath: absoluteModulePath, moduleHash, error: null };
    }
    if (candidates.length > 1) {
      throw new Error(`multiple plugin exports found (${candidates.map(([name]) => name).join(", ")})`);
    }
    throw new Error("no plugin factory export found");
  } catch (error) {
    return { ok: false, factory: null, exportName: "", modulePath: absoluteModulePath, moduleHash: "", error };
  }
}

export async function initializePluginManager(options = {}) {
  const {
    app,
    broadcast,
    fs,
    getAppConfig,
    pathModule,
    profile = null,
    pluginDirectories = [],
    hostCapabilities = {},
    externalPluginImportMode = "",
    pluginRuntimeRoot,
    rootDir,
    runtimeContext,
    validateAdminRequest
  } = options;

  const pluginLoadErrors = [];
  const pluginsDisabledByEnv = /^(1|true|yes|on)$/i.test(String(process.env.GENESIS_DISABLE_PLUGINS || "").trim());
  let pluginManager = null;

  if (pluginsDisabledByEnv) {
    const message = "plugins disabled via GENESIS_DISABLE_PLUGINS.";
    pluginLoadErrors.push(message);
    console.warn(`[genesis] ${message}`);
    pluginManager = createNoopPluginManager({ app, runtimeRoot: pluginRuntimeRoot, loadErrors: pluginLoadErrors });
  } else {
    const pluginManagerFactoryLoad = await loadOptionalNamedExport("./plugin-system.js", "createGenesisPluginManager");
    if (pluginManagerFactoryLoad.ok) {
      pluginManager = pluginManagerFactoryLoad.exported({
        app,
        broadcast,
        getAppConfig,
        runtimeRoot: pluginRuntimeRoot,
        fs,
        path: pathModule,
        profile,
        hostCapabilities,
        runtimeContext,
        validateAdminRequest
      });
    } else {
      const message = summarizeOptionalModuleLoadError(pluginManagerFactoryLoad.error, "./plugin-system.js");
      pluginLoadErrors.push(message);
      console.warn(`[genesis] ${message}`);
      pluginManager = createNoopPluginManager({ app, runtimeRoot: pluginRuntimeRoot, loadErrors: pluginLoadErrors });
    }
  }

  // Genesis core ships with zero built-in plugins (see Architectural Rule: boots with
  // zero optional plugins installed). Applications wire their own behaviour in via
  // plugins/ discovery or GENESIS_PLUGIN_DIR, not by adding entries here.
  const builtInPluginSpecs = [];

  const builtInPluginFileNames = new Set(
    builtInPluginSpecs.map((spec) => String(spec.fileName || pathModule.basename(spec.modulePath || "")).trim()).filter(Boolean)
  );

  if (!pluginsDisabledByEnv) {
    const builtInLoadResults = await Promise.all(
      builtInPluginSpecs.map((spec) =>
        loadOptionalPluginFactory(spec.modulePath, spec.exportName, { fs, pathModule }).then((loaded) => ({ loaded, spec }))
      )
    );
    for (const { loaded, spec: pluginSpec } of builtInLoadResults) {
      if (!loaded.ok) {
        const message = summarizeOptionalModuleLoadError(loaded.error, pluginSpec.modulePath);
        pluginLoadErrors.push(message);
        console.warn(`[genesis] plugin ${pluginSpec.id} unavailable: ${message}`);
        continue;
      }
      pluginManager.use(() =>
        Promise.resolve(loaded.factory(pluginSpec.factoryArgs)).then((plugin) => {
          if (plugin && typeof plugin === "object") {
            plugin.__modulePath = String(loaded.modulePath || pluginSpec.modulePath || "").trim();
            plugin.__moduleHash = String(loaded.moduleHash || "").trim().toLowerCase();
          }
          return plugin;
        })
      );
    }
  }

  if (!pluginsDisabledByEnv) {
    const importTrustPolicy = await loadPluginImportTrustPolicy({
      fs, pathModule, pluginRuntimeRoot, modeOverride: externalPluginImportMode
    });
    const repoPluginDirectory = pathModule.join(rootDir, "plugins");
    const discoveredPluginModulePaths = await discoverPluginModulePaths({
      directories: pluginDirectoryCandidates({ pathModule, pluginRuntimeRoot, rootDir, pluginDirectories }),
      skipFiles: builtInPluginFileNames,
      fs,
      pathModule
    });
    const discoveredLoadResults = await Promise.all(
      discoveredPluginModulePaths.map(async (modulePath) => {
        const isRepoPlugin = isPathWithinDirectory(modulePath, repoPluginDirectory, pathModule);
        if (!isRepoPlugin) {
          const hashed = await readPluginModuleHash(modulePath, { fs, pathModule });
          if (!hashed.ok) {
            return { loaded: { ok: false, error: hashed.error }, modulePath };
          }
          if (!pluginHashAllowedByImportPolicy({
            modulePath,
            moduleHash: hashed.moduleHash,
            trustPolicy: importTrustPolicy,
            pathModule
          })) {
            return {
              loaded: {
                ok: false,
                error: new Error(`external plugin hash is not trusted for import (${hashed.moduleHash})`)
              },
              modulePath
            };
          }
        }
        const loaded = await loadOptionalPluginFactory(modulePath, "", { fs, pathModule });
        return { loaded, modulePath };
      })
    );
    for (const { loaded, modulePath: discoveredModulePath } of discoveredLoadResults) {
      if (!loaded.ok) {
        const message = summarizeOptionalModuleLoadError(loaded.error, discoveredModulePath);
        pluginLoadErrors.push(message);
        console.warn(`[genesis] discovered plugin unavailable: ${message}`);
        continue;
      }
      pluginManager.use(() =>
        Promise.resolve(loaded.factory({})).then((plugin) => {
          if (plugin && typeof plugin === "object") {
            plugin.__modulePath = String(loaded.modulePath || discoveredModulePath || "").trim();
            plugin.__moduleHash = String(loaded.moduleHash || "").trim().toLowerCase();
          }
          return plugin;
        })
      );
    }
  }

  try {
    await pluginManager.initialize();
  } catch (error) {
    const message = `plugin initialization failed: ${String(error?.message || error || "unknown error")}`;
    pluginLoadErrors.push(message);
    console.warn(`[genesis] ${message}`);
    pluginManager = createNoopPluginManager({ app, runtimeRoot: pluginRuntimeRoot, loadErrors: pluginLoadErrors });
  }

  return { pluginLoadErrors, pluginManager };
}
