// The Files panel: browsing, previews and uploads to the inbox.

import { state, $, $$, escapeHtml, timeAgo, formatBytes, jsonFetch, adminFetch, showToast } from "./core.js";
import { refreshWorkspace } from "./workspace.js";

export function renderFilesPanel() {
  const kinds = ["all", "document", "code", "configuration", "data", "asset", "file"];
  const visible = state.selectedFileKind === "all" ? state.files : state.files.filter((file) => file.kind === state.selectedFileKind);
  $("#panelContent").innerHTML = `<div class="toolbar"><select id="fileKindFilter">${kinds.map((kind) => `<option value="${kind}" ${kind === state.selectedFileKind ? "selected" : ""}>${kind === "all" ? "All matter" : kind}</option>`).join("")}</select></div>
    <section id="workspaceUploadZone" class="file-upload-zone" tabindex="0" role="button" aria-label="Upload files to the workspace inbox">
      <input id="workspaceFileInput" type="file" multiple hidden />
      <div><strong>Add files to the workspace</strong><span id="workspaceUploadStatus">Drop files here or choose them from your computer · 20 MB maximum per file</span></div>
      <button id="chooseWorkspaceFiles" class="primary-button" type="button">Choose files</button>
    </section>
    ${renderFilePreview()}
    <div class="card-grid">${visible.map((file) => `<article class="data-card file-card ${file.path === state.selectedFilePath ? "selected-result" : ""}" data-file-path="${escapeHtml(file.path)}">
      <span class="status-pill">${escapeHtml(file.kind)}</span><h3>${escapeHtml(file.name)}</h3><p>${escapeHtml(file.path)}</p>
      <div class="meta"><span>${formatBytes(file.size)}</span><span>${timeAgo(file.modifiedAt)}</span></div>
      <div class="file-actions"><button type="button" class="ghost-button" data-file-view="${escapeHtml(file.path)}">View</button><a class="ghost-button" href="${fileDownloadUrl(file.path)}">Download</a></div>
    </article>`).join("") || `<div class="empty-state">No matching workspace matter.</div>`}</div>`;
  $("#fileKindFilter")?.addEventListener("change", (event) => { state.selectedFilePath = ""; state.filePreview = null; state.selectedFileKind = event.target.value; renderFilesPanel(); });
  $$('[data-file-view]').forEach((button) => button.addEventListener("click", () => openFilePreview(button.dataset.fileView)));
  const uploadZone = $("#workspaceUploadZone");
  const fileInput = $("#workspaceFileInput");
  $("#chooseWorkspaceFiles")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => uploadWorkspaceFiles(fileInput.files));
  uploadZone?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    fileInput?.click();
  });
  ["dragenter", "dragover"].forEach((type) => uploadZone?.addEventListener(type, (event) => {
    event.preventDefault();
    uploadZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((type) => uploadZone?.addEventListener(type, (event) => {
    event.preventDefault();
    uploadZone.classList.remove("dragging");
  }));
  uploadZone?.addEventListener("drop", (event) => uploadWorkspaceFiles(event.dataTransfer?.files));
}

export async function uploadWorkspaceFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const maximumBytes = 20 * 1024 * 1024;
  const status = $("#workspaceUploadStatus");
  const controls = [$("#workspaceFileInput"), $("#chooseWorkspaceFiles")].filter(Boolean);
  controls.forEach((control) => { control.disabled = true; });
  let uploaded = 0;
  const failures = [];
  for (const [index, file] of files.entries()) {
    if (status) status.textContent = `Uploading ${index + 1} of ${files.length} · ${file.name}`;
    if (file.size > maximumBytes) {
      failures.push(`${file.name}: exceeds the 20 MB limit`);
      continue;
    }
    try {
      const response = await adminFetch(`/api/inspect/upload?file=${encodeURIComponent(file.name)}`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: file
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `${response.status} ${response.statusText}`);
      uploaded += 1;
      state.selectedFilePath = payload.file || `inbox/${file.name}`;
      state.selectedFileKind = "all";
      state.filePreview = null;
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
    }
  }
  controls.forEach((control) => { control.disabled = false; });
  await refreshWorkspace({ quiet: true });
  if (failures.length) showToast(`${uploaded} uploaded · ${failures.join("; ")}`, true);
  else showToast(`${uploaded} file${uploaded === 1 ? "" : "s"} added to the workspace`);
}

export function fileDownloadUrl(filePath) {
  return `/api/inspect/download?scope=workspace&file=${encodeURIComponent(filePath)}`;
}

export function fileOpenUrl(filePath) {
  return `/api/inspect/open?scope=workspace&file=${encodeURIComponent(filePath)}`;
}

export function renderFilePreview() {
  const preview = state.filePreview;
  if (!preview || preview.path !== state.selectedFilePath) return "";
  const file = state.files.find((candidate) => candidate.path === preview.path);
  if (!file) return "";
  let body = `<div class="file-preview-message">This file cannot be previewed in the browser. You can still download it.</div>`;
  if (preview.loading) body = `<div class="file-preview-message">Loading previewâ€¦</div>`;
  else if (preview.error) body = `<div class="file-preview-message error">${escapeHtml(preview.error)}</div>`;
  else if (preview.mode === "text") body = `<pre>${escapeHtml(preview.content)}</pre>`;
  else if (preview.mode === "image") body = `<img src="${fileOpenUrl(file.path)}" alt="Preview of ${escapeHtml(file.name)}" />`;
  else if (preview.mode === "pdf") body = `<iframe src="${fileOpenUrl(file.path)}" title="Preview of ${escapeHtml(file.name)}"></iframe>`;
  else if (preview.mode === "audio") body = `<audio controls src="${fileOpenUrl(file.path)}"></audio>`;
  return `<section class="file-preview"><div class="file-preview-head"><div><span class="eyebrow">Preview</span><h2>${escapeHtml(file.name)}</h2><small>${escapeHtml(file.path)} Â· ${formatBytes(file.size)}</small></div><div class="file-actions"><a class="ghost-button" href="${fileOpenUrl(file.path)}" target="_blank" rel="noopener">Open</a><a class="primary-button" href="${fileDownloadUrl(file.path)}">Download</a></div></div>${body}</section>`;
}

export async function openFilePreview(filePath) {
  const file = state.files.find((candidate) => candidate.path === filePath);
  if (!file) return showToast("That file is no longer available.", true);
  state.selectedFilePath = file.path;
  const extension = String(file.extension || "").toLowerCase();
  const text = new Set(["txt", "text", "md", "mdx", "rtf", "json", "jsonl", "yaml", "yml", "toml", "ini", "env", "csv", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "html", "sql", "sh", "ps1"]);
  const images = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
  const audio = new Set(["mp3", "wav", "ogg", "m4a"]);
  const mode = text.has(extension) ? "text" : images.has(extension) ? "image" : extension === "pdf" ? "pdf" : audio.has(extension) ? "audio" : "unsupported";
  state.filePreview = { path: file.path, mode, content: "", error: "", loading: mode === "text" };
  renderFilesPanel();
  if (mode === "text") {
    try {
      const payload = await jsonFetch(`/api/inspect/file?scope=workspace&file=${encodeURIComponent(file.path)}`);
      if (state.filePreview?.path === file.path) state.filePreview = { ...state.filePreview, content: payload.content || "", loading: false };
    } catch (error) {
      if (state.filePreview?.path === file.path) state.filePreview = { ...state.filePreview, error: error.message, loading: false };
    }
    if (state.view === "files") renderFilesPanel();
  }
  requestAnimationFrame(() => $(".file-preview")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}
