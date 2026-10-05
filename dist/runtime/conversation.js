// A conversation: the user's messages, grouped into episodes.
//
// Each message adds to the episode it continues, extends an earlier one, or
// starts a new one (see src/cognition/segmentation.ts). An episode holds one
// task, so what the task knows and believes carries across the episode's
// messages and is revised as more arrives; it sees only its own episode's
// messages, so an unrelated topic earlier in the conversation is not part of
// its problem. Used by the interface and by the comparison harness alike.
import { randomUUID } from "node:crypto";
import { assignEpisode, contentWords, dependsOnEarlier, marksShift, referents } from "../cognition/segmentation.js";
import { EmbeddingClient } from "../memory/embedding.js";
import { parseWorkerId } from "../types/ids.js";
import { SpeckController } from "./controller.js";
import { episodeContract } from "./controller/contracts.js";
import { roleProcessor } from "./controller/support.js";
// Episodes still open to be continued: the most recently active.
const OPEN_EPISODES = 8;
// Turns an episode's task is shown (as the interface keeps).
const EPISODE_TURNS = 12;
// The role that reads an ambiguous message's episode, chosen by measurement
// (docs/experiments/episodes/README.md).
const READING_ROLE = "intake";
export class Conversation {
    runtime;
    sessionId;
    hooks;
    constructor(runtime, sessionId, hooks = {}) {
        this.runtime = runtime;
        this.sessionId = sessionId;
        this.hooks = hooks;
    }
    open() {
        return this.runtime.episodes.forSession(this.sessionId, OPEN_EPISODES * 2).filter((episode) => episode.status === "open").slice(0, OPEN_EPISODES);
    }
    active() {
        return this.open()[0] ?? null;
    }
    // Places the user's message in an episode and readies the task to answer
    // it (or closes the task the message ends).
    async receive(message) {
        const controller = new SpeckController(this.runtime);
        const active = this.active();
        const activeTask = active?.taskId ? this.task(active.taskId) : null;
        // A reply to a task waiting on the user carries it on, closes it, or
        // moves on (S26); only moving on is a question of which episode.
        if (active && activeTask?.status === "waiting") {
            const relation = await controller.relationToTask(activeTask.id, message);
            const reply = { decision: "reply", by: "waiting-task", scores: [] };
            if (relation === "continues")
                return this.continueEpisode(active, activeTask, message, "continued", { ...await this.userTurn(message), placement: reply });
            if (relation === "closes") {
                await this.append(active, { ...await this.userTurn(message), placement: reply });
                await controller.recordUserVerdict(activeTask.id, message);
                const closed = await controller.closeTask(activeTask.id);
                await this.replied(active.id, closed.summary);
                return { episode: this.runtime.episodes.get(active.id), route: "closed", worker: closed.worker, summary: closed.summary };
            }
            await controller.parkTask(activeTask.id, "Set aside when the user moved on to something new");
        }
        // A message after a task finished may be feedback on it ("well done").
        if (activeTask?.status === "completed")
            await controller.recordUserVerdict(activeTask.id, message);
        const turn = await this.userTurn(message);
        const episodes = this.open();
        const profiles = episodes.map((episode, index) => ({
            id: episode.id, active: index === 0, referents: episode.referents,
            vectors: episode.turns.filter((entry) => entry.role === "user" && entry.vector).map((entry) => entry.vector)
        }));
        const decision = assignEpisode(turn.vector ?? null, referents(message), profiles, contentWords(message).length, marksShift(message), dependsOnEarlier(message));
        let chosen = null;
        let by = "signals";
        if (decision.kind === "continue") {
            chosen = episodes.find((episode) => episode.id === decision.episodeId) ?? null;
            if (decision.basis === "persistence")
                by = "persistence";
        }
        if (decision.kind === "ambiguous") {
            const read = await this.readEpisode(message, decision.candidates.map((id) => episodes.find((episode) => episode.id === id)).filter(Boolean));
            chosen = read.episode;
            by = read.by;
        }
        turn.placement = { decision: decision.kind, by, scores: decision.scores.map((entry) => ({ ...entry, meaning: round(entry.meaning), score: round(entry.score) })) };
        this.runtime.telemetry.increment(`conversation.episode.${decision.kind}.${by}`);
        if (chosen) {
            const route = chosen.id === active?.id ? "continued" : "extended";
            const task = chosen.taskId ? this.task(chosen.taskId) : await this.taskFor(chosen);
            if (task)
                return this.continueEpisode(this.runtime.episodes.get(chosen.id), task, message, route, turn);
        }
        return this.startEpisode(message, turn);
    }
    // The user moves a message (with Speck's reply to it) to another episode,
    // or to a new one. The message stops being evidence in the episode it
    // left; the episode it joins sees it from its task's next run. The move is
    // kept on the message with the scores Speck placed it by: a labelled
    // example of a misplacement.
    async move(fromId, turnIndex, to) {
        const from = this.runtime.episodes.get(fromId);
        const turn = from?.turns[turnIndex];
        if (!from || from.sessionId !== this.sessionId || turn?.role !== "user")
            throw new TypeError("Only a user message in this conversation can be moved");
        const target = to === "new" ? null : this.runtime.episodes.get(to);
        if (to !== "new" && (!target || target.sessionId !== this.sessionId || target.id === from.id))
            throw new TypeError("Unknown episode to move to");
        const reply = from.turns[turnIndex + 1]?.role === "assistant" ? from.turns[turnIndex + 1] : null;
        const moved = { ...turn, placement: { ...(turn.placement ?? { decision: "new", by: "signals", scores: [] }), correctedFrom: from.id } };
        const remaining = from.turns.filter((_, index) => index !== turnIndex && !(reply && index === turnIndex + 1));
        const now = new Date().toISOString();
        const left = {
            ...from, turns: remaining, status: remaining.some((entry) => entry.role === "user") ? from.status : "closed",
            referents: [...new Set(remaining.filter((entry) => entry.role === "user").flatMap((entry) => referents(entry.content)))]
        };
        const joined = target
            ? { ...target, status: "open", turns: [...target.turns, moved, ...(reply ? [reply] : [])].sort((a, b) => a.at.localeCompare(b.at)),
                referents: [...new Set([...target.referents, ...referents(turn.content)])], updatedAt: target.updatedAt > turn.at ? target.updatedAt : turn.at }
            : { id: randomUUID(), sessionId: this.sessionId, taskId: null, status: "open", createdAt: now, updatedAt: turn.at,
                turns: [moved, ...(reply ? [reply] : [])], referents: referents(turn.content) };
        this.runtime.episodes.save(left);
        this.runtime.episodes.save(joined);
        // The message is no longer evidence for the task it left.
        const leftTask = from.taskId ? this.task(from.taskId) : null;
        if (leftTask) {
            for (const evidence of this.runtime.mentalObjects.listForWorker(leftTask.id)) {
                if (evidence.kind === "evidence" && evidence.status !== "archived" && evidence.content === turn.content) {
                    await this.runtime.withdrawEvidence({ workerId: leftTask.id, evidenceId: evidence.id, reason: "The user moved the message to another thread", actor: { kind: "user", source: "speck-conversation" } });
                }
            }
            await this.setTurns(leftTask, remaining);
        }
        const joinedTask = joined.taskId ? this.task(joined.taskId) : null;
        if (joinedTask)
            await this.setTurns(joinedTask, joined.turns);
        this.runtime.telemetry.increment("conversation.episode.corrected");
        return { from: left, to: joined };
    }
    // The session's episodes for display: newest activity first, without the
    // meaning vectors.
    view() {
        const episodes = this.runtime.episodes.forSession(this.sessionId);
        const active = this.active()?.id;
        return episodes.map((episode) => ({
            ...episode, active: episode.id === active,
            taskStatus: episode.taskId ? this.task(episode.taskId)?.status ?? null : null,
            turns: episode.turns.map(({ vector: _vector, ...turn }) => turn)
        }));
    }
    // A task for an episode that has none yet, made from its first message.
    async taskFor(episode) {
        const first = episode.turns.find((turn) => turn.role === "user")?.content ?? "";
        const worker = this.hooks.create ? await this.hooks.create(first)
            : await this.runtime.transitionWorker((await this.runtime.createWorker(first)).id, "ready");
        this.runtime.episodes.save({ ...(this.runtime.episodes.get(episode.id) ?? episode), taskId: worker.id });
        return worker;
    }
    // Records Speck's reply in the episode the task belongs to.
    async replied(episodeOrTaskId, reply) {
        const episode = this.runtime.episodes.get(episodeOrTaskId) ?? this.runtime.episodes.forTask(episodeOrTaskId);
        if (!episode || !reply.trim())
            return;
        await this.append(episode, { role: "assistant", content: reply, at: new Date().toISOString() });
    }
    // Closes the active episode (the user cancelled it): it is no longer
    // continued, and the next message is judged against the others.
    closeActive() {
        const active = this.active();
        if (!active)
            return null;
        const closed = { ...active, status: "closed", updatedAt: new Date().toISOString() };
        this.runtime.episodes.save(closed);
        return closed;
    }
    async startEpisode(message, turn) {
        const worker = this.hooks.create ? await this.hooks.create(message)
            : await this.runtime.transitionWorker((await this.runtime.createWorker(message)).id, "ready");
        const now = new Date().toISOString();
        const episode = {
            id: randomUUID(), sessionId: this.sessionId, taskId: worker.id, status: "open",
            createdAt: now, updatedAt: now, turns: [turn], referents: referents(message)
        };
        this.runtime.episodes.save(episode);
        await this.setTurns(worker, []);
        return { episode, route: "new", worker: this.runtime.getWorker(worker.id) };
    }
    async continueEpisode(episode, task, message, route, turn) {
        const earlier = episode.turns;
        await this.append(episode, turn);
        let worker = task;
        if (worker.worldState["genesis.parked"]?.value) {
            await this.runtime.setWorldState({ workerId: worker.id, key: "genesis.parked", value: null, epistemicStatus: "observed", confidence: 1, actor: { kind: "user", source: "speck-conversation" } });
        }
        if (this.hooks.continued)
            await this.hooks.continued(worker, message);
        await this.setTurns(worker, earlier);
        await this.runtime.setWorldState({ workerId: worker.id, key: "genesis.currentMessage", value: message, epistemicStatus: "observed", confidence: 1, actor: { kind: "user", source: "speck-conversation" } });
        worker = this.runtime.getWorker(worker.id);
        if (worker.status !== "ready") {
            worker = await this.runtime.transitionWorker(worker.id, "ready", { kind: "user", source: "speck-conversation" }, worker.status === "completed" ? "Reopened: the user continued its episode" : "Conversation continued");
        }
        return { episode: this.runtime.episodes.get(episode.id), route, worker };
    }
    // The task sees its own episode's earlier turns as the conversation.
    async setTurns(worker, turns) {
        await this.runtime.setWorldState({
            workerId: worker.id, key: "genesis.conversationTurns",
            value: turns.slice(-EPISODE_TURNS).map(({ role, content }) => ({ role, content })),
            epistemicStatus: "observed", confidence: 1, actor: { kind: "user", source: "speck-conversation" }
        });
    }
    async append(episode, turn) {
        const current = this.runtime.episodes.get(episode.id) ?? episode;
        this.runtime.episodes.save({
            ...current, turns: [...current.turns, turn], updatedAt: turn.at,
            referents: turn.role === "user" ? [...new Set([...current.referents, ...referents(turn.content)])] : current.referents
        });
    }
    async userTurn(message) {
        const vector = (await this.embed([message]))?.[0];
        return { role: "user", content: message, at: new Date().toISOString(), ...(vector ? { vector } : {}) };
    }
    async embed(texts) {
        if (this.hooks.embed)
            return this.hooks.embed(texts);
        const config = this.runtime.config.embeddingRuntime;
        if (!config.enabled)
            return null;
        try {
            return await new EmbeddingClient().embed(config, texts, "document");
        }
        catch {
            return null;
        }
    }
    // When meaning and shared names do not settle it, the reading role is
    // shown the candidate episodes and says which one the message continues,
    // or none. Its answer must be one of the numbers it was shown; without a
    // usable answer the message continues the most likely candidate.
    async readEpisode(message, candidates) {
        if (!candidates.length)
            return { episode: null, by: "fallback" };
        const listed = candidates.map((episode, index) => `${index + 1}. ${summary(episode)}`).join("\n");
        try {
            const reading = await this.runtime.modelRegistry.infer({
                processorId: roleProcessor(this.runtime, this.hooks.readingRole ?? READING_ROLE), contract: episodeContract, temperature: 0, maxAttempts: 2,
                prompt: `Which conversation does the new message continue?\n${listed}\n0. None of these: it starts a new subject.\nNEW MESSAGE:\n${message}`
            });
            const chosen = Number(reading.structured?.episode);
            if (Number.isInteger(chosen) && chosen >= 0 && chosen <= candidates.length)
                return { episode: chosen === 0 ? null : candidates[chosen - 1], by: "reading" };
        }
        catch { /* falls back below */ }
        return { episode: candidates[0], by: "fallback" };
    }
    task(id) {
        try {
            return this.runtime.getWorker(parseWorkerId(id));
        }
        catch {
            return null;
        }
    }
}
function round(value) {
    return Math.round(value * 1000) / 1000;
}
// What an episode is about, for the reading role: how it began and where it
// is now, in the user's words.
function summary(episode) {
    const said = episode.turns.filter((turn) => turn.role === "user").map((turn) => turn.content.replace(/\s+/g, " "));
    const first = said[0]?.slice(0, 200) ?? "";
    const last = said.length > 1 ? ` … latest: ${said.at(-1).slice(0, 160)}` : "";
    return `${first}${last}`;
}
//# sourceMappingURL=conversation.js.map