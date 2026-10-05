// Conversation with Speck (one turn run to completion or a wait) and queue control.
import { parseWorkerId } from "../../types/ids.js";
import { SpeckController } from "../../runtime/controller.js";
import { Conversation } from "../../runtime/conversation.js";
import { toGenesisTask, resultSummary, waitingQuestion, agentResponse, errorMessage, failureResponse } from "../presentation.js";
import { createReadyWorker, recordConversationContinuation, isConversationCancellation, isConversationParking, canonicalizeVoiceMessage, processWorker } from "../tasks.js";
export function registerAgentRoutes(ctx) {
    const { app, runtime, config, options, state, archived, saveState, logClients, eventClients, workspaceRoot, inboxRoot, outboxRoot } = ctx;
    app.post("/api/agent/run", async (req, res) => {
        const startedAt = Date.now();
        let worker = null;
        try {
            const rawMessage = String(req.body?.message ?? "").trim();
            const message = req.body?.metadata?.transcribed === true
                ? canonicalizeVoiceMessage(rawMessage)
                : rawMessage;
            if (!message)
                throw new TypeError("message is required");
            const continuationId = String(req.body?.continuationTaskId ?? "").trim();
            if (continuationId) {
                const candidate = (() => {
                    try {
                        return runtime.getWorker(parseWorkerId(continuationId));
                    }
                    catch {
                        return null;
                    }
                })();
                if (candidate && isConversationCancellation(message)) {
                    worker = candidate;
                    const wasActive = !["completed", "failed", "suspended"].includes(candidate.status);
                    if (wasActive) {
                        worker = await runtime.transitionWorker(candidate.id, "suspended", { kind: "user", source: "genesis-gui:conversation", actorId: String(req.body?.sessionId ?? "Main") }, "Cancelled by the user during conversation");
                        await runtime.setWorldState({
                            workerId: worker.id,
                            key: "genesis.resultSummary",
                            value: "Cancelled. The previous request has been stopped.",
                            epistemicStatus: "observed",
                            confidence: 1,
                            actor: { kind: "user", source: "genesis-gui:conversation", actorId: String(req.body?.sessionId ?? "Main") }
                        });
                        worker = runtime.getWorker(worker.id);
                    }
                    const acknowledgement = wasActive
                        ? "Cancelled. The previous request has been stopped."
                        : "There is no active request to cancel.";
                    // Cancelling drops the thread too: its episode is closed, and the next
                    // message starts fresh or continues another episode.
                    new Conversation(runtime, String(req.body?.sessionId ?? "Main")).closeActive();
                    res.json(agentResponse(worker, acknowledgement, Date.now() - startedAt, "clear"));
                    return;
                }
                if (candidate && isConversationParking(message)) {
                    if (candidate.status === "waiting") {
                        const parked = await new SpeckController(runtime).parkTask(candidate.id, "Parked by the user");
                        res.json(agentResponse(parked.worker, "Parked. It is waiting in Tasks; press Resume there to pick it up again.", Date.now() - startedAt, "clear"));
                    }
                    else {
                        res.json(agentResponse(candidate, "There is no open request to park.", Date.now() - startedAt));
                    }
                    return;
                }
            }
            // Where the message belongs in the conversation (a waiting task it
            // answers, an episode it continues or extends, or a new episode) is
            // Speck's decision; the client's transcript is for display only.
            const sessionId = String(req.body?.sessionId ?? "Main");
            const conversation = new Conversation(runtime, sessionId, {
                create: (text) => createReadyWorker(runtime, text, sessionId, req.body?.brainId),
                continued: (task, text) => recordConversationContinuation(runtime, task, text, sessionId)
            });
            const received = await conversation.receive(message);
            if (received.route === "closed") {
                res.json(agentResponse(received.worker, received.summary ?? "", Date.now() - startedAt));
                return;
            }
            worker = received.worker;
            const completed = await processWorker(runtime, worker, state);
            const summary = resultSummary(completed)
                || (completed.status === "waiting" ? waitingQuestion(completed)
                    : completed.status === "failed" ? failureResponse(runtime, completed)
                        : "The request is continuing in Speck's persistent worker queue.");
            await conversation.replied(completed.id, summary);
            res.json(agentResponse(completed, summary, Date.now() - startedAt));
        }
        catch (error) {
            const current = worker ? runtime.getWorker(worker.id) : null;
            res.status(400).json({
                ok: false,
                error: errorMessage(error),
                ...(current ? { task: toGenesisTask(current) } : {})
            });
        }
    });
    // The conversation's threads (episodes), as Speck has placed each message.
    app.get("/api/conversation/episodes", (req, res) => {
        const conversation = new Conversation(runtime, String(req.query?.sessionId ?? "Main"));
        res.json({ ok: true, episodes: conversation.view() });
    });
    // The user moves a message to another thread, or to a new one: a correction
    // Speck keeps as a labelled example of where it placed the message wrongly.
    app.post("/api/conversation/move", async (req, res) => {
        try {
            const conversation = new Conversation(runtime, String(req.body?.sessionId ?? "Main"));
            const to = String(req.body?.to ?? "").trim();
            const moved = await conversation.move(String(req.body?.episodeId ?? ""), Number(req.body?.turnIndex), to === "new" ? "new" : to);
            res.json({ ok: true, from: moved.from.id, to: moved.to.id, episodes: conversation.view() });
        }
        catch (error) {
            res.status(400).json({ ok: false, error: errorMessage(error) });
        }
    });
    app.post("/api/queue/control", async (req, res) => {
        state.queuePaused = req.body?.paused === true;
        await saveState();
        res.json({ ok: true, queue: { paused: state.queuePaused }, message: `Queue ${state.queuePaused ? "paused" : "resumed"}.` });
    });
}
//# sourceMappingURL=agent.js.map