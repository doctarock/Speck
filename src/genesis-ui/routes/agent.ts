// Conversation with Speck on its default path (src/speck/respond.ts): the
// model's ordinary chat answers every message, and Speck adds only its
// measured components. The earlier worker pipeline (episodes, tasks, the
// controller cycle) is archived in failed work/pipeline-2026-10-20.

import path from "node:path";
import { respond } from "../../speck/respond.js";
import { defaultPathDependencies } from "../../speck/configure.js";
import { SessionStore } from "../../speck/session.js";
import { admittedComponents } from "../../speck/components/index.js";
import { chatResponse, errorMessage } from "../presentation.js";
import { isConversationCancellation, canonicalizeVoiceMessage } from "../tasks.js";
import { UiContext } from "../context.js";

export function registerAgentRoutes(ctx: UiContext): void {
  const { app, config, state, saveState } = ctx;
  const sessions = new SessionStore(path.join(path.dirname(config.databasePath), "sessions"));

  app.post("/api/agent/run", async (req, res) => {
    const startedAt = Date.now();
    try {
      const rawMessage = String(req.body?.message ?? "").trim();
      const message = req.body?.metadata?.transcribed === true ? canonicalizeVoiceMessage(rawMessage) : rawMessage;
      if (!message) throw new TypeError("message is required");
      const sessionId = String(req.body?.sessionId ?? "Main");
      if (isConversationCancellation(message)) {
        sessions.clear(sessionId);
        res.json(chatResponse("Cleared. We can start fresh.", Date.now() - startedAt, "plain", "clear"));
        return;
      }
      const session = sessions.load(sessionId);
      const answered = await respond(session, message, { ...defaultPathDependencies(ctx.config, ctx.runtime.modelRegistry, ctx.runtime), components: admittedComponents(state.components) });
      sessions.save(session);
      res.json(chatResponse(answered.reply, Date.now() - startedAt, answered.path));
    } catch (error) {
      res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  // One thread per session on the default path (episodes are archived).
  app.get("/api/conversation/episodes", (req, res) => {
    const session = sessions.load(String(req.query?.sessionId ?? "Main"));
    const turns = session.turns.map((turn) => ({ role: turn.role, content: turn.content }));
    res.json({ ok: true, episodes: turns.length ? [{ id: session.id, sessionId: session.id, status: "open", active: true, taskStatus: null, turns, referents: [] }] : [] });
  });

  app.post("/api/conversation/move", (_req, res) => {
    res.status(410).json({ ok: false, error: "Moving messages between threads belonged to the archived episode pipeline (failed work/pipeline-2026-10-20)." });
  });

  app.post("/api/queue/control", async (req, res) => {
    state.queuePaused = req.body?.paused === true;
    await saveState();
    res.json({ ok: true, queue: { paused: state.queuePaused }, message: `Queue ${state.queuePaused ? "paused" : "resumed"}.` });
  });
}
