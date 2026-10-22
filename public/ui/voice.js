// Voice: recognition, wake words, end-of-request detection, and speech output.

import { state, VOICE_SILENCE_MS, $, escapeHtml } from "./core.js";
import { refreshWorkspace } from "./workspace.js";
import { submitTextRequest, resizeQuickPrompt } from "./conversation.js";

export function initializeVoice() {
  initializeVoiceOutput();
  // With voice on, Speck speaks every reply: typed messages as well as
  // spoken ones.
  window.addEventListener("speck:reply", (event) => {
    const { text: answer, expectsReply } = event.detail || {};
    if (state.voice.enabled && answer) speakVoice(answer, expectsReply);
  });
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  state.voice.supported = typeof Recognition === "function";
  if (!state.voice.supported) {
    $("#voiceButton").disabled = true;
    $("#composerVoiceButton").disabled = true;
    $("#voiceButton").title = "Speech recognition is not available in this browser";
    $("#composerVoiceButton").title = "Speech recognition is not available in this browser";
    $("#voiceButtonLabel").textContent = "Voice unavailable";
    return;
  }
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  state.voice.recognition = recognition;
  window.dispatchEvent(new CustomEvent("observer:voice:recognition-configure", {
    detail: { recognition, defaultLang: recognition.lang, navigatorLanguage: navigator.language || "", at: Date.now() }
  }));
  recognition.onstart = () => {
    state.voice.listening = true;
    updateVoiceUi(state.voice.capturing ? "Listening for your request…" : "Say “Speck” to begin.");
  };
  recognition.onresult = handleVoiceResults;
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      state.voice.enabled = false;
      updateVoiceUi("Microphone access was denied.", true);
      return;
    }
    if (!state.voice.speaking && event.error !== "aborted") updateVoiceUi(`Voice error: ${event.error}`, true);
  };
  recognition.onend = () => {
    state.voice.listening = false;
    if (state.voice.capturing) {
      if (state.voice.interimText.trim()) {
        state.voice.finalText = mergeVoiceText(state.voice.finalText, state.voice.interimText);
        state.voice.interimText = "";
        $("#quickPrompt").value = state.voice.finalText;
        resizeQuickPrompt();
      }
      if (state.voice.finalText.trim()) scheduleVoiceSubmission();
    }
    updateVoiceButton();
    if (state.voice.enabled && !state.voice.speaking) {
      clearTimeout(state.voice.restartTimer);
      state.voice.restartTimer = setTimeout(startVoiceRecognition, 350);
    }
  };
}

export function initializeVoiceOutput() {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance !== "function") {
    return;
  }
  const refresh = () => refreshVoiceOptions();
  refresh();
  window.speechSynthesis.addEventListener?.("voiceschanged", refresh);
}

export function bindVoiceConfiguration() {
  const select = $("#voiceSelect");
  const preview = $("#voicePreviewButton");
  if (!select || !preview) return;
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance !== "function") {
    select.disabled = true;
    preview.disabled = true;
    return;
  }
  refreshVoiceOptions();
  select.addEventListener("change", () => {
    state.voice.voiceName = select.value;
    try { localStorage.setItem("speck.voiceName", state.voice.voiceName); } catch { /* preference remains active for this page */ }
  });
  preview.addEventListener("click", () => speakVoice("Hello, I'm Speck. This is how I'll sound."));
}

export function refreshVoiceOptions() {
  const select = $("#voiceSelect");
  if (!("speechSynthesis" in window)) return;
  const voices = window.speechSynthesis.getVoices().slice()
    .sort((left, right) => voiceScore(right) - voiceScore(left) || left.name.localeCompare(right.name));
  state.voice.voices = voices;
  if (!select) return;
  if (!voices.length) {
    select.innerHTML = "<option>Waiting for browser voices…</option>";
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const remembered = voices.find((voice) => voice.name === state.voice.voiceName);
  const selected = remembered || voices[0];
  state.voice.voiceName = selected.name;
  select.innerHTML = voices.map((voice) => `<option value="${escapeHtml(voice.name)}" ${voice.name === selected.name ? "selected" : ""}>${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}${voice.localService ? "" : " · natural/online"}</option>`).join("");
}

export function voiceScore(voice) {
  const browserLanguage = String(navigator.language || "en-US").toLowerCase();
  const language = String(voice.lang || "").toLowerCase();
  const name = String(voice.name || "");
  let score = voice.default ? 10 : 0;
  if (language === browserLanguage) score += 80;
  else if (language.split("-")[0] === browserLanguage.split("-")[0]) score += 35;
  if (/natural|neural|premium|enhanced/i.test(name)) score += 140;
  if (/natasha|aria|sonia|jenny|samantha|karen|moira|serena/i.test(name)) score += 55;
  if (/david|mark|zira|desktop|compact/i.test(name)) score -= 20;
  return score;
}

export function selectedSpeechVoice() {
  if (!("speechSynthesis" in window)) return null;
  if (!state.voice.voices.length) refreshVoiceOptions();
  return state.voice.voices.find((voice) => voice.name === state.voice.voiceName) || state.voice.voices[0] || null;
}

export function toggleVoice() {
  if (!state.voice.supported) return;
  state.voice.enabled = !state.voice.enabled;
  if (state.voice.enabled) {
    startVoiceRecognition();
    updateVoiceUi("Say “Speck” to begin.");
  } else {
    resetVoiceCapture();
    stopVoiceRecognition();
    $("#voiceBubble").hidden = true;
  }
  updateVoiceButton();
}

export function startVoiceRecognition() {
  if (!state.voice.enabled || state.voice.listening || state.voice.speaking || !state.voice.recognition) return;
  try { state.voice.recognition.start(); } catch { /* browser is already transitioning */ }
}

export function stopVoiceRecognition() {
  clearTimeout(state.voice.restartTimer);
  if (!state.voice.recognition || !state.voice.listening) return;
  try { state.voice.recognition.stop(); } catch { /* recognition already stopped */ }
}

export function handleVoiceResults(event) {
  let interim = "";
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = canonicalizeVoiceTranscript(result[0]?.transcript);
    if (!transcript) continue;
    window.dispatchEvent(new CustomEvent("observer:voice-transcript", {
      detail: { text: transcript, isFinal: result.isFinal === true, mode: state.voice.capturing ? "listening" : "passive", wakeActive: state.voice.capturing, at: Date.now() }
    }));
    if (!state.voice.capturing) {
      const afterWake = voiceWakeRemainder(transcript);
      if (afterWake === null) continue;
      state.voice.capturing = true;
      noteVoiceActivity();
      state.voice.finalText = result.isFinal ? afterWake : "";
      updateVoiceUi(afterWake || "Listening…");
      if (result.isFinal && afterWake) scheduleVoiceSubmission();
      continue;
    }
    noteVoiceActivity();
    if (result.isFinal) handleFinalVoiceTranscript(transcript);
    else interim = `${interim} ${stripVoiceWake(transcript)}`.trim();
  }
  state.voice.interimText = interim;
  if (state.voice.capturing && interim) {
    const preview = mergeVoiceText(state.voice.finalText, interim);
    updateVoiceUi(preview);
    $("#quickPrompt").value = preview;
    resizeQuickPrompt();
  }
}

export function canonicalizeVoiceTranscript(value) {
  return String(value || "").trim().replace(/\bspec\b/gi, "Speck");
}

export function handleFinalVoiceTranscript(transcript) {
  state.voice.finalText = mergeVoiceText(state.voice.finalText, stripVoiceWake(transcript));
  state.voice.interimText = "";
  updateVoiceUi(state.voice.finalText || "Listening…");
  $("#quickPrompt").value = state.voice.finalText;
  resizeQuickPrompt();
  if (endsVoiceRequest(state.voice.finalText)) finishVoiceRequest();
  else scheduleVoiceSubmission();
}

export function voiceWakeRemainder(transcript) {
  const match = String(transcript || "").match(/(?:^|\s)(?:(?:hey|okay)\s+)?(?:speck|spec)(?:\s|$)/i);
  return match ? transcript.slice((match.index || 0) + match[0].length).trim() : null;
}

export function stripVoiceWake(transcript) {
  return String(transcript || "").replace(/^\s*(?:(?:hey|okay)\s+)?(?:speck|spec)\b[\s,.:;-]*/i, "").trim();
}

export function scheduleVoiceSubmission() {
  clearTimeout(state.voice.submitTimer);
  const quietFor = Date.now() - (state.voice.lastActivityAt || Date.now());
  const remaining = Math.max(250, VOICE_SILENCE_MS - quietFor);
  state.voice.submitTimer = setTimeout(() => {
    const quietFor = Date.now() - (state.voice.lastActivityAt || Date.now());
    if (!state.voice.capturing || !state.voice.finalText.trim()) return;
    if (quietFor < VOICE_SILENCE_MS) {
      scheduleVoiceSubmission();
      return;
    }
    finishVoiceRequest();
  }, remaining);
}

export function noteVoiceActivity() {
  state.voice.lastActivityAt = Date.now();
  clearTimeout(state.voice.submitTimer);
}

export function normalizeVoiceText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
}

export function mergeVoiceText(left, right) {
  const first = String(left || "").trim();
  const second = String(right || "").trim();
  if (!first) return second;
  if (!second) return first;
  const leftWords = first.split(/\s+/);
  const rightWords = second.split(/\s+/);
  const comparable = (word) => word.toLowerCase().replace(/[^a-z0-9']/g, "");
  let overlap = 0;
  for (let size = Math.min(leftWords.length, rightWords.length); size > 0; size -= 1) {
    const tail = leftWords.slice(-size).map(comparable).join(" ");
    const head = rightWords.slice(0, size).map(comparable).join(" ");
    if (tail && tail === head) { overlap = size; break; }
  }
  return [...leftWords, ...rightWords.slice(overlap)].join(" ");
}

export function endsVoiceRequest(value) {
  return /(?:\bthank\s+you\b|\bthanks\s+speck\b|\bsubmit\b)[.!?\s]*$/i.test(String(value || ""));
}

export async function finishVoiceRequest() {
  const request = state.voice.finalText.replace(/(?:\bthank\s+you\b|\bthanks\s+speck\b|\bsubmit\b)[.!?\s]*$/i, "").trim();
  clearTimeout(state.voice.submitTimer);
  $("#quickPrompt").value = request;
  resizeQuickPrompt();
  resetVoiceCapture();
  if (!request) {
    updateVoiceUi("Nothing was submitted.");
    return;
  }
  updateVoiceUi(`Submitting: ${request}`);
  try {
    // The reply is spoken when it is announced (see initializeVoice).
    await submitTextRequest(request, { source: "voice", transcribed: true });
    await refreshWorkspace({ quiet: true });
  } catch (error) {
    updateVoiceUi(`Voice submission failed: ${error.message}`, true);
    speakVoice("I could not add that request.");
  }
}

export function resetVoiceCapture() {
  clearTimeout(state.voice.submitTimer);
  state.voice.capturing = false;
  state.voice.finalText = "";
  state.voice.interimText = "";
  state.voice.lastActivityAt = 0;
  updateVoiceButton();
}

// Speech is queued sentence by sentence. Chrome stalls on long utterances,
// silently drops one queued straight after cancel(), and discards utterances
// nothing references (so their end never fires and Speck would think it is
// still speaking, leaving the microphone off). So: short chunks, a pause
// after cancelling, every utterance kept, and a watchdog in case the end
// never comes.
export function speakVoice(text, expectReply = false) {
  if (!("speechSynthesis" in window) || !text) return;
  const chunks = speechChunks(text);
  if (!chunks.length) return;
  const synth = window.speechSynthesis;
  const generation = (state.voice.speechGeneration || 0) + 1;
  state.voice.speechGeneration = generation;
  state.voice.speaking = true;
  stopVoiceRecognition();
  const busy = synth.speaking || synth.pending;
  if (busy) synth.cancel();
  let finished = false;
  const complete = () => {
    if (finished || state.voice.speechGeneration !== generation) return;
    finished = true;
    clearTimeout(state.voice.speechWatchdog);
    state.voice.utterances = [];
    state.voice.speaking = false;
    if (state.voice.enabled) {
      if (expectReply) {
        state.voice.capturing = true;
        state.voice.finalText = "";
        state.voice.interimText = "";
        updateVoiceUi("Listening for your reply…");
      }
      setTimeout(startVoiceRecognition, 180);
    }
  };
  const voice = selectedSpeechVoice();
  setTimeout(() => {
    if (state.voice.speechGeneration !== generation) return;
    state.voice.utterances = chunks.map((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || navigator.language || "en-US";
      utterance.rate = 0.96;
      utterance.pitch = 1.02;
      if (index === chunks.length - 1) utterance.onend = complete;
      utterance.onerror = complete;
      return utterance;
    });
    state.voice.utterances.forEach((utterance) => synth.speak(utterance));
    // About 12 characters a second at this rate, with slack.
    clearTimeout(state.voice.speechWatchdog);
    state.voice.speechWatchdog = setTimeout(complete, 4000 + chunks.join(" ").length * 110);
  }, busy ? 150 : 0);
}

// The reply as it should be heard: Markdown removed, in chunks of whole
// sentences of at most about 180 characters.
export function speechChunks(text) {
  const plain = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^\s*(?:[-•]|\d+\.)\s+/gm, "")
    .replace(/[*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  const chunks = [];
  for (const sentence of sentences.map((part) => part.trim()).filter(Boolean)) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + sentence.length < 180) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}

export function updateVoiceUi(message, error = false) {
  updateVoiceButton();
  const bubble = $("#voiceBubble");
  bubble.hidden = !state.voice.enabled;
  $("#voiceBubbleState").textContent = error ? "Voice error" : state.voice.capturing ? "Listening" : "Voice ready";
  $("#voiceBubbleText").textContent = message;
  bubble.style.borderColor = error ? "rgba(255,142,170,.35)" : "";
}

export function updateVoiceButton() {
  [$("#voiceButton"), $("#composerVoiceButton")].filter(Boolean).forEach((button) => {
    button.classList.toggle("listening", state.voice.enabled && !state.voice.capturing);
    button.classList.toggle("capturing", state.voice.capturing);
    button.setAttribute("aria-pressed", String(state.voice.enabled));
  });
  $("#voiceButtonLabel").textContent = state.voice.capturing ? "Listening" : state.voice.enabled ? "Voice on" : "Voice off";
}
