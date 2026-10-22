import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The interface's server source: the entry and its modules in src/genesis-ui/.
function interfaceSource(): string {
  const files = [path.resolve("src", "genesis-ui.ts")];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(path.resolve("src", "genesis-ui"));
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

const publicRoot = path.resolve("public");

// The interface script: the entry and its modules in public/ui/.
function uiScript(): string {
  const modules = fs.readdirSync(path.join(publicRoot, "ui")).filter((name) => name.endsWith(".js")).sort();
  return [path.join(publicRoot, "speck.js"), ...modules.map((name) => path.join(publicRoot, "ui", name))]
    .map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

test("base GUI contains no hard-coded optional-plugin operations", () => {
  const sources = [fs.readFileSync(path.join(publicRoot, "index.html"), "utf8"), uiScript()].join("\n");

  for (const routePrefix of [
    "/api/plugins/tasks",
    "/api/plugins/session-memory",
    "/api/plugins/security"
  ]) {
    assert.equal(sources.includes(routePrefix), false, `${routePrefix} must be supplied by an installed plugin`);
  }
  assert.equal(sources.includes("pluginsOpsPanel"), false);
});

test("every interface script parses", () => {
  const scripts = [
    ...fs.readdirSync(publicRoot).filter((name) => name.endsWith(".js")).map((name) => path.join(publicRoot, name)),
    ...fs.readdirSync(path.join(publicRoot, "ui")).filter((name) => name.endsWith(".js")).map((name) => path.join(publicRoot, "ui", name)),
    ...fs.readdirSync(path.resolve("plugins"), { recursive: true, encoding: "utf8" })
      .filter((name) => /[\\/]ui[\\/][^\\/]+\.js$/.test(name)).map((name) => path.resolve("plugins", name))
  ];
  for (const script of scripts) {
    const checked = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
    assert.equal(checked.status, 0, `${script} does not parse:\n${checked.stderr}`);
  }
});

test("plugin primary tabs are views of their own in the rail", () => {
  const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  const script = uiScript();
  assert.match(html, /id="pluginRail"/);
  assert.match(script, /renderPluginRail/);
  assert.match(script, /uiPrimaryTabs/);
});

test("base GUI retains generic Genesis plugin management and dynamic panels", () => {
  const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  const plugins = uiScript();

  assert.match(html, /data-view="plugins"/);
  assert.match(plugins, /adminJson\("\/api\/plugins\/list"\)/);
  assert.match(plugins, /catalog\.uiPanels/);
  assert.match(plugins, /runPluginAction/);
  assert.match(plugins, /mountObserverPluginTab/);
});

test("system view restores runtime, brain, capability, profile, and plugin system panels", () => {
  const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  const script = uiScript();
  assert.match(html, /data-view="system"/);
  assert.match(script, /\/api\/runtime\/status/);
  assert.match(script, /\/api\/brains\/config/);
  assert.match(script, /\/api\/tools\/config/);
  assert.match(script, /\/api\/profile\/options/);
  assert.match(script, /uiSystemTabs/);
  assert.match(script, /Brain configuration/);
  assert.match(script, /\["voice", "Voice"\]/);
  assert.match(script, /renderVoiceConfiguration/);
});

test("Speck GUI does not expose the retired avatar infrastructure dashboard", () => {
  const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  for (const retiredSurface of ["Qdrant", "Ollama", "Brain Network", "avatarModelPath"]) {
    assert.equal(html.includes(retiredSurface), false, `${retiredSurface} must not appear in the Speck interface`);
  }
  assert.match(html, /id="speckSprite"/);
  assert.match(html, /Files &amp; documents|data-view="files"/);
  assert.match(html, /id="voiceButton"/);
});

test("workspace is a local Three.js scene whose objects navigate to their concrete results", () => {
  const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  const script = uiScript();
  const world = fs.readFileSync(path.join(publicRoot, "world-3d.js"), "utf8");
  const host = fs.readFileSync(path.resolve("src", "genesis-host.ts"), "utf8");
  assert.match(html, /id="worldCanvas"/);
  assert.match(html, /\/vendor\/three\/build\/three\.module\.js/);
  assert.match(world, /new THREE\.WebGLRenderer/);
  assert.match(world, /new OrbitControls/);
  assert.match(world, /controls\.enablePan = true/);
  assert.match(world, /controls\.minDistance = 1\.25/);
  assert.match(world, /createTimeline\(entities\.length\)/);
  assert.match(world, /spiralAngle/);
  assert.match(world, /SPAWN_DURATION_SECONDS = 1\.45/);
  assert.match(world, /motion\.spawnStartedAt/);
  assert.match(world, /const stemProgress = smootherStep\(progress\)/);
  assert.match(world, /easeOutBack\(contentProgress\)/);
  assert.match(script, /\.slice\(-50\)/);
  assert.match(script, /visibleTaskIds\.has\(taskId\)/);
  assert.match(html, /id="timelineStatus"/);
  assert.match(script, /state\.selectedTaskId = task\.id/);
  assert.match(script, /state\.queueTab = queueTabForStatus\(task\.status\)/);
  assert.match(script, /selected-result/);
  assert.match(host, /app\.use\("\/vendor\/three"/);
});

test("World can switch to an interactive Three.js memory constellation", () => {
  const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  const script = uiScript();
  const memoryScene = fs.readFileSync(path.join(publicRoot, "memory-3d.js"), "utf8");
  const bridge = interfaceSource();
  assert.match(html, /data-world-mode="memory"/);
  assert.match(html, /id="memoryCanvas"/);
  assert.match(script, /createMemoryScene/);
  assert.match(script, /scenes\.memory\?\.setGraph/);
  assert.match(script, /renderMemoryInspector/);
  assert.match(memoryScene, /new THREE\.WebGLRenderer/);
  assert.match(memoryScene, /new OrbitControls/);
  assert.match(memoryScene, /constellationLayout/);
  assert.match(memoryScene, /new THREE\.LineSegments/);
  assert.match(bridge, /app\.get\("\/api\/memory\/graph"/);
  assert.match(bridge, /memory\.associations/);
});

test("queue interface uses the original tabbed presentation instead of a lane board", () => {
  const script = uiScript();
  assert.match(script, /data-queue-tab/);
  assert.match(script, /Pause queue/);
  assert.match(script, /Dispatch next/);
  assert.doesNotMatch(script, /queue-board/);
});

test("Speck owns functional inbox and outbox file routes", () => {
  const bridge = interfaceSource();
  assert.match(bridge, /workspaceRoot, "inbox"/);
  assert.match(bridge, /workspaceRoot, "outbox"/);
  assert.match(bridge, /resolveExistingWorkspaceFile/);
  assert.doesNotMatch(bridge, /State file not found|Output file not found/);
});

test("documents UI previews and downloads confined workspace files", () => {
  const script = uiScript();
  const bridge = interfaceSource();
  assert.match(script, /data-file-view/);
  assert.match(script, /renderFilePreview/);
  assert.match(script, /\/api\/inspect\/file\?scope=workspace/);
  assert.match(script, /\/api\/inspect\/download\?scope=workspace/);
  assert.match(bridge, /app\.get\("\/api\/inspect\/open"/);
  assert.match(bridge, /app\.get\("\/api\/inspect\/download"/);
  assert.match(bridge, /resolveExistingWorkspaceFile\(root, file\)/);
});

test("documents UI uploads files into the confined workspace inbox", () => {
  const script = uiScript();
  const styles = fs.readFileSync(path.join(publicRoot, "speck.css"), "utf8");
  const bridge = interfaceSource();
  assert.match(script, /id="workspaceFileInput" type="file" multiple/);
  assert.match(script, /workspaceUploadZone/);
  assert.match(script, /dataTransfer\?\.files/);
  assert.match(script, /\/api\/inspect\/upload\?file=/);
  assert.match(script, /application\/octet-stream/);
  assert.match(styles, /\.file-upload-zone\.dragging/);
  assert.match(bridge, /app\.post\("\/api\/inspect\/upload"/);
  assert.match(bridge, /express\.raw\(\{ type: "application\/octet-stream", limit: "20mb" \}\)/);
  assert.match(bridge, /resolveNewWorkspaceFile\(inboxRoot, file\)/);
  assert.match(bridge, /flag: "wx"/);
});

test("Speck GUI retains browser voice capture without the removed presence endpoint", () => {
  const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  const script = uiScript();
  assert.match(script, /SpeechRecognition.*webkitSpeechRecognition/);
  assert.match(script, /observer:voice-transcript/);
  assert.match(script, /submitTextRequest\(request, \{ source: "voice", transcribed: true \}\)/);
  assert.match(script, /voiceWakeRemainder/);
  assert.match(script, /canonicalizeVoiceTranscript/);
  assert.match(script, /replace\(\/\\bspec\\b\/gi, "Speck"\)/);
  assert.match(script, /speck\|spec/);
  assert.match(script, /\/api\/agent\/run/);
  assert.match(html, /id="quickComposer"/);
  assert.match(html, /id="quickPrompt"/);
  assert.doesNotMatch(html, /id="voiceSelect"/);
  assert.match(script, /id="voiceSelect"/);
  assert.match(script, /id="voicePreviewButton"/);
  assert.match(script, /speechSynthesis\.getVoices\(\)/);
  assert.match(script, /speck\.voiceName/);
  assert.match(script, /utterance\.rate = 0\.96/);
  assert.match(script, /utterance\.pitch = 1\.02/);
  assert.doesNotMatch(script, /\/api\/tasks\/enqueue/);
  assert.doesNotMatch(script, /\/api\/presence\/observe/);
});

test("voice waits for a natural pause and follow-up turns retain conversation context", () => {
  const script = uiScript();
  const bridge = interfaceSource();
  assert.match(script, /VOICE_SILENCE_MS = 3500/);
  assert.match(script, /function noteVoiceActivity\(\)/);
  assert.match(script, /state\.voice\.interimText\.trim\(\)/);
  assert.match(script, /quietFor < VOICE_SILENCE_MS/);
  assert.match(script, /conversation: loadConversation\(\)/);
  assert.match(script, /continuationTaskId/);
  assert.match(script, /state\.conversation\.slice\(-12\)/);
  assert.match(script, /rightWords\.slice\(overlap\)/);
  assert.match(script, /task\?\.status === "waiting_for_user"/);
  assert.match(script, /speakVoice\(answer, expectsReply\)/);
  assert.match(script, /updateVoiceUi\("Listening for your reply…"\)/);
  // The conversation is held by Speck's default path: one session per
  // sessionId, answered by respond() (the episode pipeline is archived).
  assert.match(bridge, /sessions\.load\(sessionId\)/);
  assert.match(bridge, /await respond\(session, message/);
  assert.match(bridge, /sessions\.save\(session\)/);
  assert.doesNotMatch(bridge, /conversationRequest/);
});

test("memory panel exposes eight persisted admission controls", () => {
  const script = uiScript();
  const bridge = interfaceSource();
  for (const key of ["rawPrompts", "ordinaryConversation", "intakeRouting", "reasoningCycles", "validatorResponses", "ordinaryCompletions", "predictionEpisodes"]) {
    assert.match(script, new RegExp(key));
  }
  assert.match(script, /\/api\/memory\/admission/);
  assert.match(bridge, /app\.post\("\/api\/memory\/admission"/);
  assert.match(bridge, /normalizeMemoryAdmissionPolicy/);
});

test("background workspace polling does not rebuild open settings forms", () => {
  const script = uiScript();
  assert.match(script, /if \(\["tasks", "files", "rhythm"\]\.includes\(state\.view\)\) renderPanel\(state\.view\);/);
});

test("system UI configures and tests host-owned Playwright web tools", () => {
  const script = uiScript();
  const bridge = interfaceSource();
  assert.match(script, /\["web", "Web"\]/);
  assert.match(script, /renderWebConfiguration/);
  assert.match(script, /\/api\/browser\/config/);
  assert.match(script, /\/api\/browser\/test/);
  assert.match(bridge, /app\.post\("\/api\/browser\/config"/);
  assert.match(bridge, /app\.post\("\/api\/browser\/test"/);
});

test("workspace graph is isolated from Speck source files", () => {
  const bridge = interfaceSource();
  assert.match(bridge, /path\.join\(config\.genesisRuntimePath, "workspace"\)/);
  assert.doesNotMatch(bridge, /collectWorkspaceEntries\(options\.speckRoot\)/);
});

test("with voice on, every reply is spoken, in kept sentence chunks", () => {
  const script = uiScript();
  // Every reply is announced, typed or spoken, and voice speaks what is announced.
  assert.match(script, /new CustomEvent\("speck:reply"/);
  assert.match(script, /addEventListener\("speck:reply"/);
  // Chunked, every utterance kept (Chrome discards unreferenced ones), a
  // pause after cancelling, and a watchdog if the end never fires.
  assert.match(script, /export function speechChunks\(text\)/);
  assert.match(script, /state\.voice\.utterances = chunks\.map/);
  assert.match(script, /busy \? 150 : 0/);
  assert.match(script, /state\.voice\.speechWatchdog = setTimeout\(complete/);
});
