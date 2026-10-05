// Facts the user states about themselves: extracted on every turn, grounded in
// the user's words, validated by another role, and kept at the scope the user
// asked for (shared, this task only, or not at all).
import { disclosureExtractionContract, disclosureValidationContract, RECORD_FACT_TOOL, retentionCheckContract, retentionEvidenceContract } from "./contracts.js";
import { acceptedFacts, declarativeSentences, normalizedKey, quotedIn, stringList } from "./statements.js";
import { activeSharedMemories, actor, roleProcessor } from "./support.js";
export class FactRetention {
    runtime;
    view;
    constructor(runtime, view) {
        this.runtime = runtime;
        this.view = view;
    }
    // The facts the current message states, grounded in it. Only declarative
    // sentences assert anything: a turn made only of questions states no facts,
    // so no extraction is needed. An extraction that fails its contract
    // captures nothing; it never fails the turn.
    async extract(worker, processorId) {
        // Shortcut S1 (docs/COGNITIVE_SHORTCUTS.md).
        const statements = declarativeSentences(this.view.currentMessage(worker));
        if (!statements)
            return { facts: [], source: null };
        try {
            const extraction = await this.runtime.inferForWorker({
                workerId: worker.id, ...(processorId ? { processorId } : {}), contract: disclosureExtractionContract,
                contextScope: "minimal",
                instruction: `List the lasting facts the user states about themselves or their situation. Do not decide whether or where to store them.\nUSER STATEMENT:\n${this.view.currentMessage(worker)}`,
                tools: [RECORD_FACT_TOOL],
                system: "Call record_fact once for each lasting fact the user states about themselves or their situation. If the user states no such fact, reply without calling a tool. Do not answer the user.",
                nativeInstruction: `USER STATEMENT:\n${this.view.currentMessage(worker)}`,
                fromToolCalls: (calls) => ({
                    facts: calls.filter((call) => call.name === RECORD_FACT_TOOL.name).map((call) => String(call.arguments.fact ?? "").trim()).filter(Boolean)
                }),
                actor: actor("intake-fact-extraction")
            });
            const facts = (await this.groundedOnly(worker, stringList(extraction.response.structured?.facts, 8), statements)).map((decision) => decision.fact);
            return { facts, source: extraction.object };
        }
        catch {
            return { facts: [], source: null };
        }
    }
    async retain(worker, intake) {
        if (!intake.facts.length)
            return { facts: [], uncertain: [], memoryScope: "none", stored: [], source: null };
        const validation = await this.validateDisclosure(worker, intake);
        const { facts, uncertain, memoryScope } = validation;
        if (memoryScope === "none")
            return { facts, uncertain, memoryScope, stored: [], source: validation.source };
        const active = activeSharedMemories(this.runtime);
        const stored = [];
        for (const fact of facts) {
            // Shortcut S5 (docs/COGNITIVE_SHORTCUTS.md).
            const existing = active.find((memory) => normalizedKey(memory.content) === normalizedKey(fact));
            if (existing) {
                stored.push(existing);
                continue;
            }
            // Shortcut S2 (docs/COGNITIVE_SHORTCUTS.md).
            // An uncertain fact (the grounding signals disagree) is kept for the
            // task at lower confidence and never shared until it is corroborated.
            const isUncertain = uncertain.includes(fact);
            const confidence = isUncertain ? 0.5 : Math.max(0.65, Math.min(1, intake.confidence));
            const local = await this.runtime.recordMemory({
                workerId: worker.id, type: "semantic", content: fact, confidence, importance: 0.9,
                data: { verification: "validated-user-disclosure", grounding: isUncertain ? "uncertain" : "stated", sourceText: this.view.currentMessage(worker), intakeObjectId: intake.source?.id ?? null, validationObjectId: validation.source?.id ?? null },
                actor: { kind: "user", source: "speck-controller:fact-intake" }
            });
            stored.push(local);
            if (memoryScope === "shared" && !isUncertain) {
                stored.push(await this.runtime.recordSharedMemory({
                    type: "semantic", content: fact, sourceWorkerId: worker.id,
                    audience: ["intake", "planner", "worker"], confidence, importance: 0.9,
                    data: { verification: "validated-user-disclosure", sourceObjectId: local.id, sourceText: this.view.currentMessage(worker), validationObjectId: validation.source?.id ?? null },
                    actor: { kind: "user", source: "speck-controller:fact-intake" }
                }));
            }
        }
        return { facts, uncertain, memoryScope, stored, source: validation.source };
    }
    // A fact the user stated is made of what the user said: candidates and
    // their restatements must be grounded in the statement (see grounding.ts).
    async groundedOnly(worker, facts, statement) {
        const decisions = await this.runtime.groundFacts({ workerId: worker.id, facts, statement, actor: actor("grounding") });
        return decisions.filter((decision) => decision.grounded);
    }
    async validateDisclosure(worker, intake) {
        if (!intake.facts.length)
            return { facts: [], uncertain: [], memoryScope: "none", source: null };
        const processorId = roleProcessor(this.runtime, "worker");
        const statement = this.view.currentMessage(worker);
        try {
            const validation = await this.runtime.inferForWorker({
                workerId: worker.id, ...(processorId ? { processorId } : {}), contract: disclosureValidationContract,
                contextScope: "minimal",
                instruction: `Check each candidate against the user statement.\nUSER STATEMENT:\n${statement}\n\nCANDIDATES:\n${intake.facts.map((fact, index) => `${index + 1}. ${fact}`).join("\n")}`,
                actor: actor("disclosure-validator")
            });
            const grounded = await this.groundedOnly(worker, acceptedFacts(validation.response.structured?.facts, intake.facts.length), statement);
            const accepted = grounded.map((decision) => decision.fact);
            const uncertain = grounded.filter((decision) => decision.certainty === "uncertain").map((decision) => decision.fact);
            if (!accepted.length)
                return { facts: [], uncertain: [], memoryScope: "none", source: validation.object };
            const retention = await this.runtime.inferForWorker({
                workerId: worker.id, ...(processorId ? { processorId } : {}), contract: retentionEvidenceContract,
                contextScope: "minimal",
                instruction: `Read the user statement.\nUSER STATEMENT:\n${statement}`,
                actor: actor("retention-evidence")
            });
            const said = await this.corroboratedRetention(worker, retention.response, accepted);
            const memoryScope = said === "do not keep" ? "none" : said === "only for this task" ? "local" : "shared";
            await this.runtime.competeForWorkingMemory({
                workerId: worker.id, candidateIds: [validation.object.id, retention.object.id], actor: actor("disclosure-validator")
            });
            return { facts: [...new Set(accepted)], uncertain, memoryScope, source: validation.object };
        }
        catch {
            return { facts: [], uncertain: [], memoryScope: "none", source: null };
        }
    }
    // A claimed retention restriction counts only when corroborated by an
    // independent reader and by the user's own words. Readers are themselves
    // checked: each also reads a validated fact, which Speck knows asks for
    // nothing, and one that calls that a restriction cannot tell the difference
    // and is skipped. A trusted reader then either confirms the claimant's quoted
    // words restrict, or, when the claimant's evidence fails, reads the whole
    // statement and must quote words that are really there. Every check is
    // recorded as a judgment of the claimant or the reader.
    async corroboratedRetention(worker, response, facts) {
        const claimed = String(response.structured?.retention ?? "not mentioned");
        if (claimed === "not mentioned")
            return claimed;
        const statement = this.view.currentMessage(worker);
        const quote = String(response.structured?.quote ?? "").trim();
        const judged = { producerId: response.processorId, contract: retentionEvidenceContract.name, protocol: response.toolCalling ?? "json", aspect: "quality" };
        const present = quotedIn(quote, statement);
        this.runtime.recordJudgment({
            ...judged, evaluator: "deterministic", verdict: present ? "accepted" : "rejected",
            deterministicOutcome: present ? "quote-found" : "quote-not-in-statement", context: { claimed, quote }
        });
        const checkers = this.runtime.independentProcessors(response.processorId, retentionCheckContract.name);
        if (!checkers.length)
            return present ? claimed : "not mentioned"; // one model: only the observable check exists
        const trusted = await this.trustedRetentionReader(worker, checkers, facts[0]);
        if (!trusted) {
            // Shortcut S4 (docs/COGNITIVE_SHORTCUTS.md): no independent reader could
            // tell a restriction from a plain fact. Real cited words get the
            // protective reading: kept for this task, never shared.
            return present ? "only for this task" : "not mentioned";
        }
        try {
            if (present) {
                const reading = await this.readRetention(worker, trusted, quote);
                const restricts = reading !== "" && reading !== "not mentioned";
                this.runtime.recordJudgment({
                    ...judged, evaluator: trusted, verdict: restricts ? "accepted" : "rejected",
                    deterministicOutcome: null, context: { claimed, quote, checked: reading }
                });
                // The claimant saw the whole statement; the reader confirms only that
                // the words restrict at all.
                if (restricts)
                    return claimed;
            }
            // The claim's evidence failed: the trusted reader reads the whole
            // statement and must cite words that are there.
            const reread = await this.runtime.inferForWorker({
                workerId: worker.id, processorId: trusted, contract: retentionEvidenceContract, contextScope: "minimal",
                instruction: `Read the user statement.\nUSER STATEMENT:\n${statement}`,
                actor: actor("retention-reread")
            });
            const readAs = String(reread.response.structured?.retention ?? "not mentioned");
            const cited = quotedIn(String(reread.response.structured?.quote ?? ""), statement);
            return readAs !== "not mentioned" && cited ? readAs : "not mentioned";
        }
        catch {
            return "not mentioned";
        }
    }
    // Shortcut S4 (docs/COGNITIVE_SHORTCUTS.md): the validated fact is assumed to
    // ask for nothing about retention.
    // The first independent reader that reads a known plain fact as asking for
    // nothing; each control is recorded as a deterministic judgment of the reader.
    async trustedRetentionReader(worker, readers, control) {
        if (!control)
            return readers[0] ?? null;
        for (const readerId of readers) {
            try {
                const reading = await this.readRetention(worker, readerId, control);
                const discriminates = reading === "not mentioned";
                this.runtime.recordJudgment({
                    producerId: readerId, contract: retentionCheckContract.name, protocol: "json", aspect: "quality",
                    evaluator: "deterministic", verdict: discriminates ? "accepted" : "rejected",
                    deterministicOutcome: `control-read-as-${reading || "nothing"}`, context: { control }
                });
                if (discriminates)
                    return readerId;
            }
            catch { /* an unusable reading; try the next reader */ }
        }
        return null;
    }
    async readRetention(worker, processorId, words) {
        const check = await this.runtime.inferForWorker({
            workerId: worker.id, processorId, contract: retentionCheckContract, contextScope: "minimal",
            instruction: `QUOTED WORDS:\n"${words}"`,
            actor: actor("retention-check")
        });
        return String(check.response.structured?.retention ?? "");
    }
}
//# sourceMappingURL=facts.js.map