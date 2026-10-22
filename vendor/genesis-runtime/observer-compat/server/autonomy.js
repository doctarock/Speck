import crypto from "node:crypto";

const STATUSES = new Set(["open", "accepted", "dismissed"]);
const MODES = new Set(["queue", "tool_call", "plugin_call", "ask"]);

export function createAutonomyCandidateId(now = Date.now()) {
  return `auto-${now}-${crypto.randomBytes(4).toString("hex")}`;
}

export function normalizeAutonomyCandidate(input = {}, defaults = {}) {
  const title = String(input.title || input.summary || "").trim();
  const description = String(input.description || input.message || input.details || "").trim();
  if (!title && !description) return null;
  const mode = MODES.has(String(input.mode || "").trim()) ? String(input.mode).trim() : "queue";
  const id = String(input.id || defaults.id || createAutonomyCandidateId(defaults.now || Date.now())).trim();
  const source = String(input.source || defaults.source || "runtime").trim() || "runtime";
  const taskPayload = input.taskPayload && typeof input.taskPayload === "object"
    ? input.taskPayload
    : {
      message: description || title,
      source,
      notes: input.notes || "Queued from an explicit autonomy candidate.",
      taskMeta: {
        autonomyCandidateId: id,
        autonomyCandidateSource: source
      }
    };
  const normalized = {
    id,
    status: STATUSES.has(String(input.status || defaults.status || "open").trim()) ? String(input.status || defaults.status || "open").trim() : "open",
    source,
    title: title || description.slice(0, 120),
    description,
    priority: Math.max(0, Math.min(1000, Math.round(Number(input.priority ?? defaults.priority ?? 100)))),
    mode,
    taskPayload,
    toolCall: input.toolCall && typeof input.toolCall === "object" ? input.toolCall : null,
    pluginCall: input.pluginCall && typeof input.pluginCall === "object" ? input.pluginCall : null,
    createdAt: Number(input.createdAt || defaults.createdAt || defaults.now || Date.now()),
    updatedAt: Number(input.updatedAt || defaults.updatedAt || defaults.now || Date.now())
  };
  if (!normalized.taskPayload.taskMeta?.autonomyCandidateId) {
    normalized.taskPayload = {
      ...normalized.taskPayload,
      taskMeta: {
        ...(normalized.taskPayload.taskMeta || {}),
        autonomyCandidateId: normalized.id,
        autonomyCandidateSource: normalized.source
      }
    };
  }
  return normalized;
}

export function normalizeAutonomyCandidateList(candidates = [], options = {}) {
  const includeClosed = options.includeClosed === true;
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : [])
    .map((entry) => normalizeAutonomyCandidate(entry, options.defaults || {}))
    .filter(Boolean)
    .filter((entry) => includeClosed || entry.status === "open")
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0) || Number(left.createdAt || 0) - Number(right.createdAt || 0));
}
