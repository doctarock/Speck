import { SpeckError } from "../errors.js";
import { parseMentalObjectId, parseWorkerId } from "../types/ids.js";
import { EDGE_KINDS, WORKER_STATUSES } from "../types/model.js";
import { STANDARD_TASK_SUITE } from "../benchmark/suites.js";
import { createStandardVariants } from "../benchmark/ablations.js";
import { BENCHMARK_HARNESS_VERSION } from "../benchmark/harness.js";
export function registerSpeckRoutes(app, runtime, prefix = "/api/speck") {
    app.use(prefix, (req, res, next) => {
        if (req.path.endsWith("/background/run"))
            return next();
        const release = runtime.beginForegroundWork();
        res.once("finish", release);
        res.once("close", release);
        return next();
    });
    app.get(`${prefix}/status`, (_req, res) => res.json({
        ok: true, phase: 13,
        workerCount: runtime.listWorkers().length,
        memoryActivation: runtime.config.memoryActivation,
        contextEngine: runtime.config.contextEngine,
        predictiveLoop: runtime.config.predictiveLoop,
        beliefRevision: runtime.config.beliefRevision,
        metacognition: runtime.config.metacognition,
        modelEscalation: runtime.config.modelEscalation,
        tierResources: runtime.tierScheduler.snapshot(),
        procedures: runtime.config.procedures,
        coordination: runtime.config.coordination,
        backgroundCognition: runtime.config.backgroundCognition,
        embeddingRuntime: runtime.config.embeddingRuntime,
        backgroundState: { active: runtime.backgroundScheduler.backgroundActive, foregroundActive: runtime.backgroundScheduler.foregroundActive },
        sharedMemory: {
            total: runtime.mentalObjects.listAll().filter((object) => object.workerId === null && object.data.sharedMemory && object.status !== "archived").length,
            episodic: runtime.mentalObjects.listAll().filter((object) => object.workerId === null && object.data.sharedMemory && object.status !== "archived" && object.memoryRoles.includes("episodic")).length,
            semantic: runtime.mentalObjects.listAll().filter((object) => object.workerId === null && object.data.sharedMemory && object.status !== "archived" && object.memoryRoles.includes("semantic")).length
        },
        benchmarkHarness: { version: BENCHMARK_HARNESS_VERSION, standardTasks: STANDARD_TASK_SUITE.length },
        models: runtime.modelRegistry.list(),
        tools: runtime.toolRegistry.list(),
        telemetry: runtime.telemetry.snapshot(), llmRequired: false
    }));
    app.get(`${prefix}/workers`, (req, res) => {
        try {
            const status = optionalStatus(req.query.status);
            res.json({ ok: true, workers: runtime.listWorkers(status) });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers`, async (req, res) => {
        try {
            const worker = await runtime.createWorker(String(req.body?.objective ?? ""), arrayOfStrings(req.body?.constraints), {
                kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null
            });
            res.status(201).json({ ok: true, worker });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/workers/:id`, (req, res) => {
        try {
            const id = parseWorkerId(req.params.id ?? "");
            const worker = runtime.getWorker(id);
            if (!worker)
                return res.status(404).json({ ok: false, error: `Worker ${id} was not found`, code: "NOT_FOUND" });
            return res.json({ ok: true, worker });
        }
        catch (error) {
            return sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/transition`, async (req, res) => {
        try {
            const status = requiredStatus(req.body?.status);
            const worker = await runtime.transitionWorker(parseWorkerId(req.params.id ?? ""), status, {
                kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null
            }, String(req.body?.reason ?? ""));
            res.json({ ok: true, worker });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/events`, (req, res) => {
        try {
            const workerId = req.query.workerId ? parseWorkerId(String(req.query.workerId)) : undefined;
            const events = runtime.listEvents(workerId, Number(req.query.after ?? 0), Number(req.query.limit ?? 100));
            res.json({ ok: true, events });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/telemetry`, (_req, res) => res.json({ ok: true, telemetry: runtime.telemetry.snapshot() }));
    app.get(`${prefix}/models`, (_req, res) => res.json({ ok: true, models: runtime.modelRegistry.list() }));
    app.get(`${prefix}/shared-memory`, (req, res) => {
        const type = String(req.query.type ?? "").trim();
        const memories = runtime.mentalObjects.listAll().filter((object) => object.workerId === null && object.status !== "archived"
            && object.data.sharedMemory && (!type || object.memoryRoles.includes(type)));
        res.json({ ok: true, memories });
    });
    app.post(`${prefix}/shared-memory`, async (req, res) => {
        try {
            const type = String(req.body?.type ?? "semantic");
            const memory = await runtime.recordSharedMemory({
                type,
                content: String(req.body?.content ?? ""),
                ...(req.body?.scope ? { scope: String(req.body.scope) } : {}),
                ...(req.body?.scopeKey === undefined ? {} : { scopeKey: String(req.body.scopeKey) }),
                ...(Array.isArray(req.body?.audience) ? { audience: req.body.audience.map(String) } : {}),
                ...(objectValue(req.body?.data) ? { data: objectValue(req.body?.data) } : {}),
                ...(optionalNumber(req.body?.confidence) === undefined ? {} : { confidence: optionalNumber(req.body?.confidence) }),
                ...(optionalNumber(req.body?.importance) === undefined ? {} : { importance: optionalNumber(req.body?.importance) }),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, memory });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/shared-memory/recall`, async (req, res) => {
        try {
            const role = String(req.body?.role ?? "worker");
            const memories = await runtime.retrieveSharedMemories({
                query: String(req.body?.query ?? ""),
                role,
                ...(optionalNumber(req.body?.limit) === undefined ? {} : { limit: optionalNumber(req.body?.limit) })
            });
            res.json({ ok: true, memories });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.delete(`${prefix}/shared-memory/:id`, async (req, res) => {
        try {
            const memory = await runtime.archiveSharedMemory(parseMentalObjectId(req.params.id ?? ""), {
                kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null
            });
            res.json({ ok: true, memory });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/procedures`, (_req, res) => res.json({
        ok: true,
        procedures: runtime.mentalObjects.listAll().filter((object) => object.kind === "procedure")
    }));
    app.get(`${prefix}/memory/:id`, (req, res) => {
        try {
            const id = parseMentalObjectId(req.params.id ?? "");
            const memory = runtime.mentalObjects.get(id);
            if (!memory)
                return res.status(404).json({ ok: false, error: `Memory ${id} was not found`, code: "NOT_FOUND" });
            return res.json({ ok: true, memory });
        }
        catch (error) {
            return sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/workers/:id/cognition`, (req, res) => {
        try {
            res.json({ ok: true, cognition: runtime.getCognitiveState(parseWorkerId(req.params.id ?? "")) });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/workers/:id/state`, (req, res) => {
        try {
            res.json({ ok: true, state: runtime.getCognitiveState(parseWorkerId(req.params.id ?? "")) });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    for (const [path, field] of [
        ["working-memory", "workingMemory"], ["beliefs", "beliefs"], ["commitments", "commitments"]
    ]) {
        app.get(`${prefix}/workers/:id/${path}`, (req, res) => {
            try {
                const cognition = runtime.getCognitiveState(parseWorkerId(req.params.id ?? ""));
                res.json({ ok: true, [field]: cognition[field] });
            }
            catch (error) {
                sendSpeckError(error, res);
            }
        });
    }
    app.get(`${prefix}/workers/:id/trace`, (req, res) => {
        try {
            const workerId = parseWorkerId(req.params.id ?? "");
            const events = runtime.listEvents(workerId, Number(req.query.after ?? 0), Number(req.query.limit ?? 500));
            res.json({ ok: true, workerId, events });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/workers/:id/why/:eventId`, (req, res) => {
        try {
            const workerId = parseWorkerId(req.params.id ?? "");
            const events = runtime.listEvents(workerId, 0, 1000);
            const byId = new Map(events.map((event) => [event.id, event]));
            const event = events.find((candidate) => candidate.id === String(req.params.eventId ?? ""));
            if (!event)
                return res.status(404).json({ ok: false, error: `Event ${req.params.eventId} was not found`, code: "NOT_FOUND" });
            const causes = [];
            let cursor = event;
            const visited = new Set();
            while (cursor.causationId && !visited.has(cursor.causationId)) {
                visited.add(cursor.causationId);
                const cause = byId.get(cursor.causationId);
                if (!cause)
                    break;
                causes.push(cause);
                cursor = cause;
            }
            return res.json({ ok: true, event, causes });
        }
        catch (error) {
            return sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/memories`, async (req, res) => {
        try {
            const memory = await runtime.recordMemory({
                workerId: parseWorkerId(req.params.id ?? ""), type: req.body?.type,
                content: String(req.body?.content ?? ""), data: objectValue(req.body?.data),
                confidence: optionalNumber(req.body?.confidence), importance: optionalNumber(req.body?.importance),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, memory });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/working-memory/:objectId`, async (req, res) => {
        try {
            const worker = await runtime.admitToWorkingMemory(parseWorkerId(req.params.id ?? ""), parseMentalObjectId(req.params.objectId ?? ""), { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null });
            res.json({ ok: true, worker });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/working-memory/competition/run`, async (req, res) => {
        try {
            const candidateIds = arrayOfStrings(req.body?.candidateIds).map(parseMentalObjectId);
            const signals = objectValue(req.body?.signals);
            const result = await runtime.competeForWorkingMemory({
                workerId: parseWorkerId(req.params.id ?? ""),
                ...(candidateIds.length ? { candidateIds } : {}),
                ...(signals ? { signals } : {}),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/context`, (req, res) => {
        try {
            const tokenBudget = optionalNumber(req.body?.tokenBudget);
            const packet = runtime.buildContext({
                workerId: parseWorkerId(req.params.id ?? ""),
                ...(req.body?.expectedOutputContract === undefined ? {} : { expectedOutputContract: String(req.body.expectedOutputContract) }),
                ...(tokenBudget === undefined ? {} : { tokenBudget })
            });
            res.json({ ok: true, packet });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/models`, (_req, res) => res.json({ ok: true, models: runtime.modelRegistry.list() }));
    app.post(`${prefix}/workers/:id/model`, async (req, res) => {
        try {
            const worker = await runtime.assignModelProcessor(parseWorkerId(req.params.id ?? ""), String(req.body?.processorId ?? ""), { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null });
            res.json({ ok: true, worker });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/infer`, async (req, res) => {
        try {
            const tokenBudget = optionalNumber(req.body?.tokenBudget);
            const temperature = optionalNumber(req.body?.temperature);
            const result = await runtime.inferForWorker({
                workerId: parseWorkerId(req.params.id ?? ""),
                ...(req.body?.processorId ? { processorId: String(req.body.processorId) } : {}),
                ...(req.body?.specialty ? { specialty: String(req.body.specialty) } : {}),
                ...(req.body?.contract ? { contract: structuredContract(req.body.contract) } : {}),
                ...(tokenBudget === undefined ? {} : { tokenBudget }),
                ...(temperature === undefined ? {} : { temperature }),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/tools`, (_req, res) => res.json({ ok: true, tools: runtime.toolRegistry.list() }));
    app.post(`${prefix}/workers/:id/tool-intents`, async (req, res) => {
        try {
            const result = await runtime.proposeToolIntent({
                workerId: parseWorkerId(req.params.id ?? ""),
                request: String(req.body?.request ?? ""),
                ...(req.body?.processorId ? { processorId: String(req.body.processorId) } : {}),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/tools/execute`, async (req, res) => {
        try {
            const intentValue = objectValue(req.body?.intent);
            if (!intentValue)
                throw new TypeError("intent is required");
            const args = objectValue(intentValue.arguments) ?? {};
            const approved = req.body?.authorization?.approved === true;
            const approvedBy = String(req.body?.authorization?.approvedBy ?? "").trim();
            const permissions = arrayOfStrings(req.body?.authorization?.permissions);
            const result = await runtime.executeToolIntent({
                workerId: parseWorkerId(req.params.id ?? ""),
                intent: {
                    intent: String(intentValue.intent ?? ""),
                    target: intentValue.target == null ? null : String(intentValue.target),
                    arguments: args,
                    expectedOutcome: String(intentValue.expectedOutcome ?? "")
                },
                ...(approved || approvedBy || permissions.length ? { authorization: { approved, approvedBy, permissions } } : {}),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/predictions`, async (req, res) => {
        try {
            const spec = objectValue(req.body?.spec);
            if (!spec)
                throw new TypeError("spec is required");
            const prediction = await runtime.createPrediction({
                workerId: parseWorkerId(req.params.id ?? ""),
                spec: spec,
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, prediction });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/predictions/:predictionId/compare`, async (req, res) => {
        try {
            const result = await runtime.comparePredictionToObservation({
                workerId: parseWorkerId(req.params.id ?? ""),
                predictionId: parseMentalObjectId(req.params.predictionId ?? ""),
                observationId: parseMentalObjectId(String(req.body?.observationId ?? "")),
                ...(req.body?.actual === undefined ? {} : { actual: req.body.actual }),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/memories/:objectId/reference`, async (req, res) => {
        try {
            const memory = await runtime.reinforceMemoryReference(parseWorkerId(req.params.id ?? ""), parseMentalObjectId(req.params.objectId ?? ""), { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null });
            res.json({ ok: true, memory });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/associations`, async (req, res) => {
        try {
            const association = await runtime.reinforceAssociation({
                workerId: parseWorkerId(req.params.id ?? ""),
                sourceId: parseMentalObjectId(String(req.body?.sourceId ?? "")),
                targetId: parseMentalObjectId(String(req.body?.targetId ?? "")),
                kind: requiredEdgeKind(req.body?.kind ?? "associative"),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, source: association });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/recall`, async (req, res) => {
        try {
            const limit = optionalNumber(req.body?.limit);
            const anchorIds = arrayOfStrings(req.body?.anchorIds).map(parseMentalObjectId);
            const excludedIds = arrayOfStrings(req.body?.excludedIds).map(parseMentalObjectId);
            const result = await runtime.retrieveMemories({
                workerId: parseWorkerId(req.params.id ?? ""),
                ...(String(req.body?.query ?? "").trim() ? { query: String(req.body.query).trim() } : {}),
                ...(anchorIds.length ? { anchorIds } : {}),
                ...(excludedIds.length ? { excludedIds } : {}),
                ...(limit === undefined ? {} : { limit }),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/domain-anchors/link`, async (req, res) => {
        try {
            const result = await runtime.linkMemoryToDomain({
                workerId: parseWorkerId(req.params.id ?? ""),
                objectId: parseMentalObjectId(String(req.body?.objectId ?? "")),
                domain: String(req.body?.domain ?? ""), key: String(req.body?.key ?? ""),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, ...result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/domain-anchors/recall`, async (req, res) => {
        try {
            const limit = optionalNumber(req.body?.limit);
            const result = await runtime.retrieveDomainMemories({
                workerId: parseWorkerId(req.params.id ?? ""),
                domain: String(req.body?.domain ?? ""), key: String(req.body?.key ?? ""),
                ...(limit === undefined ? {} : { limit }),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/commitments`, async (req, res) => {
        try {
            const commitment = await runtime.createCommitment({
                workerId: parseWorkerId(req.params.id ?? ""), content: String(req.body?.content ?? ""),
                priority: req.body?.priority,
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, commitment });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.patch(`${prefix}/workers/:id/commitments/:objectId`, async (req, res) => {
        try {
            const commitment = await runtime.updateCommitment(parseWorkerId(req.params.id ?? ""), parseMentalObjectId(req.params.objectId ?? ""), req.body?.status, { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null });
            res.json({ ok: true, commitment });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.put(`${prefix}/workers/:id/world-state/:key`, async (req, res) => {
        try {
            const entry = await runtime.setWorldState({
                workerId: parseWorkerId(req.params.id ?? ""), key: req.params.key ?? "", value: req.body?.value,
                epistemicStatus: String(req.body?.epistemicStatus ?? "unknown"),
                confidence: optionalNumber(req.body?.confidence), observedAt: req.body?.observedAt,
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, entry });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/evidence`, async (req, res) => {
        try {
            const evidence = await runtime.recordEvidence({
                workerId: parseWorkerId(req.params.id ?? ""), content: String(req.body?.content ?? ""),
                source: String(req.body?.source ?? ""), reliability: optionalNumber(req.body?.reliability),
                supports: arrayOfStrings(req.body?.supports).map(parseMentalObjectId),
                contradicts: arrayOfStrings(req.body?.contradicts).map(parseMentalObjectId),
                relations: evidenceRelations(req.body?.relations),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, evidence });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/workers/:id/hypotheses`, (req, res) => {
        try {
            res.json({ ok: true, hypotheses: runtime.rankHypotheses(parseWorkerId(req.params.id ?? "")) });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/evidence/:evidenceId/relations`, async (req, res) => {
        try {
            const result = await runtime.reviseHypothesesFromEvidence({
                workerId: parseWorkerId(req.params.id ?? ""),
                evidenceId: parseMentalObjectId(req.params.evidenceId ?? ""),
                relations: evidenceRelations(req.body?.relations),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/hypotheses`, async (req, res) => {
        try {
            const hypothesis = await runtime.proposeHypothesis({
                workerId: parseWorkerId(req.params.id ?? ""), content: String(req.body?.content ?? ""),
                confidence: optionalNumber(req.body?.confidence),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, hypothesis });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/workers/:id/impasses`, (req, res) => {
        try {
            const state = runtime.getCognitiveState(parseWorkerId(req.params.id ?? ""));
            res.json({ ok: true, impasses: state.impasses });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/impasses/:impasseId/resolve`, async (req, res) => {
        try {
            const result = await runtime.resolveImpasse({
                workerId: parseWorkerId(req.params.id ?? ""),
                impasseId: parseMentalObjectId(req.params.impasseId ?? ""),
                resolution: String(req.body?.resolution ?? ""),
                ...(req.body?.nextStatus ? { nextStatus: requiredStatus(req.body.nextStatus) } : {}),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/impasses/:impasseId/consult`, async (req, res) => {
        try {
            const minimumContextSize = optionalNumber(req.body?.minimumContextSize);
            const result = await runtime.consultOnImpasse({
                workerId: parseWorkerId(req.params.id ?? ""),
                impasseId: parseMentalObjectId(req.params.impasseId ?? ""),
                ...(req.body?.specialty ? { specialty: String(req.body.specialty) } : {}),
                ...(minimumContextSize === undefined ? {} : { minimumContextSize }),
                ...(req.body?.instruction ? { instruction: String(req.body.instruction) } : {}),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(result.status === "deferred" ? 409 : 200).json({ ok: result.status === "completed", result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/calibration/outcomes`, async (req, res) => {
        try {
            const reportedConfidence = optionalNumber(req.body?.reportedConfidence);
            const reward = optionalNumber(req.body?.reward);
            if (reportedConfidence === undefined || reward === undefined)
                throw new TypeError("reportedConfidence and reward are required");
            const result = await runtime.recordModelOutcome({
                workerId: parseWorkerId(req.params.id ?? ""),
                processorId: String(req.body?.processorId ?? ""),
                reportedConfidence,
                reward,
                ...(req.body?.sourceObjectId ? { sourceObjectId: parseMentalObjectId(String(req.body.sourceObjectId)) } : {}),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/workers/:id/procedures`, (req, res) => {
        try {
            res.json({ ok: true, procedures: runtime.getCognitiveState(parseWorkerId(req.params.id ?? "")).procedures });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/procedures/demonstrations`, async (req, res) => {
        try {
            const procedure = await runtime.recordProcedureDemonstration({
                workerId: parseWorkerId(req.params.id ?? ""), trigger: String(req.body?.trigger ?? ""),
                steps: Array.isArray(req.body?.steps) ? req.body.steps : [],
                episodeId: parseMentalObjectId(String(req.body?.episodeId ?? "")),
                ...(Array.isArray(req.body?.preconditions) ? { preconditions: req.body.preconditions } : {}),
                ...(Array.isArray(req.body?.validators) ? { validators: req.body.validators } : {}),
                ...(Array.isArray(req.body?.failureRoutes) ? { failureRoutes: req.body.failureRoutes.map(String) } : {}),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, procedure });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/procedures/execute`, async (req, res) => {
        try {
            const authorization = req.body?.authorization;
            const result = await runtime.executeProcedure({
                workerId: parseWorkerId(req.params.id ?? ""), trigger: String(req.body?.trigger ?? ""),
                ...(authorization ? { authorization } : {}),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/known-answers`, async (req, res) => {
        try {
            const answer = await runtime.recordKnownAnswer({
                workerId: parseWorkerId(req.params.id ?? ""), query: String(req.body?.query ?? ""), answer: String(req.body?.answer ?? ""),
                sourceObjectId: parseMentalObjectId(String(req.body?.sourceObjectId ?? "")),
                aliases: arrayOfStrings(req.body?.aliases),
                ...(optionalNumber(req.body?.confidence) === undefined ? {} : { confidence: optionalNumber(req.body?.confidence) }),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, answer });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/known-answers/lookup`, async (req, res) => {
        try {
            const answer = await runtime.retrieveKnownAnswer(parseWorkerId(req.params.id ?? ""), String(req.body?.query ?? ""), { kind: "user", source: "http-api" });
            res.json({ ok: true, answer });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/cycles`, async (req, res) => {
        try {
            const worker = await runtime.completeCycle(parseWorkerId(req.params.id ?? ""), {
                madeProgress: req.body?.madeProgress === true, scoreDelta: optionalNumber(req.body?.scoreDelta),
                action: req.body?.action == null ? null : String(req.body.action),
                error: req.body?.error == null ? null : String(req.body.error),
                ...(typeof req.body?.validAction === "boolean" ? { validAction: req.body.validAction } : {}),
                ...(typeof req.body?.resourceAvailable === "boolean" ? { resourceAvailable: req.body.resourceAvailable } : {}),
                ...(typeof req.body?.strategyExhausted === "boolean" ? { strategyExhausted: req.body.strategyExhausted } : {}),
                ...(typeof req.body?.procedureValid === "boolean" ? { procedureValid: req.body.procedureValid } : {}),
                ...(typeof req.body?.worldModelSufficient === "boolean" ? { worldModelSufficient: req.body.worldModelSufficient } : {}),
                actor: { kind: "runtime", source: "http-api" }
            });
            res.json({ ok: true, worker });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/plans`, async (req, res) => {
        try {
            const result = await runtime.createParallelPlan({
                plannerWorkerId: parseWorkerId(req.params.id ?? ""),
                ...(req.body?.objective == null ? {} : { objective: String(req.body.objective) }),
                subtasks: Array.isArray(req.body?.subtasks) ? req.body.subtasks : [],
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.status(201).json({ ok: true, ...result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/workers/:id/plans/:planId`, (req, res) => {
        try {
            res.json({ ok: true, ...runtime.getParallelPlan(parseWorkerId(req.params.id ?? ""), parseMentalObjectId(req.params.planId ?? "")) });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/plans/:planId/messages`, async (req, res) => {
        try {
            const message = await runtime.sendWorkerMessage({
                planId: parseMentalObjectId(req.params.planId ?? ""),
                senderWorkerId: parseWorkerId(String(req.body?.senderWorkerId ?? "")),
                recipientWorkerId: parseWorkerId(String(req.body?.recipientWorkerId ?? "")),
                type: req.body?.type,
                subtaskId: req.body?.subtaskId == null ? null : String(req.body.subtaskId),
                ...(objectValue(req.body?.payload) === undefined ? {} : { payload: objectValue(req.body?.payload) })
            });
            res.status(201).json({ ok: true, message });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/plans/:planId/evidence/share`, async (req, res) => {
        try {
            const evidence = await runtime.shareEvidence({
                planId: parseMentalObjectId(req.params.planId ?? ""),
                sourceWorkerId: parseWorkerId(String(req.body?.sourceWorkerId ?? "")),
                targetWorkerId: parseWorkerId(String(req.body?.targetWorkerId ?? "")),
                evidenceId: parseMentalObjectId(String(req.body?.evidenceId ?? ""))
            });
            res.status(201).json({ ok: true, evidence });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/plans/:planId/subtasks/:subtaskId/report`, async (req, res) => {
        try {
            const result = await runtime.reportSubtask({
                planId: parseMentalObjectId(req.params.planId ?? ""), subtaskId: req.params.subtaskId ?? "",
                workerId: parseWorkerId(String(req.body?.workerId ?? "")), status: req.body?.status,
                summary: String(req.body?.summary ?? ""),
                evidenceIds: Array.isArray(req.body?.evidenceIds) ? req.body.evidenceIds.map((id) => parseMentalObjectId(String(id))) : []
            });
            res.json({ ok: true, ...result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/workers/:id/plans/:planId/aggregate`, async (req, res) => {
        try {
            const result = await runtime.aggregateParallelPlan({
                plannerWorkerId: parseWorkerId(req.params.id ?? ""), planId: parseMentalObjectId(req.params.planId ?? ""),
                actor: { kind: "user", source: "http-api", actorId: String(req.body?.actorId ?? "") || null }
            });
            res.json({ ok: true, ...result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.post(`${prefix}/background/run`, async (req, res) => {
        try {
            const result = await runtime.runBackgroundCognition({
                ...(req.body?.workerId ? { workerId: parseWorkerId(String(req.body.workerId)) } : {})
            });
            res.json({ ok: true, result });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
    app.get(`${prefix}/benchmarks/standard-suite`, (_req, res) => {
        res.json({ ok: true, harnessVersion: BENCHMARK_HARNESS_VERSION, tasks: STANDARD_TASK_SUITE });
    });
    app.post(`${prefix}/benchmarks/standard-variants`, (req, res) => {
        try {
            const processor = req.body?.processor;
            if (!processor || typeof processor !== "object" || Array.isArray(processor))
                throw new TypeError("processor is required");
            const variants = createStandardVariants({
                id: String(processor.id ?? ""), provider: String(processor.provider ?? ""),
                tier: Number(processor.tier), parametersBillions: Number(processor.parametersBillions)
            });
            res.json({ ok: true, variants });
        }
        catch (error) {
            sendSpeckError(error, res);
        }
    });
}
export function speckErrorHandler(error, _req, res, _next) {
    sendSpeckError(error, res);
}
export function sendSpeckError(error, res) {
    if (error instanceof SpeckError) {
        res.status(error.statusCode).json({ ok: false, error: error.message, code: error.code });
        return;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
        res.status(400).json({ ok: false, error: error.message, code: "INVALID_INPUT" });
        return;
    }
    console.error("[speck] request failed", error);
    res.status(500).json({ ok: false, error: "Internal Speck error", code: "INTERNAL_ERROR" });
}
function arrayOfStrings(value) {
    return Array.isArray(value) ? value.map(String) : [];
}
function requiredStatus(value) {
    const status = String(value ?? "");
    if (!WORKER_STATUSES.includes(status))
        throw new TypeError(`Unknown worker status: ${status || "(empty)"}`);
    return status;
}
function optionalStatus(value) {
    if (value === undefined || value === "")
        return undefined;
    return requiredStatus(value);
}
function requiredEdgeKind(value) {
    const kind = String(value ?? "");
    if (!EDGE_KINDS.includes(kind))
        throw new TypeError(`Unknown edge kind: ${kind || "(empty)"}`);
    return kind;
}
function optionalNumber(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        throw new TypeError(`Expected a number, received ${String(value)}`);
    return parsed;
}
function objectValue(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "object" || Array.isArray(value))
        throw new TypeError("data must be an object");
    return value;
}
function structuredContract(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("contract must be an object");
    const contract = value;
    if (!String(contract.name ?? "").trim())
        throw new TypeError("contract.name is required");
    if (!Array.isArray(contract.required) || !contract.properties || typeof contract.properties !== "object" || Array.isArray(contract.properties)) {
        throw new TypeError("contract requires required[] and properties{}");
    }
    return value;
}
function evidenceRelations(value) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        throw new TypeError("relations must be an array");
    return value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new TypeError("each evidence relation must be an object");
        const relation = entry;
        const direction = String(relation.direction ?? "");
        if (direction !== "supports" && direction !== "contradicts")
            throw new TypeError(`Unknown evidence direction: ${direction}`);
        const strength = optionalNumber(relation.strength);
        return {
            hypothesisId: parseMentalObjectId(String(relation.hypothesisId ?? "")),
            direction,
            ...(strength === undefined ? {} : { strength })
        };
    });
}
//# sourceMappingURL=routes.js.map