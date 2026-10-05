// The workspace: refreshing state from the server, the world and memory views, and the panel shell.

import { renderThreadsPanel } from "./threads.js";
import { state, $, $$, escapeHtml, timeAgo, jsonFetch, adminJson, showToast, scenes } from "./core.js";
import { renderSystemPanel } from "./system.js";
import { renderTasksPanel, openTaskDialog } from "./tasks.js";
import { renderFilesPanel, openFilePreview } from "./files.js";
import { renderRhythmPanel } from "./rhythm.js";
import { renderPluginsPanel, renderPluginView, pluginPrimaryTabs, pluginViewId } from "./plugins.js";

export function flattenTasks(payload) {
  return ["inProgress", "waiting", "queued", "failed", "done"]
    .flatMap((key) => Array.isArray(payload?.[key]) ? payload[key] : []);
}

export async function refreshWorkspace({ quiet = false } = {}) {
  const results = await Promise.allSettled([
    jsonFetch("/api/tasks/list"),
    jsonFetch("/api/tasks/events?sinceTs=0&limit=40"),
    jsonFetch("/api/cron/list"),
    jsonFetch("/api/workspace/graph"),
    adminJson("/api/plugins/list"),
    jsonFetch("/api/memory/graph")
  ]);
  if (results[0].status === "fulfilled") {
    state.tasks = flattenTasks(results[0].value);
    state.queuePaused = results[0].value.queue?.paused === true;
  }
  if (results[1].status === "fulfilled") state.events = results[1].value.events || [];
  if (results[2].status === "fulfilled") state.cron = results[2].value.jobs || [];
  if (results[3].status === "fulfilled") state.files = results[3].value.entries || [];
  if (results[4].status === "fulfilled") state.plugins = results[4].value;
  if (results[5].status === "fulfilled") state.memoryGraph = results[5].value;
  const failures = results.filter((result) => result.status === "rejected");
  $("#connectionDot").classList.toggle("online", failures.length === 0);
  $("#worldSummary").textContent = failures.length
    ? `Workspace partially awake · ${failures.length} source${failures.length === 1 ? "" : "s"} unavailable`
    : buildSummary();
  renderBadges();
  renderWorld();
  // Workspace polling must not reconstruct configuration forms while they are
  // being edited. System data has its own explicit refresh action.
  if (["tasks", "files", "rhythm"].includes(state.view)) renderPanel(state.view);
  if (!quiet) showToast(failures.length ? failures[0].reason.message : "Workspace refreshed", failures.length > 0);
}

export function buildSummary() {
  if (state.worldMode === "memory") {
    const count = state.memoryGraph.nodes?.length || 0;
    const edges = state.memoryGraph.edges?.length || 0;
    return `${count} mapped memor${count === 1 ? "y" : "ies"} · ${edges} association${edges === 1 ? "" : "s"}${state.memoryGraph.truncated ? " · newest 240 shown" : ""}`;
  }
  const active = state.tasks.filter((task) => ["queued", "in_progress", "waiting_for_user"].includes(task.status)).length;
  const pluginCount = state.plugins?.plugins?.length || 0;
  return `${active} active thread${active === 1 ? "" : "s"} · ${state.files.length} workspace objects · ${pluginCount} plugin${pluginCount === 1 ? "" : "s"}`;
}

export function renderBadges() {
  $("#taskBadge").textContent = String(state.tasks.length);
  $("#fileBadge").textContent = String(state.files.length);
  $("#cronBadge").textContent = String(state.cron.length);
  $("#pluginBadge").textContent = String(state.plugins?.plugins?.length || 0);
  renderPluginRail();
}

// Each plugin primary tab is a view of its own in the rail.
export function renderPluginRail() {
  const tabs = pluginPrimaryTabs();
  const rail = $("#pluginRail");
  const key = tabs.map((tab) => `${pluginViewId(tab)}|${tab.title}`).join(",");
  if (!rail || rail.dataset.key === key) return;
  rail.dataset.key = key;
  rail.innerHTML = tabs.map((tab) => `<button class="rail-button ${state.view === pluginViewId(tab) ? "active" : ""}" data-view="${escapeHtml(pluginViewId(tab))}" title="${escapeHtml(tab.title)}">
    <span>${escapeHtml(String(tab.title || tab.id || "?").trim().charAt(0).toUpperCase())}</span><small>${escapeHtml(tab.title || tab.id)}</small></button>`).join("");
  $$("[data-view]", rail).forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  if (state.view.startsWith("plugin:") && !tabs.some((tab) => pluginViewId(tab) === state.view)) setView("plugins");
}

export function worldEntities() {
  const visibleTaskIds = new Set(state.tasks.map((task) => task.id).filter(Boolean));
  const tasks = state.tasks.map((task) => ({
    kind: "task", label: task.objective || task.message || "Untitled task", detail: task.status,
    taskId: task.id, taskStatus: task.status, result: task.resultSummary || "", view: "tasks", timestamp: entityTimestamp(task.updatedAt || task.createdAt)
  }));
  const actions = state.events.filter((event) => {
    const taskId = event.task?.id || event.event?.workerId || "";
    return taskId && visibleTaskIds.has(taskId);
  }).map((event) => ({
    kind: "action", label: readableEvent(event.type || event.event?.type), detail: event.task?.resultSummary || timeAgo(event.ts),
    taskId: event.task?.id || event.event?.workerId || "", taskStatus: event.task?.status || "", view: "tasks", timestamp: entityTimestamp(event.ts || event.event?.occurredAt)
  }));
  const documents = state.files.filter((file) => file.kind === "document").map((file) => ({
    kind: "document", label: file.name, detail: file.path, filePath: file.path, view: "files", timestamp: entityTimestamp(file.modifiedAt)
  }));
  const files = state.files.filter((file) => file.kind !== "document").map((file) => ({
    kind: file.kind === "code" || file.kind === "configuration" ? file.kind : "file",
    label: file.name, detail: file.path, filePath: file.path, view: "files", timestamp: entityTimestamp(file.modifiedAt)
  }));
  return [...tasks, ...actions, ...documents, ...files]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-50);
}

export function entityTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function renderWorld() {
  const entities = worldEntities();
  const field = $("#entityField");
  const positions = layoutEntities(entities.length);
  scenes.world?.setEntities(entities);
  field.innerHTML = entities.map((entity, index) => {
    const position = positions[index];
    return `<button class="world-node ${escapeHtml(entity.kind)}" data-world-index="${index}" style="left:${position.x}%;top:${position.y}%;animation-delay:${index * 35}ms">
      <span class="node-kind">${escapeHtml(entity.kind)}</span><strong>${escapeHtml(entity.label)}</strong>
    </button>`;
  }).join("");
  $$('[data-world-index]', field).forEach((button) => button.addEventListener("click", () => activateWorldEntity(entities[Number(button.dataset.worldIndex)])));

  const active = state.tasks.filter((task) => task.status === "in_progress").length;
  const waiting = state.tasks.filter((task) => task.status === "waiting_for_user").length;
  const oldest = entities[0]?.timestamp;
  const newest = entities.at(-1)?.timestamp;
  $("#timelineStatus").textContent = entities.length
    ? `Timeline · ${entities.length} of 50 items · ${new Date(oldest).toLocaleString()} → ${new Date(newest).toLocaleString()}`
    : "Timeline · 0 of 50 items";
  scenes.world?.setActivity({ active, waiting });
  $("#speckSprite").classList.toggle("busy", active > 0);
  $("#spriteState").textContent = active ? `holding ${active} active` : waiting ? `${waiting} awaiting you` : "observing";
  renderPulse();
  renderMemoryMap();
  applyWorldMode();
}

export function setWorldMode(mode) {
  state.worldMode = mode === "memory" ? "memory" : "world";
  localStorage.setItem("speck.worldMode", state.worldMode);
  renderMemoryMap();
  applyWorldMode();
  renderPulse();
  $("#worldSummary").textContent = buildSummary();
}

export function applyWorldMode() {
  const memoryMode = state.worldMode === "memory";
  $(".world-stage")?.classList.toggle("memory-mode", memoryMode);
  $("#memoryCanvas").hidden = !memoryMode;
  $("#speckSprite").hidden = memoryMode;
  $$('[data-world-mode]').forEach((button) => {
    const active = button.dataset.worldMode === state.worldMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#worldSelection").textContent = memoryMode
    ? "Memory map · select a memory to inspect it · lines show learned associations"
    : "Drag to orbit · right-drag to travel in time · scroll to zoom · select an object for its result";
  if (memoryMode) {
    const count = state.memoryGraph.nodes?.length || 0;
    $("#timelineStatus").textContent = `Memory network · ${count} node${count === 1 ? "" : "s"} · ${(state.memoryGraph.edges || []).length} edges`;
    $("#worldLegend").innerHTML = `<span><i class="legend-dot semantic"></i> semantic</span><span><i class="legend-dot episodic"></i> episodic</span><span><i class="legend-dot procedural"></i> procedural</span><span><i class="legend-dot working"></i> working</span>`;
  } else {
    $("#worldLegend").innerHTML = `<span><i class="legend-dot task"></i> tasks</span><span><i class="legend-dot action"></i> actions</span><span><i class="legend-dot document"></i> documents</span><span><i class="legend-dot file"></i> files</span>`;
  }
}

export function renderMemoryMap() {
  const nodes = Array.isArray(state.memoryGraph.nodes) ? state.memoryGraph.nodes : [];
  const edges = Array.isArray(state.memoryGraph.edges) ? state.memoryGraph.edges : [];
  if (state.selectedMemoryId && !nodes.some((node) => node.id === state.selectedMemoryId)) state.selectedMemoryId = "";
  scenes.memory?.setGraph({ nodes, edges, selectedId: state.selectedMemoryId });
  $("#memoryMapEmpty").hidden = nodes.length > 0 || state.worldMode !== "memory";
}

export function selectMemory(id) {
  state.selectedMemoryId = id || "";
  scenes.memory?.select(state.selectedMemoryId);
  renderPulse();
}

export function primaryMemoryRole(roles = []) {
  return ["semantic", "episodic", "procedural", "known-answer", "evidence", "working"].find((role) => roles.includes(role)) || "working";
}

export function activateWorldEntity(entity) {
  if (!entity) return;
  if (entity.kind === "core") {
    openTaskDialog();
    return;
  }
  if (entity.taskId) {
    const task = state.tasks.find((candidate) => candidate.id === entity.taskId);
    if (!task) {
      showToast("This activity no longer has an available task result.", true);
      return;
    }
    state.selectedTaskId = task.id;
    state.queueTab = queueTabForStatus(task.status);
    setView("tasks");
    requestAnimationFrame(revealSelectedItem);
    return;
  }
  if (entity.filePath) {
    state.selectedFilePath = entity.filePath;
    state.selectedFileKind = "all";
    setView("files");
    requestAnimationFrame(() => openFilePreview(entity.filePath));
  }
}

export function queueTabForStatus(status) {
  if (["queued", "in_progress", "waiting_for_user", "completed", "failed"].includes(status)) return status;
  return status === "closed" ? "completed" : "queued";
}

export function revealSelectedItem() {
  $(".selected-result")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function describeWorldEntity(entity) {
  const selection = $("#worldSelection");
  selection.textContent = entity
    ? `${entity.kind === "core" ? "Speck" : readableEvent(entity.kind)} · ${entity.label}${entity.detail ? ` · ${entity.detail}` : ""}`
    : "Drag to orbit · right-drag to travel in time · scroll to zoom · select an object for its result";
}

export function describeMemory(memory) {
  if (state.worldMode !== "memory") return;
  $("#worldSelection").textContent = memory
    ? `${readableEvent(primaryMemoryRole(memory.roles))} · ${memory.content} · ${memory.workerLabel}`
    : "Memory map · drag to orbit · scroll to zoom · select a memory to inspect it";
}

export function layoutEntities(count) {
  const positions = [];
  const rings = count > 9 ? [{ count: 8, rx: 29, ry: 25 }, { count: count - 8, rx: 43, ry: 38 }] : [{ count, rx: 38, ry: 34 }];
  let offset = 0;
  rings.forEach((ring, ringIndex) => {
    for (let index = 0; index < ring.count; index += 1) {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index / Math.max(1, ring.count)) + ringIndex * .22;
      positions.push({ x: 50 + Math.cos(angle) * ring.rx, y: 47 + Math.sin(angle) * ring.ry });
      offset += 1;
    }
  });
  return positions;
}

export function renderPulse() {
  if (state.worldMode === "memory") {
    renderMemoryInspector();
    return;
  }
  $(".pulse-panel .section-heading span").textContent = "Current pulse";
  const entries = state.events.slice(-8).reverse();
  $("#pulseList").innerHTML = entries.length ? entries.map((entry) => `<div class="pulse-item"><i></i><div>
    <strong>${escapeHtml(readableEvent(entry.type || entry.event?.type))}</strong>
    <small>${escapeHtml(entry.task?.objective || entry.task?.message || "workspace activity")} · ${timeAgo(entry.ts)}</small>
  </div></div>`).join("") : `<div class="empty-state">The workspace is quiet.<br>New actions will gather here.</div>`;
}

export function renderMemoryInspector() {
  $(".pulse-panel .section-heading span").textContent = "Memory inspector";
  const nodes = state.memoryGraph.nodes || [];
  const selected = nodes.find((node) => node.id === state.selectedMemoryId);
  if (!selected) {
    const counts = nodes.reduce((result, node) => {
      const role = primaryMemoryRole(node.roles);
      result[role] = (result[role] || 0) + 1;
      return result;
    }, {});
    const clusterCount = new Set(nodes.map((node) => node.workerId || "global")).size;
    $("#pulseList").innerHTML = nodes.length
      ? `<div class="memory-overview"><strong>${nodes.length} memories</strong><p>${(state.memoryGraph.edges || []).length} learned associations across ${clusterCount} cluster${clusterCount === 1 ? "" : "s"}.</p>${Object.entries(counts).map(([role, count]) => `<div><span><i class="legend-dot ${escapeHtml(role)}"></i>${escapeHtml(role)}</span><b>${count}</b></div>`).join("")}</div>`
      : `<div class="empty-state">No memories have been retained yet.<br>New semantic, episodic, and procedural memories will gather here.</div>`;
    return;
  }
  const connections = (state.memoryGraph.edges || []).filter((edge) => edge.source === selected.id || edge.target === selected.id).length;
  $("#pulseList").innerHTML = `<article class="memory-inspector-card">
    <span class="eyebrow">${escapeHtml(primaryMemoryRole(selected.roles))} · ${escapeHtml(selected.kind)}</span>
    <h3>${escapeHtml(selected.content)}</h3>
    <p>${escapeHtml(selected.workerLabel)}</p>
    <dl><div><dt>Confidence</dt><dd>${Math.round(Number(selected.confidence || 0) * 100)}%</dd></div><div><dt>Importance</dt><dd>${Math.round(Number(selected.importance || 0) * 100)}%</dd></div><div><dt>Activation</dt><dd>${Number(selected.activation || 0).toFixed(2)}</dd></div><div><dt>Connections</dt><dd>${connections}</dd></div></dl>
    <small>${escapeHtml(selected.provenance?.kind || "unknown")} / ${escapeHtml(selected.provenance?.source || "unknown")} · ${timeAgo(Date.parse(selected.lastAccessedAt))}</small>
  </article>`;
}

export function readableEvent(value = "") {
  return String(value || "activity").replace(/^speck\./, "").replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function setView(view) {
  state.view = view || "world";
  $$(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  $("#worldView").hidden = state.view !== "world";
  $("#panelView").hidden = state.view === "world";
  if (state.view !== "world") renderPanel(state.view);
}

export function renderPanel(view) {
  const definitions = {
    tasks: ["Work threads", "Task queue", "Persistent intentions moving through Speck from admission to completion."],
    threads: ["Conversation", "Threads", "Your messages grouped by subject. Move a message if Speck placed it in the wrong thread; each move is kept as an example of where Speck went wrong."],
    files: ["Workspace matter", "Files & documents", "A live map of the material Speck can see in this project."],
    rhythm: ["Recurring intentions", "Rhythm", "Scheduled work that returns to the workspace over time."],
    plugins: ["Extensions", "Plugins", "Optional capabilities attached through the Genesis plugin contract."],
    system: ["Configuration & health", "System", "Runtime status, brain configuration, capabilities, profiles, and plugin system surfaces."]
  };
  if (String(view).startsWith("plugin:")) {
    const tab = pluginPrimaryTabs().find((entry) => pluginViewId(entry) === view);
    if (tab) return renderPluginView(tab);
  }
  const [eyebrow, title, description] = definitions[view] || definitions.tasks;
  $("#panelEyebrow").textContent = eyebrow;
  $("#panelTitle").textContent = title;
  $("#panelDescription").textContent = description;
  if (view === "tasks") renderTasksPanel();
  if (view === "threads") renderThreadsPanel();
  if (view === "files") renderFilesPanel();
  if (view === "rhythm") renderRhythmPanel();
  if (view === "plugins") renderPluginsPanel();
  if (view === "system") renderSystemPanel();
}

export function initializeAmbientCanvas() {
  const canvas = $("#ambientCanvas");
  const context = canvas.getContext("2d");
  const motes = Array.from({ length: 54 }, () => ({ x: Math.random(), y: Math.random(), r: .4 + Math.random() * 1.2, speed: .00004 + Math.random() * .00008, phase: Math.random() * 6.28 }));
  const resize = () => { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; };
  addEventListener("resize", resize); resize();
  const draw = (time) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    motes.forEach((mote) => {
      const x = mote.x * canvas.width + Math.sin(time * mote.speed + mote.phase) * 16 * devicePixelRatio;
      const y = (mote.y * canvas.height + time * mote.speed * 8) % canvas.height;
      context.beginPath(); context.arc(x, y, mote.r * devicePixelRatio, 0, Math.PI * 2);
      context.fillStyle = `rgba(207,198,255,${.08 + mote.r * .08})`; context.fill();
    });
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}
