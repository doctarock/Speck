// Trimmed rewrite of two generic, Nova-agnostic functions from genesis-core's
// server/observer-general-utils.js. The rest of that file (persona-name rewriting,
// sandbox-path helpers) was left out — it carries Nova-specific assumptions. Kept as a
// standalone module because externally developed plugins import it by relative path.

export function escapeRegex(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compactText(value = "", maxLength = 500) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}
