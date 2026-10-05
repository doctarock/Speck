import { ActivationGraph } from "../memory/graph.js";
import { bundleContextCoalitions } from "./coalitions.js";
export function estimateTokens(text, charsPerToken = 4) {
    return Math.ceil(text.length / Math.max(1, charsPerToken));
}
// World state that is not shown as WORLD STATE: Speck's own bookkeeping
// (speck.*), the run's settlement record, and what the controller already
// renders for each role in its own form (the conversation, the current
// message, the latest tool outcome). Shown raw as well, it would repeat the
// conversation, including Speck's superseded statements of its state.
const RENDERED_OR_INTERNAL_WORLD_STATE = /^(speck\.|genesis\.(conversationTurns|currentMessage|questionForUser|waitKind|resultSummary|lastRejectedReply|latestToolOutcome)$)/;
export function buildContextPacket(input) {
    const { worker, objects, config } = input;
    const graph = new ActivationGraph(objects);
    const byId = new Map(objects.map((object) => [object.id, object]));
    const workingObjects = worker.workingMemory.map((id) => byId.get(id)).filter((object) => Boolean(object));
    const coalitions = config.coalitionBundlingEnabled
        ? bundleContextCoalitions(graph, worker.workingMemory)
        : workingObjects.map((object) => ({ id: object.id, members: [object], score: object.workspace.attentionScore ?? object.activation.total }));
    const shownCoalitions = coalitions.filter((coalition) => coalition.members.some((member) => member.kind !== "reflection"));
    const active = (object) => object.status === "active" || object.status === "dormant";
    const resolve = (ids) => ids.map((id) => byId.get(id))
        .filter((object) => object !== undefined && active(object));
    const contract = input.expectedOutputContract?.trim() || "Return the next cognitive action as structured output.";
    const constraints = worker.objective.constraints.length > 0 ? ` Constraints: ${worker.objective.constraints.join("; ")}` : "";
    const worldEntries = Object.values(worker.worldState).filter((entry) => !RENDERED_OR_INTERNAL_WORLD_STATE.test(entry.key)).sort((a, b) => a.key.localeCompare(b.key));
    // Lifecycle status, scores, pressure, and a description of Speck's own
    // architecture are runtime bookkeeping; no model role needs them to judge
    // the objective, so they are not part of any model-facing context.
    const fullSections = [
        { name: "OBJECTIVE", entries: [`${worker.objective.description}${constraints}`], order: 0, priority: 100 },
        { name: "ACTIVE COMMITMENTS", entries: resolve(worker.commitments).filter((object) => object.data.status === "active").map(formatObject), order: 2, priority: 80 },
        { name: "WORKING MEMORY", entries: shownCoalitions.map(formatCoalition), order: 3, priority: 95 },
        { name: "RELEVANT SHARED MEMORY", entries: objects.filter((object) => active(object) && sharedImport(object)).sort(byImportance).map(formatSharedMemory), order: 4, priority: 96 },
        { name: "CURRENT BELIEFS", entries: resolve(worker.beliefs).sort(byConfidence).map(formatObject), order: 4, priority: 82 },
        { name: "CURRENT HYPOTHESES", entries: resolve(worker.hypotheses).filter((object) => !worker.beliefs.includes(object.id)).sort(byConfidence).map(formatObject), order: 5, priority: 75 },
        // Evidence in the order it arrived, each with when: the order is what
        // lets a reasoner see which evidence came later and what it changed.
        // Sorted by importance it was arbitrary, since evidence of equal
        // importance fell back to the order of its ids.
        { name: "EVIDENCE (oldest first)", entries: resolve(worker.evidence).sort(byArrival).map(formatEvidence), order: 6, priority: 70 },
        { name: "WORLD STATE", entries: worldEntries.map((entry) => `${entry.key} [${entry.epistemicStatus}, confidence=${entry.confidence}]: ${stableValue(entry.value)}`), order: 7, priority: 85 },
        { name: "AVAILABLE PROCEDURES", entries: objects.filter((object) => active(object) && object.kind === "procedure").sort(byImportance).map(formatObject), order: 8, priority: 55 },
        { name: "KNOWN ANSWERS", entries: objects.filter((object) => active(object) && object.kind === "known-answer").sort(byConfidence).map(formatObject), order: 9, priority: 72 },
        { name: "OPEN QUESTIONS", entries: resolve(worker.openQuestions).map(formatObject), order: 10, priority: 65 },
        { name: "RECENT PREDICTION ERRORS", entries: objects.filter((object) => active(object) && object.kind === "prediction" && predictionComparison(object)).sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt)).slice(0, 5).map(formatPrediction), order: 11, priority: 88 },
        { name: "RECENT TOOL RESULTS", entries: objects.filter((object) => active(object) && object.kind === "tool-outcome").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map(formatObject), order: 12, priority: 60 },
        { name: "ACTIVE IMPASSE", entries: resolve(worker.impasses).filter((object) => object.kind === "impasse" && object.data.status === "active").map(formatImpasse), order: 13, priority: 98 },
        { name: "COORDINATION", entries: worker.coordination ? [`plan=${worker.coordination.planId}; subtask=${worker.coordination.subtaskId}; planner=${worker.coordination.plannerWorkerId}`] : [], order: 14, priority: 94 },
        { name: "WORKER INBOX", entries: objects.filter((object) => active(object) && object.data.schema === "speck.worker-message.v1").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map(formatWorkerMessage), order: 15, priority: 92 }
    ];
    const contractSection = { name: "EXPECTED OUTPUT CONTRACT", entries: [contract], order: 16, priority: 101 };
    const proposed = input.scope === "minimal" ? [contractSection] : [...fullSections, contractSection];
    const budget = Math.max(1, Math.floor(input.tokenBudget ?? config.contextTokenBudget));
    const charBudget = budget * Math.max(1, config.charsPerToken);
    const allocated = [];
    let used = 0;
    let truncated = false;
    // A minimal-scope prompt is just the role's instruction; section headers and
    // bullet framing are internal structure the model does not need.
    const framed = input.scope !== "minimal";
    for (const section of [...proposed].sort((a, b) => b.priority - a.priority || a.order - b.order)) {
        if (section.entries.length === 0)
            continue;
        const prefix = allocated.length === 0 ? "" : "\n\n";
        const header = framed ? `${section.name}\n` : "";
        const body = section.entries.map((entry) => framed ? `- ${entry}` : entry).join("\n");
        const available = charBudget - used - prefix.length - header.length;
        if (available <= 0) {
            truncated = true;
            continue;
        }
        const fitted = body.length <= available ? body : truncate(body, available);
        if (fitted.length < body.length)
            truncated = true;
        allocated.push({
            ...section,
            entries: fitted.split("\n").map((line) => line.startsWith("- ") ? line.slice(2) : line),
            text: `${header}${fitted}`
        });
        used += prefix.length + header.length + fitted.length;
    }
    const ordered = allocated.sort((a, b) => a.order - b.order);
    const text = ordered.map((section) => section.text).join("\n\n");
    const includedCoalitions = shownCoalitions.slice(0, ordered.find((section) => section.name === "WORKING MEMORY")?.entries.length ?? 0);
    return {
        workerId: worker.id,
        sections: ordered.map(({ name, entries }) => ({ name, entries })),
        coalitions: coalitions.map((coalition) => ({
            id: coalition.id,
            memberIds: coalition.members.map((member) => member.id),
            score: coalition.score
        })),
        text,
        estimatedTokens: estimateTokens(text, config.charsPerToken),
        tokenBudget: budget,
        truncated,
        includedObjectIds: [...new Set(includedCoalitions.flatMap((coalition) => coalition.members.map((member) => member.id)))]
    };
}
// A model's raw response (a reflection) is a record of the call, not
// something any role is told: what Speck took from it is held in its own
// objects. Shown, it fed the writer the JSON of every reading and check,
// including a claim Speck had just rejected.
function formatCoalition(coalition) {
    return coalition.members.filter((member) => member.kind !== "reflection").map((member) => `${member.kind}: ${attributed(member)}`).join(" | ");
}
function formatObject(object) {
    return `${object.kind} [confidence=${object.confidence}, importance=${object.importance}]: ${attributed(object)}`;
}
// A fact the user disclosed may be in the user's own words ("I'm Dana"); its
// recorded provenance says who "I" is, so the context says it too.
function attributed(object) {
    return object.data.verification === "validated-user-disclosure" ? `user stated: ${object.content}` : object.content;
}
function formatSharedMemory(object) {
    const role = object.memoryRoles.includes("semantic") ? "semantic" : "episodic";
    const imported = sharedImport(object);
    return `${role} [scope=${String(imported.scope ?? "global")}, confidence=${object.confidence}, relevance=${Number(imported.relevance ?? 0).toFixed(3)}]: ${attributed(object)}`;
}
function sharedImport(object) {
    const value = object.data.sharedMemoryImport;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function formatPrediction(object) {
    const comparison = predictionComparison(object);
    return `${object.content} [verdict=${String(comparison.verdict)}, error=${Number(comparison.errorMagnitude)}, precision=${Number(comparison.precision)}]`;
}
function formatImpasse(object) {
    const reasons = Array.isArray(object.data.reasons) ? object.data.reasons.join(", ") : "unknown";
    const responses = Array.isArray(object.data.responses) ? object.data.responses.join(", ") : "none";
    return `${object.content} [reasons=${reasons}; ordered responses=${responses}]`;
}
function formatWorkerMessage(object) {
    return `${String(object.data.type)} from ${String(object.data.senderWorkerId)}: ${stableValue(object.data.payload ?? {})}`;
}
function predictionComparison(object) {
    const direct = object.data.predictionComparison;
    if (direct && typeof direct === "object" && !Array.isArray(direct))
        return direct;
    const prediction = object.data.prediction;
    if (!prediction || typeof prediction !== "object" || Array.isArray(prediction))
        return null;
    const comparison = prediction.comparison;
    return comparison && typeof comparison === "object" && !Array.isArray(comparison)
        ? comparison : null;
}
function byArrival(left, right) {
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
function formatEvidence(object) {
    return `evidence [received ${object.createdAt.replace(/\.\d+Z$/, "Z")}, confidence=${object.confidence}]: ${attributed(object)}`;
}
function byImportance(left, right) {
    return right.importance - left.importance || right.confidence - left.confidence || left.id.localeCompare(right.id);
}
function byConfidence(left, right) {
    return right.confidence - left.confidence || byImportance(left, right);
}
function stableValue(value) {
    if (typeof value === "string")
        return value;
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? String(value) : serialized;
    }
    catch {
        return String(value);
    }
}
function truncate(value, maxChars) {
    if (maxChars <= 0)
        return "";
    if (value.length <= maxChars)
        return value;
    if (maxChars === 1)
        return "…";
    return `${value.slice(0, maxChars - 1)}…`;
}
//# sourceMappingURL=builder.js.map