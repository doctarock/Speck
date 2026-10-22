// The Threads panel: the conversation's episodes as Speck has placed each
// message, and the user's corrections (moving a message to another thread).

import { state, $, $$, escapeHtml, jsonFetch, showToast } from "./core.js";

const PLACED_BY = {
  signals: "placed by meaning",
  persistence: "kept on the current subject",
  reading: "placed by a model reading",
  fallback: "placed by fallback",
  "waiting-task": "answer to Speck's question"
};

function placement(turn) {
  const placed = turn.placement;
  if (!placed) return "";
  if (placed.correctedFrom) return `<span class="thread-placement corrected">moved here by you</span>`;
  if (placed.decision === "new") return `<span class="thread-placement">started this thread</span>`;
  return `<span class="thread-placement">${escapeHtml(PLACED_BY[placed.by] || placed.by)}</span>`;
}

function title(episode) {
  const first = episode.turns.find((turn) => turn.role === "user")?.content || "Empty thread";
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

export async function renderThreadsPanel() {
  const content = $("#panelContent");
  let episodes = [];
  try {
    episodes = (await jsonFetch(`/api/conversation/episodes?sessionId=Main`))?.episodes || [];
  } catch (error) {
    content.innerHTML = `<div class="empty-state">Threads could not be loaded: ${escapeHtml(error.message)}</div>`;
    return;
  }
  state.episodes = episodes;
  const open = episodes.filter((episode) => episode.status === "open");
  content.innerHTML = episodes.length ? `<div class="thread-list">${episodes.map((episode) => `<article class="data-card thread-card${episode.active ? " active" : ""}">
      <div class="thread-head">
        <h3>${escapeHtml(title(episode))}</h3>
        <span class="status-pill">${episode.active ? "current" : episode.status === "closed" ? "closed" : escapeHtml(episode.taskStatus || "open")}</span>
      </div>
      <ol class="thread-turns">${episode.turns.map((turn, index) => `<li class="thread-turn ${turn.role}">
        <p>${escapeHtml(turn.content)}</p>
        ${turn.role === "user" ? `<div class="thread-meta">${placement(turn)}
          <select data-move-episode="${escapeHtml(episode.id)}" data-move-turn="${index}" aria-label="Move this message to another thread">
            <option value="">Move to…</option>
            ${open.filter((other) => other.id !== episode.id).map((other) => `<option value="${escapeHtml(other.id)}">${escapeHtml(title(other))}</option>`).join("")}
            <option value="new">A new thread</option>
          </select></div>` : ""}
      </li>`).join("")}</ol>
    </article>`).join("")}</div>`
    : `<div class="empty-state">No conversation yet. Speck groups your messages into threads by subject as you talk.</div>`;
  $$("[data-move-episode]").forEach((select) => select.addEventListener("change", moveMessage));
}

async function moveMessage(event) {
  const select = event.currentTarget;
  const to = select.value;
  if (!to) return;
  select.disabled = true;
  try {
    await jsonFetch("/api/conversation/move", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "Main", episodeId: select.dataset.moveEpisode, turnIndex: Number(select.dataset.moveTurn), to })
    });
    showToast("Message moved. Speck keeps the move as a correction.");
  } catch (error) {
    showToast(error.message, true);
  }
  await renderThreadsPanel();
}
