// Intake: classifying the user's turn, and answering a turn that asks for no
// work (conversation, or a disclosure of facts).
import { dialogueContract, intakeContract } from "./contracts.js";
import { beyondExamples, isInductionItem } from "../../cognition/induction.js";
import { joinNaturally, quotedIn } from "./statements.js";
import { actor, roleProcessor } from "./support.js";
// What intake recorded about the current message's task material.
export const MESSAGE_MATERIAL = "speck.messageMaterial";
export function intakeDecision(observed) {
    const interaction = observed.interaction === "conversation" ? "conversation" : "task";
    return { interaction, route: interaction === "task" && observed.route === "plan" ? "plan" : "direct" };
}
export class Intake {
    runtime;
    view;
    facts;
    settlement;
    induction;
    constructor(runtime, view, facts, settlement, induction) {
        this.runtime = runtime;
        this.view = view;
        this.facts = facts;
        this.settlement = settlement;
        this.induction = induction;
    }
    async route(worker) {
        const processorId = roleProcessor(this.runtime, "intake");
        const inferred = await this.runtime.inferForWorker({
            workerId: worker.id, ...(processorId ? { processorId } : {}), contract: intakeContract,
            contextScope: "minimal",
            instruction: `Classify the user turn below. Do not reply to it.${this.view.taskContext(worker)}\nUser turn: ${this.view.currentMessage(worker)}${this.view.conversationInstruction(worker)}`,
            actor: actor("intake")
        });
        const observed = inferred.response.structured;
        const route = intakeDecision(observed);
        await this.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: [inferred.object.id], actor: actor("intake") });
        const intakeObservation = {
            workerId: worker.id,
            content: `Intake selected ${route.route} routing.`,
            data: { cognitiveRole: "intake", route: route.route, interaction: route.interaction, observed },
            confidence: inferred.response.confidence, importance: 0.45, actor: actor("intake-observation")
        };
        if (this.runtime.memoryAdmissionPolicy.intakeRouting) {
            await this.runtime.recordMemory({ ...intakeObservation, type: "episodic" });
        }
        else {
            await this.runtime.createMentalObject({ ...intakeObservation, kind: "observation", memoryRoles: [] });
        }
        let interaction = route.interaction;
        const specialty = interaction === "task" ? await this.specialty(worker, processorId) : "general";
        // What the user told us is captured on every turn, independently of what
        // they want done.
        const extracted = await this.facts.extract(worker, processorId);
        // Shortcut S25 (docs/COGNITIVE_SHORTCUTS.md): a message that gives
        // labelled examples is material for one task, whatever else it seems to
        // be. Its examples are not facts about the user, and it is not a plan.
        const material = await this.taskMaterial(worker, processorId);
        const facts = extracted.facts.filter((fact) => !material.some((example) => quotedIn(example.item, fact)));
        if (material.length)
            interaction = "task";
        else if (interaction === "conversation" && facts.length)
            interaction = "disclosure";
        // The planner splits the task's original request. A follow-up routed to
        // it re-planned the whole task and left the follow-up itself unanswered
        // (the causal test, 2026-10-03: "The restart command completed
        // successfully" became subtasks such as "Identify the time when the
        // server went offline"), so only the request that opens a task is planned.
        const followUp = this.view.currentMessage(worker) !== worker.objective.description;
        return {
            route: route.route === "plan" && !material.length && !followUp ? "plan" : "direct",
            specialty,
            interaction,
            response: "",
            facts,
            source: extracted.source ?? inferred.object,
            confidence: inferred.response.confidence
        };
    }
    // The labelled examples in the current message, read by the extraction
    // role and kept only for items induction can describe; recorded with
    // whether the message is nothing but those examples (see ToolStep).
    async taskMaterial(worker, processorId) {
        const message = this.view.currentMessage(worker);
        // Only a message with a number can name an item induction describes.
        const pairs = /\d/.test(message) ? await this.induction.readLabelledPairs(worker, processorId, message, "the user's message") : [];
        const examples = (pairs ?? []).filter((pair) => isInductionItem(pair.item));
        await this.runtime.setWorldState({
            workerId: worker.id, key: MESSAGE_MATERIAL,
            value: { message, examples, examplesOnly: examples.length > 0 && !beyondExamples(message, examples) },
            epistemicStatus: "observed", confidence: 1, actor: actor("intake")
        });
        return examples;
    }
    // The configured specialty that best matches the task, or general.
    async specialty(worker, processorId) {
        const configuredSpecialties = Object.keys(this.runtime.config.modelRuntime.roles.specialists);
        if (!configuredSpecialties.length)
            return "general";
        const specialtyContract = {
            name: "speck-intake-specialty",
            description: "Choose the single configured specialty that best matches the task, or general when none applies.",
            required: ["specialty"],
            properties: { specialty: { type: "string", enum: ["general", ...configuredSpecialties] } },
            additionalProperties: false
        };
        const selected = await this.runtime.inferForWorker({
            workerId: worker.id, ...(processorId ? { processorId } : {}), contract: specialtyContract,
            contextScope: "minimal",
            instruction: `Classify only the task specialty.\nUser turn: ${this.view.currentMessage(worker)}`,
            actor: actor("intake-specialty")
        });
        await this.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: [selected.object.id], actor: actor("intake-specialty") });
        return String(selected.response.structured?.specialty ?? "general");
    }
    async completeDialogueTurn(worker, intake, retained) {
        const { facts, memoryScope, stored } = retained;
        const storedSomething = facts.length > 0 && memoryScope !== "none";
        if (intake.interaction === "conversation" || !storedSomething) {
            const reply = await this.converse(worker);
            const response = reply.response || "I’m here. What would you like to talk about?";
            if (intake.interaction === "disclosure" && memoryScope === "none" && facts.length) {
                // The user asked that nothing be kept; say so rather than stay silent.
                return this.settlement.complete(worker, `${response} I have not kept any of it.`, reply.source ?? intake.source, "User disclosure acknowledged without persistence", "conversation", false);
            }
            return this.settlement.complete(worker, response, intake.source, "Conversational turn completed", "conversation", this.runtime.memoryAdmissionPolicy.ordinaryConversation, this.runtime.memoryAdmissionPolicy.ordinaryConversation);
        }
        // Shortcut S3 (docs/COGNITIVE_SHORTCUTS.md).
        const acknowledgement = "Thanks for telling me.";
        const describe = (list) => {
            const display = list.map((fact) => fact.replace(/[.!?]+$/g, ""));
            return list.length === 1 ? `this fact: ${display[0]}` : `these ${list.length} facts: ${joinNaturally(display)}`;
        };
        const confident = facts.filter((fact) => !retained.uncertain.includes(fact));
        const parts = [];
        if (confident.length) {
            parts.push(`I stored ${describe(confident)} in ${memoryScope === "shared"
                ? "persistent shared memory for my intake, planner, and worker roles" : "this task’s local memory"}.`);
        }
        if (retained.uncertain.length) {
            parts.push(`I kept ${describe(retained.uncertain)} for this task only, until it is confirmed.`);
        }
        const summary = `${acknowledgement} ${parts.join(" ")}`;
        return this.settlement.complete(worker, summary, stored[0] ?? intake.source, "User disclosure stored", "memory", false);
    }
    // A generated reply for a social turn. Disclosures that were stored do not
    // need one: Speck states what it stored, which is all the reply has to say.
    async converse(worker) {
        const processorId = roleProcessor(this.runtime, "intake");
        try {
            const dialogue = await this.runtime.inferForWorker({
                workerId: worker.id, ...(processorId ? { processorId } : {}), contract: dialogueContract,
                contextScope: "minimal",
                instruction: `Reply naturally to the user turn below. Use only what the user said; do not add details about them, and do not say that anything was stored.\nUser turn: ${this.view.currentMessage(worker)}${this.view.conversationInstruction(worker)}`,
                actor: actor("intake-dialogue")
            });
            await this.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: [dialogue.object.id], actor: actor("intake-dialogue") });
            return { response: String(dialogue.response.structured?.response ?? "").trim(), source: dialogue.object };
        }
        catch {
            return { response: "", source: null };
        }
    }
}
//# sourceMappingURL=intake.js.map