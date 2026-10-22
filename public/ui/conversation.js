// Conversation with Speck from the quick composer.

import { state, $, jsonFetch } from "./core.js";
import { refreshWorkspace } from "./workspace.js";
import { renderThreadsPanel } from "./threads.js";

export async function submitTextRequest(request, metadata = {}) {
  showSpeckResponse("Thinking…", true);
  const conversation = state.conversation.slice(-12);
  const result = await jsonFetch("/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: request,
      sessionId: "Main",
      metadata,
      conversation,
      ...(state.activeConversationTaskId ? { continuationTaskId: state.activeConversationTaskId } : {})
    })
  });
  const text = result?.parsed?.result?.payloads?.map((payload) => payload?.text).filter(Boolean).join("\n")
    || result?.task?.resultSummary || "Your request is continuing in the workspace.";
  rememberConversation(request, text, result?.task);
  // After a cancel, or once the task is parked with its own thread, the
  // conversation starts fresh.
  if (result?.thread === "clear") startNewThread();
  showSpeckResponse(text, false);
  // Every reply is announced, whatever the message came from; voice speaks
  // it when voice is on.
  window.dispatchEvent(new CustomEvent("speck:reply", {
    detail: { text, expectsReply: result?.task?.status === "waiting_for_user" || /\?\s*$/.test(String(text || "")) }
  }));
  // The threads change with every message; the panel is refreshed here, not
  // by background polling, which would reset a move the user is choosing.
  if (state.view === "threads") await renderThreadsPanel();
  return result;
}

export function rememberConversation(request, response, task) {
  state.conversation = [
    ...state.conversation,
    { role: "user", content: String(request).trim() },
    { role: "assistant", content: String(response).trim() }
  ].filter((turn) => turn.content).slice(-12);
  state.activeConversationTaskId = task?.id ? String(task.id) : "";
  try {
    sessionStorage.setItem("speck.conversation", JSON.stringify(state.conversation));
    if (state.activeConversationTaskId) sessionStorage.setItem("speck.conversationTaskId", state.activeConversationTaskId);
    else sessionStorage.removeItem("speck.conversationTaskId");
  } catch { /* conversation still remains available for this page lifetime */ }
}

// Sets the conversation to a given thread (empty for a fresh one), and the
// task the next message continues.
export function setConversationThread(turns, taskId) {
  state.conversation = Array.isArray(turns) ? turns.slice(-12) : [];
  state.activeConversationTaskId = taskId ? String(taskId) : "";
  try {
    sessionStorage.setItem("speck.conversation", JSON.stringify(state.conversation));
    if (state.activeConversationTaskId) sessionStorage.setItem("speck.conversationTaskId", state.activeConversationTaskId);
    else sessionStorage.removeItem("speck.conversationTaskId");
  } catch { /* the thread still applies for this page lifetime */ }
}

export function startNewThread() {
  setConversationThread([], "");
}

export function showSpeckResponse(text, thinking = false) {
  const dock = $("#responseDock");
  dock.hidden = false;
  dock.classList.toggle("thinking", thinking);
  $("#responseText").textContent = text;
}

export async function submitQuickPrompt(event) {
  event.preventDefault();
  const input = $("#quickPrompt");
  const request = input.value.trim();
  if (!request) return;
  const button = $("#quickSendButton");
  button.disabled = true;
  input.disabled = true;
  try {
    await submitTextRequest(request, { source: "composer" });
    input.value = "";
    resizeQuickPrompt();
    await refreshWorkspace({ quiet: true });
  } catch (error) {
    showSpeckResponse(`I could not complete that request: ${error.message}`);
  } finally {
    button.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

export function resizeQuickPrompt() {
  const input = $("#quickPrompt");
  input.style.height = "auto";
  input.style.height = `${Math.min(140, input.scrollHeight)}px`;
}
