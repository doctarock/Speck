import { normalizePluginId } from "./plugin-system-helpers.js";
import { isRetryableFsWriteError, waitForFsWriteRetry } from "./retryable-fs-write.js";

export function createPluginDataStore({ pluginDataRoot = "", fs = null, path = null } = {}) {
  function normalizePluginDataKey(key = "") {
    return String(key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
  }

  function resolvePluginDataPath(pluginId = "", key = "", extension = ".json") {
    if (!pluginDataRoot || !path) {
      return "";
    }
    const normalizedPluginId = normalizePluginId(pluginId);
    const normalizedKey = normalizePluginDataKey(key);
    if (!normalizedPluginId || !normalizedKey) {
      return "";
    }
    const normalizedExt = String(extension || ".json").startsWith(".")
      ? String(extension || ".json")
      : `.${String(extension || "json")}`;
    const withExt = normalizedKey.endsWith(normalizedExt)
      ? normalizedKey
      : `${normalizedKey}${normalizedExt}`;
    return path.join(pluginDataRoot, normalizedPluginId, withExt);
  }

  async function readPluginDataJson(pluginId = "", key = "", fallback = null) {
    const filePath = resolvePluginDataPath(pluginId, key, ".json");
    if (!filePath || !fs || typeof fs.readFile !== "function") {
      return fallback;
    }
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(String(raw || "null"));
    } catch {
      return fallback;
    }
  }

  async function writePluginDataJson(pluginId = "", key = "", value = null) {
    const filePath = resolvePluginDataPath(pluginId, key, ".json");
    if (!filePath || !fs || typeof fs.writeFile !== "function" || !path) {
      return value;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const retryDelay = (attempt) => waitForFsWriteRetry(attempt, { baseMs: 40, capMs: 1000 });
    const writeFileWithRetries = async (targetPath, targetContent) => {
      let lastWriteError = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await fs.writeFile(targetPath, targetContent, "utf8");
          return;
        } catch (error) {
          lastWriteError = error;
          if (!isRetryableFsWriteError(error) || attempt >= 5) {
            break;
          }
          await retryDelay(attempt);
        }
      }
      throw lastWriteError;
    };
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await writeFileWithRetries(tempPath, content);
        if (typeof fs.rename === "function") {
          await fs.rename(tempPath, filePath);
        } else {
          await writeFileWithRetries(filePath, content);
          if (typeof fs.rm === "function") {
            await fs.rm(tempPath, { force: true }).catch(() => {});
          }
        }
        return value;
      } catch (error) {
        lastError = error;
        if (isRetryableFsWriteError(error)) {
          try {
            await writeFileWithRetries(filePath, content);
            if (typeof fs.rm === "function") {
              await fs.rm(tempPath, { force: true }).catch(() => {});
            }
            return value;
          } catch (fallbackError) {
            lastError = fallbackError;
          }
        }
        if (typeof fs.rm === "function") {
          await fs.rm(tempPath, { force: true }).catch(() => {});
        }
        if (!isRetryableFsWriteError(lastError) || attempt >= 4) {
          break;
        }
        await retryDelay(attempt);
      }
    }
    throw lastError;
  }

  async function updatePluginDataJson(pluginId = "", key = "", updater = null, fallback = null) {
    const current = await readPluginDataJson(pluginId, key, fallback);
    const nextValue = typeof updater === "function"
      ? await updater(current)
      : current;
    await writePluginDataJson(pluginId, key, nextValue);
    return nextValue;
  }

  return {
    normalizePluginDataKey,
    resolvePluginDataPath,
    readPluginDataJson,
    writePluginDataJson,
    updatePluginDataJson
  };
}
