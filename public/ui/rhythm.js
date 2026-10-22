// The Rhythm panel: scheduled messages.

import { state, $, escapeHtml, formatTime, jsonFetch, showToast } from "./core.js";
import { refreshWorkspace } from "./workspace.js";

export function renderRhythmPanel() {
  $("#panelContent").innerHTML = `<form id="cronForm" class="toolbar">
      <input name="name" placeholder="Rhythm name" required />
      <input name="every" placeholder="Every 30m, 2h, 1d…" required />
      <input name="message" placeholder="Intention to create" required />
      <button class="primary-button" type="submit">Add rhythm</button>
    </form><div class="card-grid">${state.cron.map((job) => `<article class="data-card">
      <span class="status-pill">${job.enabled ? "flowing" : "paused"}</span><h3>${escapeHtml(job.name)}</h3><p>${escapeHtml(job.message)}</p>
      <div class="meta"><span>every ${escapeHtml(job.every)}</span><span>next ${formatTime(job.nextRunAt)}</span></div>
    </article>`).join("") || `<div class="empty-state">No recurring intentions are set.</div>`}</div>`;
  $("#cronForm")?.addEventListener("submit", createCron);
}

export async function createCron(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await jsonFetch("/api/cron/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    await refreshWorkspace({ quiet: true });
    showToast("Rhythm added");
  } catch (error) { showToast(error.message, true); }
}
