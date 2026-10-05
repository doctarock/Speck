// The contracts the controller's roles answer: what each model call may
// return. Data only; the calls are made by the collaborators that own them.
// The worker is asked only for the reply and one judgment about it. Whether a
// tool must act first is decided earlier by the Tool Caller, so the worker is
// never shown tools it might pretend to use.
export const replyContract = {
    name: "speck-worker-cycle",
    description: "reply: your message to the user. state: \"done\" if the reply completes the request; \"provisional\" if it gives the best answer the information so far supports while the user is expected to provide more; \"blocked\" only if no progress is possible without information that only the user can give.",
    required: ["reply", "state"],
    properties: {
        reply: { type: "string" },
        state: { type: "string", enum: ["done", "provisional", "blocked"] }
    },
    additionalProperties: false
};
// Asked only when Speck sees cognitive demand (see hypothesisDemand). The
// hypotheses are proposals: Speck records them and has another model check
// them against the evidence; they are never evidence themselves.
export const hypothesisGenerationContract = {
    name: "speck-hypotheses",
    description: "hypotheses: the candidate answers or explanations still possible given everything the user has said, one per item, including ones that compete with each other. Each must be specific enough to be checked against what the user says next.",
    required: ["hypotheses"],
    properties: {
        hypotheses: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
};
// An independent judgment of whether a reply may end the cycle by waiting.
export const waitValidationContract = {
    name: "speck-wait-validation",
    description: "reason: the concrete grounds for the verdict. justified: whether waiting for the user, as the reply does, is justified.",
    required: ["reason", "justified"],
    properties: {
        reason: { type: "string" },
        justified: { type: "boolean" }
    },
    additionalProperties: false
};
// The examples in a message, for deterministic induction. Extraction is a
// model's work; everything after it is Speck's.
export const exampleExtractionContract = {
    name: "speck-examples",
    description: "examples: each case in the message where an item is given a label or category, as {\"item\": the item exactly as written, \"label\": its label exactly as written}. Empty if there are none.",
    required: ["examples"],
    properties: { examples: { type: "array", items: { type: "object" } } },
    additionalProperties: false
};
// The conclusions a reply draws, read so Speck can hold each as a hypothesis
// (S30). Reading them is extraction; whether they hold is settled through
// their requirements.
export const replyClaimsContract = {
    name: "speck-reply-claims",
    description: "claims: each conclusion the reply draws that the user did not state (a cause, an explanation, who or what is responsible, or a prediction), one per item, stated so it stands alone. Empty if the reply only repeats what the user said, asks a question, or carries out the request.",
    required: ["claims"],
    properties: { claims: { type: "array", items: { type: "string" } } },
    additionalProperties: false
};
// What must be true if a hypothesis is, each a proposition one statement can
// settle: the units a qualified checker judges (S30). Written by the model
// that proposed the hypothesis.
export const requirementsContract = {
    name: "speck-hypothesis-requirements",
    description: "requirements: what must be true if the hypothesis is true, one per item. Each names one event or state at one time, so that a single statement could show it true or false.",
    required: ["requirements"],
    properties: { requirements: { type: "array", items: { type: "string" } } },
    additionalProperties: false
};
export const completionContract = {
    name: "speck-completion-validation",
    description: "reason: the concrete evidence for or against the answer. satisfied: true only when the answer itself contains the required result, does not contradict what the user said, does not claim actions that were not performed, and reads as a reply to the user.",
    // Fields are listed, and so generated, reason first: a verdict written
    // before its reasoning gets rationalized rather than reasoned.
    required: ["reason", "satisfied", "confidence"],
    properties: {
        reason: { type: "string" },
        satisfied: { type: "boolean" },
        confidence: { type: "number" }
    },
    additionalProperties: false
};
export const COMPLETION_EXPECTATION = "Independent validation confirms the proposed answer satisfies the objective.";
// Validation filters and restates candidates; it cannot introduce facts. Each
// kept fact names the candidate it came from, and Speck discards any that do
// not (see acceptedFacts).
export const disclosureValidationContract = {
    name: "speck-disclosure-validation",
    description: "Each item is {\"candidate\": the number of the candidate it comes from, \"fact\": that candidate restated so it stands alone, naming who or what it is about}. A candidate that states several facts becomes one item per fact. Keep only candidates that are lasting facts the user stated about themselves or their situation; leave out requests, questions, material given for the current task (examples, data, or content to work on), statements about the assistant, and anything the user did not say.",
    required: ["facts"],
    properties: {
        facts: { type: "array", items: { type: "object" } }
    },
    additionalProperties: false
};
// One plain-language choice about what the user said; the storage scope it
// implies is Speck policy (validateDisclosure).
// Shortcut S4 (docs/COGNITIVE_SHORTCUTS.md).
export const RETENTION_OPTIONS = ["not mentioned", "only for this task", "do not keep"];
// A restriction on retention is a claim about what the user said, so it must
// cite the user's words (quote first, then the verdict it supports).
export const retentionEvidenceContract = {
    name: "speck-retention-evidence",
    description: "quote: the user's own words about keeping or sharing what they told you, copied exactly from the statement. Not the information itself. Empty if the user says nothing about keeping or sharing it. retention: what those words ask for; \"not mentioned\" if the quote is empty.",
    required: ["quote", "retention"],
    properties: {
        quote: { type: "string" },
        retention: { type: "string", enum: [...RETENTION_OPTIONS] }
    },
    additionalProperties: false
};
// An independent reading of a quoted phrase, by a different model.
export const retentionCheckContract = {
    name: "speck-retention-check",
    description: "retention: what the quoted words ask for, about keeping the information they refer to.",
    required: ["retention"],
    properties: {
        retention: { type: "string", enum: [...RETENTION_OPTIONS] }
    },
    additionalProperties: false
};
// Intake makes one judgment: does the turn need work, and if so does it have
// several separable parts. Whether a non-task turn is a disclosure is not
// asked; Speck derives it from whether fact extraction finds anything.
export const intakeContract = {
    name: "speck-intake-route",
    description: "interaction: \"task\" when the user wants something done or wants information; \"conversation\" for greetings, small talk, thanks, or statements that ask for nothing. route: \"plan\" only when the task has several parts that could be done separately, otherwise \"direct\".",
    required: ["interaction", "route"],
    properties: {
        interaction: { type: "string", enum: ["task", "conversation"] },
        route: { type: "string", enum: ["direct", "plan"] }
    },
    additionalProperties: false
};
export const dialogueContract = {
    name: "speck-dialogue-turn",
    required: ["response"],
    properties: {
        response: { type: "string" }
    },
    additionalProperties: false
};
export const disclosureExtractionContract = {
    name: "speck-disclosure-extraction",
    description: "Each item is one fact the user explicitly stated: identity, preferences, relationships, possessions, or stable context. Return an empty list when the user states no such facts.",
    required: ["facts"],
    properties: {
        facts: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
};
// Where native tool calling is verified, each fact is one call of a recording
// function, the format such models are trained on.
export const RECORD_FACT_TOOL = {
    name: "record_fact",
    description: "Record one lasting fact the user stated about themselves or their situation.",
    parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] }
};
// Free-text tool arguments are written by the worker (see composeArguments).
export const composedArgumentContract = {
    name: "speck-tool-content",
    required: ["text"],
    properties: { text: { type: "string" } },
    additionalProperties: false
};
// The planner supplies the decomposition and its ordering only. Identifiers,
// priorities, and plan bookkeeping are assigned by Speck (normalizeSubtasks).
export const planContract = {
    name: "speck-parallel-plan",
    description: "Each subtask is {\"objective\": \"...\", \"after\": [numbers of earlier subtasks that must finish first]}. Number subtasks from 1 in the order listed.",
    required: ["subtasks"],
    properties: { subtasks: { type: "array", items: { type: "object" } } },
    additionalProperties: false
};
// How the user's reply relates to a task that is waiting for them with a
// provisional answer (see SpeckController.relationToTask).
export const continuationContract = {
    name: "speck-continuation",
    description: "relation: \"continues\" if the message carries the task on (more information, an answer, a question about it); \"closes\" if it ends the task (it is done, no longer needed, or the user thanks you or gives feedback on it); \"new\" if it asks for something unrelated.",
    required: ["relation"],
    properties: {
        relation: { type: "string", enum: ["continues", "closes", "new"] }
    },
    additionalProperties: false
};
// Whether a user's message judges the work, with the words that do; read by
// two models and recorded only when they agree (see recordUserVerdict).
export const feedbackContract = {
    name: "speck-feedback",
    description: "quote: the user's own words that judge your work as good or bad, copied exactly from the message; empty if the message does not judge the work (thanks alone, a new request, more information, a command). verdict: what those words say; \"neither\" if the quote is empty.",
    required: ["quote", "verdict"],
    properties: {
        quote: { type: "string" },
        verdict: { type: "string", enum: ["praise", "criticism", "neither"] }
    },
    additionalProperties: false
};
// Which open episode a message continues, when Speck's signals do not settle
// it (src/runtime/conversation.ts).
export const episodeContract = {
    name: "speck-episode",
    description: "episode: the number of the conversation the new message continues; 0 if it continues none of them and starts a new subject.",
    required: ["episode"],
    properties: { episode: { type: "number" } },
    additionalProperties: false
};
//# sourceMappingURL=contracts.js.map