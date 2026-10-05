// Trimmed rewrite of one generic, Nova-agnostic function from genesis-core's
// server/observer-core-state.js (the rest of that file is Nova-specific default-state
// factories and JSON schemas that don't belong in Genesis core). Kept as a standalone
// module because externally developed plugins import it by relative path.

export function normalizeProjectsConfigForBootstrap(configured = {}) {
  const source = configured && typeof configured === "object" ? configured : {};
  const numericOrDefault = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const normalizeCreativeThroughputMode = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return ["conservative", "auto", "fast"].includes(normalized) ? normalized : "auto";
  };
  return {
    maxActiveWorkPackagesPerProject: Math.max(1, Math.min(numericOrDefault(source.maxActiveWorkPackagesPerProject, 6), 12)),
    projectWorkRetryCooldownMs: Math.max(0, numericOrDefault(source.projectWorkRetryCooldownMs, 6 * 60 * 60 * 1000)),
    projectBackupIntervalMs: Math.max(60 * 1000, numericOrDefault(source.projectBackupIntervalMs, 15 * 60 * 1000)),
    opportunityScanIdleMs: Math.max(5000, numericOrDefault(source.opportunityScanIdleMs, 60 * 1000)),
    opportunityScanIntervalMs: Math.max(10000, numericOrDefault(source.opportunityScanIntervalMs, 60 * 1000)),
    opportunityScanRetentionMs: Math.max(60 * 60 * 1000, numericOrDefault(source.opportunityScanRetentionMs, 30 * 24 * 60 * 60 * 1000)),
    opportunityScanMaxQueuedBacklog: Math.max(1, Math.min(numericOrDefault(source.opportunityScanMaxQueuedBacklog, 5), 50)),
    noChangeMinimumConcreteTargets: Math.max(1, Math.min(numericOrDefault(source.noChangeMinimumConcreteTargets, 3), 6)),
    projectWorkMaxRetries: Math.max(1, Math.min(numericOrDefault(source.projectWorkMaxRetries, 5), 50)),
    creativeThroughputMode: normalizeCreativeThroughputMode(source.creativeThroughputMode)
  };
}
