// The task queue panel and the new-task dialog.

import { state, $, $$, escapeHtml, timeAgo, jsonFetch, showToast } from "./core.js";
import { refreshWorkspace, readableEvent } from "./workspace.js";
import { setConversationThread, submitTextRequest } from "./conversation.js";

export function renderTasksPanel() {
  const content = $("#panelContent");
  const tabs = [
    ["queued", "Queued"],
    ["in_progress", "In progress"],
    ["waiting_for_user", "Waiting"],
    ["completed", "Completed"],
    ["failed", "Failed"]
  ];
  if (!tabs.some(([status]) => status === state.queueTab)) state.queueTab = "queued";
  const activeTasks = state.tasks.filter((task) => task.status === state.queueTab)
    .sort((left, right) => Number(right.id === state.selectedTaskId) - Number(left.id === state.selectedTaskId));
  content.innerHTML = `<div class="queue-controls">
      <div><strong>${state.queuePaused ? "Queue paused" : "Queue running"}</strong><div class="panel-subtle">Pausing stops new queued work from starting. Current work keeps running.</div></div>
      <div class="queue-actions"><button class="primary-button" id="panelNewTask">New intention</button>
        <button class="ghost-button" id="queuePause">${state.queuePaused ? "Restart queue" : "Pause queue"}</button>
        <button class="ghost-button" id="dispatchNext">Dispatch next</button>
        <button class="ghost-button" id="refreshQueue">Refresh queue</button></div>
    </div>
    <div class="queue-tabs" role="tablist" aria-label="Queue categories">${tabs.map(([status, label]) => {
      const count = state.tasks.filter((task) => task.status === status).length;
      return `<button class="queue-tab ${status === state.queueTab ? "active" : ""}" role="tab" aria-selected="${status === state.queueTab}" data-queue-tab="${status}">${label}<span>${count}</span></button>`;
    }).join("")}</div>
    <section class="queue-panel"><div class="queue-list">${activeTasks.map(taskCard).join("") || `<div class="queue-empty">Nothing here.</div>`}</div></section>`;
  $("#panelNewTask")?.addEventListener("click", openTaskDialog);
  $("#refreshQueue")?.addEventListener("click", () => refreshWorkspace());
  $("#queuePause")?.addEventListener("click", () => setQueuePaused(!state.queuePaused));
  $("#dispatchNext")?.addEventListener("click", dispatchNextTask);
  $$('[data-queue-tab]').forEach((button) => button.addEventListener("click", () => {
    state.selectedTaskId = "";
    state.queueTab = button.dataset.queueTab;
    renderTasksPanel();
  }));
  $$('[data-task-action]').forEach((button) => button.addEventListener("click", () => runTaskAction(button.dataset.taskAction, button.dataset.taskId)));
  $$('.queue-answer').forEach((form) => form.addEventListener("submit", answerTask));
}

export function taskCard(task) {
  const history = state.taskHistories[task.id];
  const cognition = state.taskCognition[task.id];
  const actions = (task.status === "in_progress"
    ? `<button class="ghost-button" data-task-action="abort" data-task-id="${escapeHtml(task.id)}">Abort</button>`
    : `<button class="ghost-button" data-task-action="remove" data-task-id="${escapeHtml(task.id)}">Remove</button>`)
    // A waiting task can be picked up again in the conversation, with its thread.
    + (task.status === "waiting_for_user" ? `<button class="ghost-button" data-task-action="resume" data-task-id="${escapeHtml(task.id)}">Resume</button>` : "");
  return `<article class="data-card queue-card ${task.id === state.selectedTaskId ? "selected-result" : ""}" data-task-card="${escapeHtml(task.id)}">
    <div class="queue-card-head"><span class="status-pill">${escapeHtml(task.parked ? "parked" : task.status || "unknown")}</span><div class="queue-card-actions">${actions}<button class="ghost-button" data-task-action="cognition" data-task-id="${escapeHtml(task.id)}">${cognition ? "Hide cognition" : "Cognition"}</button><button class="ghost-button" data-task-action="history" data-task-id="${escapeHtml(task.id)}">${history ? "Hide history" : "History"}</button></div></div>
    <h3>${escapeHtml(task.objective || task.message || "Untitled task")}</h3>
    <p>${escapeHtml(task.resultSummary || task.progressNote || "Held in persistent workspace memory.")}</p>
    <div class="meta"><span>${escapeHtml(task.codename || task.id)}</span><span>${timeAgo(task.updatedAt)}</span></div>
    ${task.status === "waiting_for_user" ? `<form class="queue-answer" data-task-id="${escapeHtml(task.id)}"><textarea name="answer" rows="3" placeholder="Type your answer here" required></textarea><button class="primary-button" type="submit">Send answer</button></form>` : ""}
    ${cognition ? renderTaskCognition(cognition) : ""}
    ${history ? `<div class="queue-history">${history.map((event) => `<div><strong>${escapeHtml(readableEvent(event.type || event.eventType))}</strong><small>${escapeHtml(event.reason || event.event?.data?.reason || "")}</small></div>`).join("") || "No history recorded."}</div>` : ""}
  </article>`;
}

export function renderTaskCognition(cognition) {
  const groups = [
    ["Working memory", cognition.workingMemory], ["Evidence", cognition.evidence],
    ["Beliefs", cognition.beliefs], ["Hypotheses", cognition.hypotheses],
    ["Procedures", cognition.procedures], ["Plans", cognition.plans]
  ];
  return `<div class="cognition-inspector">
    <div class="cognition-summary">${groups.map(([label, items]) => `<span><strong>${Array.isArray(items) ? items.length : 0}</strong>${escapeHtml(label)}</span>`).join("")}</div>
    ${groups.filter(([, items]) => Array.isArray(items) && items.length).map(([label, items]) => `<details><summary>${escapeHtml(label)}</summary>${items.slice(0, 20).map((item) => `<div class="cognition-item"><strong>${escapeHtml(item.kind || label)}</strong><span>${escapeHtml(item.content || item.description || JSON.stringify(item))}</span></div>`).join("")}</details>`).join("")}
    <details><summary>World state</summary><pre>${escapeHtml(JSON.stringify(cognition.worldState || {}, null, 2))}</pre></details>
  </div>`;
}

export async function setQueuePaused(paused) {
  try {
    await jsonFetch("/api/queue/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused }) });
    await refreshWorkspace({ quiet: true });
    showToast(paused ? "Queue paused" : "Queue restarted");
  } catch (error) { showToast(error.message, true); }
}

export async function dispatchNextTask() {
  try {
    const result = await jsonFetch("/api/tasks/dispatch-next", { method: "POST" });
    await refreshWorkspace({ quiet: true });
    showToast(result.message || "Queue checked");
  } catch (error) { showToast(error.message, true); }
}

export async function runTaskAction(action, taskId) {
  try {
    if (action === "history") {
      if (state.taskHistories[taskId]) delete state.taskHistories[taskId];
      else state.taskHistories[taskId] = (await jsonFetch(`/api/tasks/history?taskId=${encodeURIComponent(taskId)}`)).events || [];
      renderTasksPanel();
      return;
    }
    if (action === "resume") {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      setConversationThread(task?.conversation ?? [], taskId);
      showToast("Resumed: your next message continues this task.");
      return;
    }
    if (action === "cognition") {
      if (state.taskCognition[taskId]) delete state.taskCognition[taskId];
      else state.taskCognition[taskId] = (await jsonFetch(`/api/speck/workers/${encodeURIComponent(taskId)}/cognition`)).cognition;
      renderTasksPanel();
      return;
    }
    await jsonFetch(`/api/tasks/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId }) });
    delete state.taskHistories[taskId];
    delete state.taskCognition[taskId];
    await refreshWorkspace({ quiet: true });
    showToast(action === "abort" ? "Task aborted" : "Task removed");
  } catch (error) { showToast(error.message, true); }
}

export async function answerTask(event) {
  event.preventDefault();
  const taskId = event.currentTarget.dataset.taskId;
  const answer = String(new FormData(event.currentTarget).get("answer") || "").trim();
  try {
    await jsonFetch("/api/tasks/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId, answer }) });
    await refreshWorkspace({ quiet: true });
    showToast("Answer sent");
  } catch (error) { showToast(error.message, true); }
}

export function openTaskDialog() {
  $("#taskObjective").value = "";
  $("#taskDialog").showModal();
  setTimeout(() => $("#taskObjective").focus(), 30);
}

export async function createTask(event) {
  event.preventDefault();
  const objective = $("#taskObjective").value.trim();
  if (!objective) return;
  try {
    await submitTextRequest(objective, { source: "dialog" });
    $("#taskDialog").close();
    await refreshWorkspace({ quiet: true });
    showToast("Request received");
  } catch (error) { showToast(error.message, true); }
}
