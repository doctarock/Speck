// Shared state, DOM helpers, formatting, and requests to the server.

export const state = {
  tasks: [], files: [], events: [], cron: [], plugins: null, memoryGraph: { nodes: [], edges: [], truncated: false },
  view: "world", adminToken: "", selectedFileKind: "all", selectedFilePath: "", filePreview: null, selectedTaskId: "", queueTab: "queued", queuePaused: false, taskHistories: {}, taskCognition: {},
  worldMode: localStorage.getItem("speck.worldMode") === "memory" ? "memory" : "world", selectedMemoryId: "",
  systemTab: "overview", system: null, systemLoading: false, systemError: "",
  conversation: loadConversation(), activeConversationTaskId: loadConversationTaskId(),
  voice: { supported: false, enabled: false, listening: false, capturing: false, recognition: null, finalText: "", interimText: "", restartTimer: null, submitTimer: null, lastActivityAt: 0, speaking: false, voices: [], voiceName: loadVoicePreference() }
};

export const VOICE_SILENCE_MS = 3500;

export const $ = (selector, root = document) => root.querySelector(selector);

export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[character]);

export const formatTime = (value) => {
  const date = new Date(Number(value || 0));
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
};

export const timeAgo = (value) => {
  const elapsed = Date.now() - Number(value || 0);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "now";
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
};

export const formatBytes = (value) => {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

export async function jsonFetch(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && String(url).startsWith("/api/")) {
    return adminJson(url, options);
  }
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  return payload;
}

export async function adminFetch(url, options = {}) {
  if (!state.adminToken) {
    const token = await jsonFetch("/api/admin-token");
    state.adminToken = String(token.token || "");
  }
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), "x-admin-token": state.adminToken }
  });
  if (response.status === 401 || response.status === 403) state.adminToken = "";
  return response;
}

export async function adminJson(url, options = {}) {
  const response = await adminFetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  return payload;
}

export let toastTimer;

export function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message; toast.classList.toggle("error", error); toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

export function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

export function loadConversation() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem("speck.conversation") || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((turn) => turn && ["user", "assistant"].includes(turn.role) && typeof turn.content === "string").slice(-12)
      : [];
  } catch { return []; }
}

export function loadConversationTaskId() {
  try { return String(sessionStorage.getItem("speck.conversationTaskId") || ""); }
  catch { return ""; }
}

export function loadVoicePreference() {
  try { return String(localStorage.getItem("speck.voiceName") || ""); }
  catch { return ""; }
}

// The 3D scenes, created at startup when WebGL is available.
export const scenes = { world: null, memory: null };
