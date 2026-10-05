// The System panel: overview, models, memory, cognition, tools, web, secrets, voice and profiles.

import { state, $, $$, escapeHtml, jsonFetch, adminJson, showToast, formatDuration } from "./core.js";
import { mountPluginTab } from "./plugins.js";
import { bindVoiceConfiguration } from "./voice.js";

export async function loadSystemPanel() {
  if (state.systemLoading) return;
  state.systemLoading = true;
  try {
    const [runtime, brains, tools, profiles, cognition, sharedMemory, memoryAdmission, browser, secrets] = await Promise.all([
      jsonFetch("/api/runtime/status"),
      jsonFetch("/api/brains/config"),
      jsonFetch("/api/tools/config"),
      jsonFetch("/api/profile/options"),
      jsonFetch("/api/speck/status"),
      jsonFetch("/api/speck/shared-memory"),
      jsonFetch("/api/memory/admission"),
      jsonFetch("/api/browser/config"),
      jsonFetch("/api/secrets")
    ]);
    state.system = { runtime, brains, tools, profiles, cognition, sharedMemory, memoryAdmission, browser, secrets };
    state.systemError = "";
  } catch (error) {
    state.systemError = error.message;
    showToast(error.message, true);
  } finally {
    state.systemLoading = false;
    if (state.view === "system") renderSystemPanel();
  }
}

export function renderSystemPanel() {
  const content = $("#panelContent");
  if (state.systemError && !state.systemLoading) {
    content.innerHTML = `<div class="empty-state">System configuration is unavailable.<br>${escapeHtml(state.systemError)}<br><br><button id="retrySystem" class="ghost-button">Try again</button></div>`;
    $("#retrySystem")?.addEventListener("click", () => { state.systemError = ""; renderSystemPanel(); });
    return;
  }
  if (!state.system) {
    content.innerHTML = `<div class="empty-state">Loading system configuration…</div>`;
    loadSystemPanel();
    return;
  }
  const pluginTabs = Array.isArray(state.plugins?.uiSystemTabs)
    ? state.plugins.uiSystemTabs.filter((tab) => tab?.enabled !== false)
    : [];
  const tabs = [
    ["overview", "Overview"], ["brains", "Brains"], ["memory", "Memory"], ["cognition", "Cognition"], ["tools", "Capabilities"], ["web", "Web"], ["secrets", "Secrets"], ["voice", "Voice"], ["profiles", "Profiles"],
    ...pluginTabs.map((tab, index) => [`plugin:${index}`, tab.title || tab.id || "Plugin"])
  ];
  if (!tabs.some(([id]) => id === state.systemTab)) state.systemTab = "overview";
  content.innerHTML = `<div class="system-tabs" role="tablist" aria-label="System sections">${tabs.map(([id, label]) =>
    `<button class="queue-tab ${state.systemTab === id ? "active" : ""}" role="tab" aria-selected="${state.systemTab === id}" data-system-tab="${escapeHtml(id)}">${escapeHtml(label)}</button>`
  ).join("")}</div><section id="systemPanelBody" class="system-panel-body"></section>`;
  $$('[data-system-tab]').forEach((button) => button.addEventListener("click", () => {
    state.systemTab = button.dataset.systemTab;
    renderSystemPanel();
  }));
  if (state.systemTab === "overview") renderSystemOverview();
  if (state.systemTab === "brains") renderBrainConfiguration();
  if (state.systemTab === "memory") renderSharedMemory();
  if (state.systemTab === "cognition") renderCognitionConfiguration();
  if (state.systemTab === "tools") renderToolConfiguration();
  if (state.systemTab === "web") renderWebConfiguration();
  if (state.systemTab === "secrets") renderSecretConfiguration();
  if (state.systemTab === "voice") renderVoiceConfiguration();
  if (state.systemTab === "profiles") renderProfileConfiguration();
  if (state.systemTab.startsWith("plugin:")) {
    renderSystemPluginTab(pluginTabs[Number(state.systemTab.split(":")[1])]);
  }
}

export function renderSystemOverview() {
  const runtime = state.system.runtime || {};
  const brains = Array.isArray(runtime.brains) ? runtime.brains : [];
  const cards = [
    ["Gateway", runtime.gateway?.status || (runtime.gateway?.running ? "running" : "unavailable"), runtime.gateway?.name || "Speck"],
    ["Runtime", runtime.coreVersion || "unknown", runtime.implementation || "speck"],
    ["Uptime", formatDuration(runtime.uptimeMs), `Node ${runtime.nodeVersion || "unknown"}`],
    ["Processors", String(brains.length), `${brains.filter((brain) => brain.running !== false).length} available`],
    ["Profile", runtime.profile?.name || runtime.profile?.id || "unknown", runtime.profile?.id || ""]
  ];
  $("#systemPanelBody").innerHTML = `<div class="system-metrics">${cards.map(([label, value, detail]) => `<article class="data-card system-metric">
    <span class="eyebrow">${escapeHtml(label)}</span><h3>${escapeHtml(value)}</h3><p>${escapeHtml(detail)}</p></article>`).join("")}</div>
    <div class="system-section-head"><div><h2>Processor activity</h2><p>Live model processors reported by the Speck runtime.</p></div><button id="refreshSystem" class="ghost-button">Refresh</button></div>
    <div class="card-grid">${brains.map(brainSummaryCard).join("") || `<div class="empty-state">No model processors are configured.</div>`}</div>`;
  $("#refreshSystem")?.addEventListener("click", () => { state.system = null; state.systemError = ""; renderSystemPanel(); });
}

export function renderVoiceConfiguration() {
  const available = "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function";
  $("#systemPanelBody").innerHTML = `<div class="system-section-head"><div><h2>Voice output</h2><p>Choose the browser voice Speck uses for spoken responses. Natural and locale-matched voices are listed first.</p></div></div>
    <section class="role-assignments voice-settings-card">
      <label class="wide">Speck's voice<select id="voiceSelect" aria-label="Choose Speck's speaking voice"><option>${available ? "Loading voices…" : "Speech output unavailable"}</option></select></label>
      <div class="wide system-save-row"><span>Speech rate 0.96 · pitch 1.02 · browser locale ${escapeHtml(navigator.language || "unknown")}</span><button id="voicePreviewButton" class="primary-button" type="button" ${available ? "" : "disabled"}>Preview voice</button></div>
    </section>
    <div class="system-notice">Voice availability and quality are provided by your browser and operating system. Installing a natural system voice may add it to this list.</div>`;
  bindVoiceConfiguration();
}

export function brainSummaryCard(brain) {
  const activity = (state.system.runtime.brainActivity || []).find((entry) => entry.id === brain.id) || {};
  return `<article class="data-card"><span class="status-pill">${activity.endpointHealthy === false ? "unavailable" : "ready"}</span>
    <h3>${escapeHtml(brain.label || brain.id)}</h3><p>${escapeHtml(brain.provider || "provider")} · ${escapeHtml(brain.model || "model not reported")}</p>
    <div class="meta"><span>${escapeHtml(brain.specialty || "general")}</span><span>${Number(activity.avgRequestSampleCount || 0)} calls</span></div></article>`;
}

export function renderCognitionConfiguration() {
  const cognition = state.system.cognition || {};
  const features = [
    ["Memory activation", cognition.memoryActivation], ["Context engine", cognition.contextEngine],
    ["Predictive loop", cognition.predictiveLoop], ["Belief revision", cognition.beliefRevision],
    ["Metacognition", cognition.metacognition], ["Model escalation", cognition.modelEscalation],
    ["Procedures", cognition.procedures], ["Coordination", cognition.coordination],
    ["Background cognition", cognition.backgroundCognition]
  ];
  const telemetry = cognition.telemetry || {};
  const metricEntries = Object.entries(telemetry.counters || telemetry).filter(([, value]) => typeof value === "number").sort(([a], [b]) => a.localeCompare(b));
  $("#systemPanelBody").innerHTML = `<div class="system-section-head"><div><h2>Cognitive runtime</h2><p>Live feature flags, resource state, and instrumentation from the Speck kernel.</p></div><button id="runBackground" class="primary-button">Run maintenance</button></div>
    <div class="card-grid">${features.map(([label, config]) => `<article class="data-card"><span class="status-pill">${config?.enabled === false ? "disabled" : "enabled"}</span><h3>${escapeHtml(label)}</h3><p>${escapeHtml(compactConfig(config))}</p></article>`).join("")}</div>
    <div class="system-section-head"><div><h2>Resource scheduling</h2><p>Current model-tier leases and background/foreground activity.</p></div></div>
    <pre class="json-box">${escapeHtml(JSON.stringify({ tiers: cognition.tierResources || {}, background: cognition.backgroundState || {} }, null, 2))}</pre>
    <div class="system-section-head"><div><h2>Telemetry</h2><p>Runtime counters captured since startup.</p></div></div>
    <div class="config-summary">${metricEntries.slice(0, 32).map(([name, value]) => `<div><span>${escapeHtml(name)}</span><strong>${Number(value)}</strong></div>`).join("") || `<div><span>Metrics</span><strong>No samples yet</strong></div>`}</div>`;
  $("#runBackground")?.addEventListener("click", runBackgroundMaintenance);
}

export function renderSharedMemory() {
  const memories = Array.isArray(state.system.sharedMemory?.memories) ? state.system.sharedMemory.memories : [];
  const embedding = state.system.brains?.brains?.embedding || {};
  const episodic = memories.filter((memory) => memory.memoryRoles?.includes("episodic"));
  const semantic = memories.filter((memory) => memory.memoryRoles?.includes("semantic"));
  const policy = state.system.memoryAdmission?.policy || {};
  const admissionOptions = [
    ["rawPrompts", "Raw prompts or follow-up answers", "Retain user requests and continuation answers as episodic memory."],
    ["ordinaryConversation", "Greetings and ordinary conversation", "Retain greeting responses and other transient social exchanges."],
    ["intakeRouting", "Intake/routing decisions", "Retain intake classification and routing choices as episodes."],
    ["reasoningCycles", "Routine reasoning cycles", "Retain worker cycle summaries as episodes."],
    ["validatorResponses", "Validator responses", "Retain completion-validator decisions as episodes."],
    ["ordinaryCompletions", "Ordinary task completions", "Retain normal results as shared episodic and semantic memory."],
    ["predictionEpisodes", "Predictions as episodic memories", "Make cognitive and tool predictions retrievable as episodes."]
  ];
  $("#systemPanelBody").innerHTML = `<div class="system-section-head"><div><h2>Global memory</h2><p>Durable memories available by semantic relevance to intake, planners, and workers.</p></div></div>
    <div class="config-summary"><div><span>Total</span><strong>${memories.length}</strong></div><div><span>Episodic</span><strong>${episodic.length}</strong></div><div><span>Semantic</span><strong>${semantic.length}</strong></div></div>
    <div class="system-section-head"><div><h2>Memory admission</h2><p>Choose which normally transient cognitive material may become retrievable memory. All categories default off.</p></div><button id="saveMemoryAdmission" class="primary-button">Save admission</button></div>
    <div class="plugin-stack">${admissionOptions.map(([key, label, description]) => `<article class="plugin-row"><div><h3>${escapeHtml(label)}</h3><p>${escapeHtml(description)}</p></div><label class="switch" title="Retain ${escapeHtml(label)}"><input type="checkbox" data-memory-admission="${escapeHtml(key)}" ${policy[key] === true ? "checked" : ""}/><i></i></label></article>`).join("")}</div>
    <div class="system-section-head"><div><h2>Memory encoder</h2><p>The learned embedding model used to encode and retrieve semantic and episodic memories.</p></div><button id="saveEmbedding" class="primary-button">Save encoder</button></div>
    <section class="role-assignments">
      <label>Enabled<select data-embedding-field="enabled"><option value="true" ${embedding.enabled !== false ? "selected" : ""}>Enabled</option><option value="false" ${embedding.enabled === false ? "selected" : ""}>Disabled</option></select></label>
      <label>Provider<select data-embedding-field="provider">${["llama.cpp", "openai-compatible", "ollama"].map((provider) => `<option ${embedding.provider === provider ? "selected" : ""}>${provider}</option>`).join("")}</select></label>
      <label class="wide">Endpoint URL<input data-embedding-field="baseUrl" value="${escapeHtml(embedding.baseUrl || "http://127.0.0.1:11434")}" /></label>
      <label class="wide">Embedding model<input data-embedding-field="model" value="${escapeHtml(embedding.model || "")}" /></label>
      <label>Dimensions<input data-embedding-field="dimensions" type="number" min="1" value="${Number(embedding.dimensions || 768)}" /></label>
      <label>Device (Ollama)<select data-embedding-field="device"><option value="gpu" ${embedding.device !== "cpu" ? "selected" : ""}>GPU</option><option value="cpu" ${embedding.device === "cpu" ? "selected" : ""}>CPU</option></select></label>
      <label>Hash fallback<select data-embedding-field="allowHashFallback"><option value="true" ${embedding.allowHashFallback !== false ? "selected" : ""}>Allowed</option><option value="false" ${embedding.allowHashFallback === false ? "selected" : ""}>Fail closed</option></select></label>
    </section>
    <form id="sharedMemoryForm" class="role-assignments"><label>Memory type<select name="type"><option value="semantic">Semantic fact</option><option value="episodic">Episodic event</option></select></label>
      <label>Audience<select name="audience"><option value="all">Intake, planner, and worker</option><option value="planner">Planner only</option><option value="worker">Worker only</option><option value="intake">Intake only</option></select></label>
      <label class="wide">Content<textarea name="content" rows="3" placeholder="A durable fact or event to make available globally" required></textarea></label>
      <div class="wide system-save-row"><span>Semantic memories represent facts; episodic memories represent events and interactions.</span><button class="primary-button" type="submit">Store globally</button></div></form>
    <div class="system-section-head"><div><h2>Stored memories</h2><p>Newest global memories and their provenance.</p></div></div>
    <div class="plugin-stack">${memories.slice().reverse().slice(0, 50).map((memory) => `<article class="plugin-row"><div><h3>${memory.memoryRoles?.includes("semantic") ? "Semantic" : "Episodic"}</h3><p>${escapeHtml(memory.content)}</p><small>${escapeHtml(memory.provenance?.source || "unknown")} · confidence ${Number(memory.confidence || 0).toFixed(2)}</small></div><div class="queue-card-actions"><span class="status-pill">global</span><button class="ghost-button" type="button" data-archive-memory="${escapeHtml(memory.id)}">Archive</button></div></article>`).join("") || `<div class="empty-state">No global memories have been stored yet.</div>`}</div>`;
  $("#sharedMemoryForm")?.addEventListener("submit", storeSharedMemory);
  $("#saveEmbedding")?.addEventListener("click", saveEmbeddingConfiguration);
  $("#saveMemoryAdmission")?.addEventListener("click", saveMemoryAdmission);
  $$('[data-archive-memory]').forEach((button) => button.addEventListener("click", archiveSharedMemory));
}

export async function saveMemoryAdmission() {
  const policy = Object.fromEntries($$('[data-memory-admission]').map((input) => [input.dataset.memoryAdmission, input.checked]));
  try {
    state.system.memoryAdmission = await jsonFetch("/api/memory/admission", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy })
    });
    renderSharedMemory();
    showToast(state.system.memoryAdmission.message || "Memory admission settings saved");
  } catch (error) { showToast(error.message, true); }
}

export async function saveEmbeddingConfiguration(event) {
  const field = (name) => $(`[data-embedding-field="${name}"]`);
  event.currentTarget.disabled = true;
  try {
    const result = await adminJson("/api/embeddings/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: field("enabled").value === "true", provider: field("provider").value,
        baseUrl: field("baseUrl").value.trim(), model: field("model").value.trim(),
        dimensions: Number(field("dimensions").value), timeoutMs: 30000, batchSize: 16,
        allowHashFallback: field("allowHashFallback").value === "true",
        device: field("device").value
      })
    });
    state.system.brains.brains.embedding = result.embedding;
    renderSharedMemory();
    showToast(result.message || "Memory encoder saved");
  } catch (error) { showToast(error.message, true); }
  finally { if (document.body.contains(event.currentTarget)) event.currentTarget.disabled = false; }
}

export async function storeSharedMemory(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const audience = data.audience === "all" ? ["intake", "planner", "worker"] : [data.audience];
  try {
    await jsonFetch("/api/speck/shared-memory", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: data.type, content: data.content, audience, scope: "global", confidence: data.type === "semantic" ? 0.9 : 0.8 })
    });
    state.system.sharedMemory = await jsonFetch("/api/speck/shared-memory");
    renderSharedMemory();
    showToast("Global memory stored");
  } catch (error) { showToast(error.message, true); }
}

export async function archiveSharedMemory(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await jsonFetch(`/api/speck/shared-memory/${encodeURIComponent(button.dataset.archiveMemory)}`, { method: "DELETE" });
    state.system.sharedMemory = await jsonFetch("/api/speck/shared-memory");
    renderSharedMemory();
    showToast("Global memory archived");
  } catch (error) { button.disabled = false; showToast(error.message, true); }
}

export function compactConfig(config) {
  if (!config || typeof config !== "object") return "Not reported";
  return Object.entries(config).filter(([key]) => key !== "enabled").slice(0, 4).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ") || "Using runtime defaults";
}

export async function runBackgroundMaintenance(event) {
  event.currentTarget.disabled = true;
  try {
    const result = await jsonFetch("/api/speck/background/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    state.system.cognition = await jsonFetch("/api/speck/status");
    renderCognitionConfiguration();
    showToast(`Maintenance ${result.result?.status || "completed"}`);
  } catch (error) { showToast(error.message, true); }
  finally { if (document.body.contains(event.currentTarget)) event.currentTarget.disabled = false; }
}

export function renderBrainConfiguration() {
  const payload = state.system.brains || {};
  const config = payload.brains || {};
  const processors = Array.isArray(config.processors) ? config.processors : [];
  const roles = config.roles || {};
  const option = (processor, selected) => `<option value="${escapeHtml(processor.id)}" ${processor.id === selected ? "selected" : ""}>${escapeHtml(processor.id)} · ${escapeHtml(processor.model)}</option>`;
  const enabled = processors.filter((processor) => processor.enabled !== false);
  // A judgment-only processor (an NLI cross-encoder) cannot write, so it is
  // offered only for the checker seat.
  const roleOptions = (selected) => enabled.filter((processor) => processor.provider !== "nli").map((processor) => option(processor, selected)).join("");
  const checkerOptions = (selected) => enabled.map((processor) => option(processor, selected)).join("");
  $("#systemPanelBody").innerHTML = `<div class="system-section-head"><div><h2>Brain configuration</h2><p>Configure the processors Speck can route work to. Saved changes apply immediately and persist across restarts.</p></div>
      <div class="queue-actions"><button id="addBrain" class="ghost-button">Add processor</button><button id="saveBrains" class="primary-button">Save configuration</button></div></div>
    <div class="config-summary"><div><span>Routing</span><strong>${payload.routing?.enabled === false ? "Disabled" : "Enabled"}</strong></div>
      <div><span>Fallback attempts</span><strong>${Number(payload.routing?.fallbackAttempts || 0)}</strong></div>
      <div><span>Escalation</span><strong>${payload.queue?.escalationEnabled === false ? "Disabled" : "Enabled"}</strong></div>
      <div><span>Enabled brains</span><strong>${(config.enabledIds || []).length}</strong></div></div>
    <section class="role-assignments"><label>Intake processor<select data-model-role="intake">${roleOptions(roles.intake)}</select></label>
      <label>Planner processor<select data-model-role="planner">${roleOptions(roles.planner)}</select></label>
      <label>Worker processor<select data-model-role="worker">${roleOptions(roles.worker)}</select></label>
      <label>Writer processor<select data-model-role="writer"><option value="" ${roles.writer ? "" : "selected"}>Same as worker</option>${roleOptions(roles.writer)}</select></label>
      <label>Tool Caller processor<select data-model-role="toolCaller">${roleOptions(roles.toolCaller)}</select></label>
      <label>Checker processor<select data-model-role="checker"><option value="" ${roles.checker ? "" : "selected"}>Automatic (cheapest qualified)</option>${checkerOptions(roles.checker)}</select></label>
      <label>Specialist routing<textarea data-model-role="specialists" rows="3" placeholder="coding=code-worker">${escapeHtml(Object.entries(roles.specialists || {}).map(([key, id]) => `${key}=${id}`).join("\n"))}</textarea></label>
      <div class="wide checker-status">${checkerStatus(config)}</div></section>
    <datalist id="discoveredBrainModels"></datalist>
    <div id="brainConfigList" class="brain-config-list">${processors.map(brainEditor).join("") || `<div class="empty-state">No processors are configured. Add one to enable model inference.</div>`}</div>`;
  $("#addBrain")?.addEventListener("click", addBrainEditor);
  $("#saveBrains")?.addEventListener("click", saveBrainConfiguration);
  bindBrainEditorActions();
}

// Who checks hypothesis requirements now, and whether its verdicts count:
// only a model measured qualified for atomic entailment may move a belief,
// otherwise every check is void.
export function checkerStatus(config) {
  const checker = config.checker || {};
  const qualifications = config.qualifications || {};
  const describe = (id) => {
    const measured = qualifications[id]?.atomicEntailment;
    if (!measured) return `${escapeHtml(id)} has not been measured (run <code>speck probe qualify</code>)`;
    const percent = (value) => `${Math.round(100 * Number(value || 0))}%`;
    return `${escapeHtml(id)} is ${measured.qualified ? "qualified" : "not qualified"} for atomic entailment: contradiction ${percent(measured.contradiction)}, negation consistency ${percent(measured.negationConsistency)}, overall ${percent(measured.overall)} (${escapeHtml(measured.corpus)})`;
  };
  if (checker.effective) return `<span class="status-pill">checking</span> Requirements are checked by ${describe(checker.effective)}.`;
  const why = checker.configured ? describe(checker.configured) : "no other model is qualified for atomic entailment";
  return `<span class="status-pill">void</span> Hypothesis checks are void, so no belief moves: ${why}.`;
}

function qualificationBadge(processor) {
  const measured = (state.system.brains?.brains?.qualifications || {})[processor.id]?.atomicEntailment;
  if (!processor.id || !measured) return "";
  return `<span class="status-pill" title="Atomic entailment, ${escapeHtml(measured.corpus)}">${measured.qualified ? "qualified checker" : "not qualified to check"}</span>`;
}

export function brainEditor(processor = {}) {
  return `<article class="brain-editor" data-brain-editor>
    <div class="brain-editor-head"><label class="switch"><input type="checkbox" data-brain-field="enabled" ${processor.enabled !== false ? "checked" : ""}/><i></i></label>
      <strong>${escapeHtml(processor.id || "New processor")}</strong>${qualificationBadge(processor)}<button class="ghost-button" data-remove-brain type="button">Remove</button></div>
    <div class="brain-editor-fields">
      <label>ID<input data-brain-field="id" value="${escapeHtml(processor.id || "")}" placeholder="local-worker" /></label>
      <label>Provider<select data-brain-field="provider">${["ollama", "openai-compatible", "llama.cpp", "nli"].map((provider) => `<option ${processor.provider === provider ? "selected" : ""}>${provider}</option>`).join("")}</select></label>
      <label class="wide">Endpoint URL<div class="field-action"><input data-brain-field="baseUrl" value="${escapeHtml(processor.baseUrl || "http://127.0.0.1:11434")}" placeholder="http://127.0.0.1:11434" /><button class="ghost-button" data-discover-brains type="button">Discover</button></div></label>
      <label class="wide">Model<input data-brain-field="model" list="discoveredBrainModels" value="${escapeHtml(processor.model || "")}" placeholder="qwen3:14b" /></label>
      <label>Tier<select data-brain-field="tier">${[1, 2, 3, 4].map((tier) => `<option value="${tier}" ${Number(processor.tier || 2) === tier ? "selected" : ""}>Tier ${tier}</option>`).join("")}</select></label>
      <label>Context size<input data-brain-field="contextSize" type="number" min="256" step="256" value="${Number(processor.contextSize || 32768)}" /></label>
      <label>Parameters<input data-brain-field="parameters" type="number" min="0" value="${Number(processor.parameters || 0)}" /></label>
      <label>Hardware<input data-brain-field="hardware" value="${escapeHtml(processor.hardware || "local")}" /></label>
      <label class="wide">Specialties<input data-brain-field="specialties" value="${escapeHtml((processor.specialties || ["general"]).join(", "))}" placeholder="general, coding, planning" /></label>
      <label class="wide">API key environment variable<input data-brain-field="apiKeyEnv" value="${escapeHtml(processor.apiKeyEnv || "")}" placeholder="Optional; the secret itself is never stored" /></label>
    </div></article>`;
}

export function bindBrainEditorActions() {
  $$('[data-remove-brain]').forEach((button) => button.onclick = () => {
    button.closest("[data-brain-editor]")?.remove();
    if (!$("[data-brain-editor]")) $("#brainConfigList").innerHTML = `<div class="empty-state">No processors are configured. Add one to enable model inference.</div>`;
  });
  $$('[data-discover-brains]').forEach((button) => button.onclick = discoverBrainModels);
  // An NLI cross-encoder is served by the sidecar (sidecars/nli) and reads a
  // short premise and hypothesis; switching to it fills its defaults where
  // the fields still hold another provider's.
  $$('[data-brain-field="provider"]').forEach((select) => select.onchange = () => {
    const editor = select.closest("[data-brain-editor]");
    const field = (name) => $(`[data-brain-field="${name}"]`, editor);
    if (select.value === "nli") {
      if (/:11434\/?$/.test(field("baseUrl").value.trim()) || !field("baseUrl").value.trim()) field("baseUrl").value = "http://127.0.0.1:8765";
      if (Number(field("contextSize").value) > 4096) field("contextSize").value = "512";
      field("specialties").value = "atomic-entailment";
      field("model").placeholder = "MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli";
    }
  });
  $$('[data-brain-field="id"]').forEach((input) => input.oninput = () => {
    const title = $(".brain-editor-head strong", input.closest("[data-brain-editor]"));
    if (title) title.textContent = input.value.trim() || "New processor";
  });
}

export function addBrainEditor() {
  $(".empty-state", $("#brainConfigList"))?.remove();
  $("#brainConfigList").insertAdjacentHTML("beforeend", brainEditor({ enabled: true, provider: "ollama", tier: 2, contextSize: 32768, specialties: ["general"] }));
  bindBrainEditorActions();
  $$('[data-brain-field="id"]').at(-1)?.focus();
}

export async function discoverBrainModels(event) {
  const editor = event.currentTarget.closest("[data-brain-editor]");
  const baseUrl = $('[data-brain-field="baseUrl"]', editor)?.value.trim();
  const provider = $('[data-brain-field="provider"]', editor)?.value;
  event.currentTarget.disabled = true;
  try {
    const result = await adminJson("/api/brains/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl, provider }) });
    $("#discoveredBrainModels").innerHTML = result.models.map((model) => `<option value="${escapeHtml(model.name)}">${escapeHtml([model.parameters, model.contextSize ? `${model.contextSize} ctx` : ""].filter(Boolean).join(" · "))}</option>`).join("");
    const modelInput = $('[data-brain-field="model"]', editor);
    if (result.models.length === 1 && !modelInput.value.trim()) modelInput.value = result.models[0].name;
    showToast(`Found ${result.models.length} model${result.models.length === 1 ? "" : "s"}`);
    modelInput.focus();
  } catch (error) { showToast(error.message, true); }
  finally { event.currentTarget.disabled = false; }
}

export async function saveBrainConfiguration() {
  const processors = $$('[data-brain-editor]').map((editor) => {
    const value = (name) => $(`[data-brain-field="${name}"]`, editor);
    return {
      id: value("id").value.trim(), provider: value("provider").value, baseUrl: value("baseUrl").value.trim(), model: value("model").value.trim(),
      tier: Number(value("tier").value), contextSize: Number(value("contextSize").value), parameters: Number(value("parameters").value) || undefined,
      hardware: value("hardware").value.trim(), specialties: value("specialties").value.split(",").map((item) => item.trim()).filter(Boolean),
      apiKeyEnv: value("apiKeyEnv").value.trim() || undefined, enabled: value("enabled").checked
    };
  });
  const specialists = {};
  $('[data-model-role="specialists"]')?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const [specialty, processorId] = line.split("=").map((part) => part.trim());
    if (specialty && processorId) specialists[specialty] = processorId;
  });
  const roles = {
    intake: $('[data-model-role="intake"]')?.value || "",
    planner: $('[data-model-role="planner"]')?.value || "",
    worker: $('[data-model-role="worker"]')?.value || "",
    writer: $('[data-model-role="writer"]')?.value || "",
    toolCaller: $('[data-model-role="toolCaller"]')?.value || "",
    checker: $('[data-model-role="checker"]')?.value || "",
    specialists
  };
  const button = $("#saveBrains");
  button.disabled = true;
  try {
    state.system.brains = await adminJson("/api/brains/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ processors, roles }) });
    state.system.runtime = await jsonFetch("/api/runtime/status");
    renderBrainConfiguration();
    showToast(state.system.brains.message || "Brain configuration saved");
  } catch (error) { showToast(error.message, true); }
  finally { if (document.body.contains(button)) button.disabled = false; }
}

export function renderToolConfiguration() {
  const tools = Array.isArray(state.system.tools?.tools) ? state.system.tools.tools : [];
  $("#systemPanelBody").innerHTML = `<div class="system-section-head"><div><h2>Capabilities</h2><p>Control approval for tools exposed to Speck's workers.</p></div><button id="saveTools" class="primary-button">Save approvals</button></div>
    <div class="plugin-stack">${tools.map((tool) => `<article class="plugin-row"><div><h3>${escapeHtml(tool.name)}</h3><p>${escapeHtml(tool.description || tool.kind || "Runtime tool")}</p></div>
      <label class="switch" title="Approve ${escapeHtml(tool.name)}"><input type="checkbox" data-tool-approval="${escapeHtml(tool.name)}" ${tool.approved !== false ? "checked" : ""}/><i></i></label></article>`).join("") || `<div class="empty-state">No runtime tools are registered.</div>`}</div>`;
  $("#saveTools")?.addEventListener("click", saveToolApprovals);
}

export function renderWebConfiguration() {
  const browser = state.system.browser?.browser || {};
  $("#systemPanelBody").innerHTML = `<div class="system-section-head"><div><h2>Web search and reading</h2><p>Connect Speck's core browser tools to the trusted LAN Playwright service. Search results and page content are always treated as untrusted external data.</p></div></div>
    <section class="role-assignments">
      <label>Enabled<select data-browser-field="enabled"><option value="true" ${browser.enabled !== false ? "selected" : ""}>Enabled</option><option value="false" ${browser.enabled === false ? "selected" : ""}>Disabled</option></select></label>
      <label>Search results<input data-browser-field="searchLimit" type="number" min="1" max="20" value="${Number(browser.searchLimit || 6)}" /></label>
      <label class="wide">Playwright service URL<input data-browser-field="baseUrl" value="${escapeHtml(browser.baseUrl || "http://127.0.0.1:39005")}" placeholder="http://127.0.0.1:39005" /></label>
      <label>Timeout (milliseconds)<input data-browser-field="timeoutMs" type="number" min="1000" step="1000" value="${Number(browser.timeoutMs || 30000)}" /></label>
      <div class="wide system-save-row"><span>Provides browser_search and browser_read_page. Private page targets are blocked.</span><div class="queue-actions"><button id="testBrowser" class="ghost-button" type="button">Test connection</button><button id="saveBrowser" class="primary-button" type="button">Save configuration</button></div></div>
    </section>`;
  $("#saveBrowser")?.addEventListener("click", saveBrowserConfiguration);
  $("#testBrowser")?.addEventListener("click", testBrowserConfiguration);
}

export async function saveBrowserConfiguration(event) {
  const field = (name) => $(`[data-browser-field="${name}"]`);
  event.currentTarget.disabled = true;
  try {
    state.system.browser = await adminJson("/api/browser/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: field("enabled").value === "true", baseUrl: field("baseUrl").value.trim(),
        timeoutMs: Number(field("timeoutMs").value), searchLimit: Number(field("searchLimit").value)
      })
    });
    renderWebConfiguration();
    showToast(state.system.browser.message || "Web browser configuration saved");
  } catch (error) { showToast(error.message, true); }
  finally { if (document.body.contains(event.currentTarget)) event.currentTarget.disabled = false; }
}

export async function testBrowserConfiguration(event) {
  event.currentTarget.disabled = true;
  try {
    const result = await adminJson("/api/browser/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    showToast(result.health?.browser ? "Playwright browser is ready" : "Playwright service responded");
  } catch (error) { showToast(error.message, true); }
  finally { event.currentTarget.disabled = false; }
}

export function renderSecretConfiguration() {
  const secrets = Array.isArray(state.system.secrets?.secrets) ? state.system.secrets.secrets : [];
  $("#systemPanelBody").innerHTML = `<div class="system-section-head"><div><h2>Secret handles</h2><p>Store credentials encrypted outside the workspace. Models can refer to handles, but secret values are only released to trusted local host capabilities.</p></div></div>
    <form id="secretForm" class="role-assignments">
      <label>Handle<input name="handle" autocomplete="off" placeholder="service.api-key" required pattern="[a-z][a-z0-9_.-]{1,63}" /></label>
      <label>Secret value<input name="value" type="password" autocomplete="new-password" required /></label>
      <div class="wide system-save-row"><span>Saving an existing handle replaces its value. Values are never displayed again.</span><button class="primary-button" type="submit">Save secret</button></div>
    </form>
    <div class="system-section-head"><div><h2>Stored handles</h2><p>Only metadata is shown.</p></div></div>
    <div class="plugin-stack">${secrets.map((secret) => `<article class="plugin-row"><div><h3>${escapeHtml(secret.handle)}</h3><p>Updated ${escapeHtml(new Date(secret.updatedAt).toLocaleString())}</p></div><button class="ghost-button" type="button" data-delete-secret="${escapeHtml(secret.handle)}">Delete</button></article>`).join("") || `<div class="empty-state">No secret handles are stored.</div>`}</div>`;
  $("#secretForm")?.addEventListener("submit", saveSecret);
  $$('[data-delete-secret]').forEach((button) => button.addEventListener("click", deleteSecret));
}

export async function saveSecret(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  const data = Object.fromEntries(new FormData(event.currentTarget));
  button.disabled = true;
  try {
    state.system.secrets = await adminJson("/api/secrets", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data)
    });
    renderSecretConfiguration();
    showToast(state.system.secrets.message || "Secret saved");
  } catch (error) { showToast(error.message, true); }
  finally { if (document.body.contains(button)) button.disabled = false; }
}

export async function deleteSecret(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    state.system.secrets = await adminJson(`/api/secrets/${encodeURIComponent(button.dataset.deleteSecret)}`, { method: "DELETE" });
    renderSecretConfiguration();
    showToast("Secret deleted");
  } catch (error) { button.disabled = false; showToast(error.message, true); }
}

export async function saveToolApprovals() {
  const toolApprovals = Object.fromEntries($$('[data-tool-approval]').map((input) => [input.dataset.toolApproval, input.checked]));
  try {
    const tools = await jsonFetch("/api/tools/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ toolApprovals }) });
    state.system.tools = tools;
    renderToolConfiguration();
    showToast(tools.message || "Capability approvals saved");
  } catch (error) { showToast(error.message, true); }
}

export function renderProfileConfiguration() {
  const payload = state.system.profiles || {};
  const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  const activeId = payload.profile?.id || payload.selection?.activeProfileId;
  const pendingId = payload.selection?.pendingProfileId;
  $("#systemPanelBody").innerHTML = `<div class="system-section-head"><div><h2>Runtime profile</h2><p>Select the Genesis compatibility profile Speck should use after restart.</p></div></div>
    ${payload.envOverride ? `<div class="system-notice">The active profile is controlled by an environment variable, so saved selection may not take effect.</div>` : ""}
    <div class="profile-list">${profiles.map((profile) => `<label class="profile-card ${profile.id === activeId ? "active" : ""}">
      <input type="radio" name="profile" value="${escapeHtml(profile.id)}" ${profile.id === (pendingId || activeId) ? "checked" : ""}/><div><span class="eyebrow">${profile.id === activeId ? "Active" : profile.id === pendingId ? "Pending restart" : "Available"}</span><h3>${escapeHtml(profile.name || profile.id)}</h3><p>${escapeHtml(profile.description || "")}</p></div></label>`).join("")}</div>
    <div class="system-save-row"><span>${pendingId ? `Profile ${escapeHtml(pendingId)} will apply after restart.` : "Changing profile requires a restart."}</span><button id="saveProfile" class="primary-button">Save profile</button></div>`;
  $("#saveProfile")?.addEventListener("click", saveProfileSelection);
}

export async function saveProfileSelection() {
  const profileId = $('input[name="profile"]:checked')?.value;
  if (!profileId) return showToast("Select a profile first", true);
  try {
    const result = await jsonFetch("/api/profile/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId }) });
    state.system.profiles = result;
    renderProfileConfiguration();
    showToast(result.message || "Profile saved");
  } catch (error) { showToast(error.message, true); }
}

export async function renderSystemPluginTab(tab) {
  const body = $("#systemPanelBody");
  if (!tab?.scriptUrl) {
    body.innerHTML = `<div class="empty-state">This plugin system tab has no interface module.</div>`;
    return;
  }
  body.innerHTML = `<section class="plugin-tab-host"><span class="eyebrow">${escapeHtml(tab.pluginId || "plugin")}</span><h2>${escapeHtml(tab.title || tab.id)}</h2><div data-mount></div></section>`;
  try { await mountPluginTab(tab, $("[data-mount]", body)); }
  catch (error) { body.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}
