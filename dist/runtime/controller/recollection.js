// Bringing memory to bear: recall before each role acts, and recovery from an
// impasse by retrieving what was not yet active or consulting a higher tier.
import { actor } from "./support.js";
export class Recollection {
    runtime;
    view;
    constructor(runtime, view) {
        this.runtime = runtime;
        this.view = view;
    }
    async recall(worker, role) {
        const conversation = this.view.conversationText(worker);
        const recalled = await this.runtime.retrieveMemories({
            workerId: worker.id,
            query: `${worker.objective.description} ${conversation} ${role} ${worker.operationalState.mode}`,
            limit: 12,
            actor: actor("retrieval")
        });
        if (recalled.candidates.length) {
            await this.runtime.competeForWorkingMemory({ workerId: worker.id, candidateIds: recalled.candidates.map((candidate) => candidate.object.id), actor: actor("retrieval") });
        }
    }
    // Each impasse gets one recovery attempt per run (`attempted`); null when
    // no route recovered it.
    async recoverImpasse(worker, specialty, attempted) {
        const impasseId = worker.metacognition?.activeImpasseId;
        if (!impasseId || attempted.has(impasseId))
            return null;
        attempted.add(impasseId);
        const impasse = this.runtime.mentalObjects.get(impasseId);
        const recalled = await this.runtime.retrieveMemories({
            workerId: worker.id,
            query: `${worker.objective.description} ${impasse?.content ?? "impasse"} alternative evidence strategy`,
            excludedIds: worker.workingMemory, limit: 16, actor: actor("impasse-retrieval")
        });
        if (recalled.candidates.length) {
            const competed = await this.runtime.competeForWorkingMemory({
                workerId: worker.id, candidateIds: recalled.candidates.map((candidate) => candidate.object.id),
                actor: actor("impasse-retrieval")
            });
            if (competed.newlyAdmitted.length) {
                const resolved = (await this.runtime.resolveImpasse({
                    workerId: worker.id, impasseId,
                    resolution: `Retrieved ${competed.newlyAdmitted.length} previously inactive memory candidates.`,
                    nextStatus: "ready", actor: actor("impasse-retrieval")
                })).worker;
                return this.runtime.transitionWorker(resolved.id, "executing", actor("impasse-recovery"), "Retrying with retrieved evidence");
            }
        }
        if (this.runtime.config.modelEscalation.enabled) {
            try {
                const consultation = await this.runtime.consultOnImpasse({
                    workerId: worker.id, impasseId, ...(specialty ? { specialty } : {}),
                    actor: actor("impasse-escalation")
                });
                if (consultation.status === "completed") {
                    const resolved = (await this.runtime.resolveImpasse({
                        workerId: worker.id, impasseId, resolution: `Consulted ${consultation.toProcessorId}.`,
                        nextStatus: "ready", actor: actor("impasse-escalation")
                    })).worker;
                    return this.runtime.transitionWorker(resolved.id, "executing", actor("impasse-recovery"), "Retrying after model consultation");
                }
            }
            catch { /* no eligible higher tier is an exhausted recovery route */ }
        }
        return null;
    }
}
//# sourceMappingURL=recollection.js.map