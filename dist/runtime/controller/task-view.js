// A read-only view of a task as its roles see it: the message being answered,
// the original request, the earlier conversation, and Speck's own record of
// what was done.
import { hypothesisKey } from "./statements.js";
// The sentences Speck has added to replies from its state, oldest first.
export const STATED_BY_SPECK = "speck.statedBySpeck";
export class TaskView {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    // The message being answered: in a continued conversation the user's latest
    // message, otherwise the objective the task began with.
    currentMessage(worker) {
        const value = this.runtime.getWorker(worker.id)?.worldState["genesis.currentMessage"]?.value;
        return typeof value === "string" && value.trim() ? value.trim() : worker.objective.description;
    }
    // The task's original request, shown when the current message is a
    // follow-up to it.
    taskContext(worker) {
        const current = this.currentMessage(worker);
        return current === worker.objective.description ? "" : `\nTASK (the user's original request):\n${worker.objective.description}`;
    }
    conversationText(worker) {
        const value = worker.worldState["genesis.conversationTurns"]?.value;
        if (!Array.isArray(value))
            return "";
        return value.slice(-12).map((turn) => {
            if (!turn || typeof turn !== "object")
                return "";
            const assistant = turn.role === "assistant";
            const content = String(turn.content ?? "").trim();
            const said = assistant ? this.writerPart(worker, content) : content;
            return said ? `${assistant ? "Assistant" : "User"}: ${said}` : "";
        }).filter(Boolean).join("\n");
    }
    // What the writer said in an earlier assistant turn: the turn without the
    // sentences Speck added from its state at the time (S24). Those are
    // superseded by the current state, which the roles are shown directly; as
    // conversation they would be copied, stale.
    writerPart(worker, content) {
        const added = this.runtime.getWorker(worker.id)?.worldState[STATED_BY_SPECK]?.value;
        let said = content;
        for (const statement of Array.isArray(added) ? added : []) {
            if (typeof statement === "string" && statement)
                said = said.split(statement).join("");
        }
        return said.trim();
    }
    // What the user said earlier in the conversation, without the replies: a
    // judge of a reply needs the statements it must agree with, and the
    // earlier replies are not evidence. The original request and the current
    // message are shown on their own.
    earlierUserMessages(worker) {
        const value = this.runtime.getWorker(worker.id)?.worldState["genesis.conversationTurns"]?.value;
        const shown = new Set([this.currentMessage(worker), worker.objective.description]);
        const said = (Array.isArray(value) ? value : [])
            .filter((turn) => turn && typeof turn === "object" && turn.role === "user")
            .map((turn) => String(turn.content ?? "").trim())
            .filter((content) => content && !shown.has(content))
            .slice(-12);
        return said.length ? `\nWHAT THE USER SAID EARLIER (oldest first):\n${said.map((content) => `- ${content}`).join("\n")}` : "";
    }
    conversationInstruction(worker) {
        const transcript = this.conversationText(worker);
        // Earlier turns explain a follow-up; they are not the request, and an
        // earlier answer is not verified knowledge.
        return transcript ? `\nEarlier conversation, for context (oldest first):\n${transcript}` : "";
    }
    // Speck's own record of what was executed. The validator cannot otherwise
    // tell a reported action from an imagined one.
    performedOperations(worker) {
        const outcomes = this.operations(worker).map((object) => object.content);
        return outcomes.length ? `\n${outcomes.map((content) => `- ${content}`).join("\n")}` : "none";
    }
    // The tool outcomes this task recorded, oldest first.
    operations(worker) {
        return this.runtime.mentalObjects.listAll()
            .filter((object) => object.workerId === worker.id && object.kind === "tool-outcome")
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    latestToolOutcomeInstruction(worker) {
        const value = worker.worldState["genesis.latestToolOutcome"]?.value;
        if (!value || typeof value !== "object")
            return "";
        return `\nLatest verified tool outcome (authoritative):\n${JSON.stringify(value)}`;
    }
    // What the Tool Caller needs to judge whether another operation is still
    // required: the conversation and Speck's record of what already ran.
    toolSituation(worker) {
        const latest = this.runtime.getWorker(worker.id)?.worldState["genesis.latestToolOutcome"]?.value;
        const rejected = latest?.status === "invalid-intent" ? `\nLAST PROPOSAL REJECTED:\n${String(latest.error ?? "")}` : "";
        const lastValidation = this.runtime.getWorker(worker.id)?.worldState["genesis.lastRejectedReply"]?.value;
        const rejectedReply = typeof lastValidation === "string" && lastValidation ? `\nLAST REPLY REJECTED BECAUSE:\n${lastValidation}` : "";
        return `${this.conversationInstruction(worker).trim()}\nALREADY DONE: ${this.performedOperations(worker)}${rejected}${rejectedReply}`.trim();
    }
    // Shortcut S20 (docs/COGNITIVE_SHORTCUTS.md): whether a reply repeats, word
    // for word, an earlier assistant turn that answered a different message.
    repeatsEarlierReply(worker, reply) {
        const turns = this.runtime.getWorker(worker.id)?.worldState["genesis.conversationTurns"]?.value;
        if (!Array.isArray(turns))
            return false;
        const key = hypothesisKey(reply);
        const current = hypothesisKey(this.currentMessage(worker));
        for (let index = 0; index < turns.length; index += 1) {
            const turn = turns[index];
            if (turn?.role !== "assistant" || hypothesisKey(this.writerPart(worker, String(turn.content ?? ""))) !== key)
                continue;
            const asked = turns.slice(0, index).reverse().find((earlier) => earlier?.role === "user");
            if (!asked || hypothesisKey(String(asked.content ?? "")) !== current)
                return true;
        }
        return false;
    }
}
//# sourceMappingURL=task-view.js.map