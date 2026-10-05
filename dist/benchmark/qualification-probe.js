import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATOMIC_ENTAILMENT_CORPUS, OUTAGE_TASK_SET, entailmentLabel, entailmentRequest, scoreQualification } from "../metacognition/qualification.js";
import { SpeckRuntime } from "../runtime/speck-runtime.js";
export async function runQualificationProbe(input) {
    const capability = input.capability ?? "atomic-entailment";
    const repetitions = Math.max(1, input.repetitions ?? 3);
    const results = [];
    for (const processor of input.processors) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-qualify-"));
        const runtime = new SpeckRuntime({
            databasePath: path.join(directory, "speck.sqlite"), genesisRuntimePath: directory,
            modelRuntime: { processors: [{ ...processor, enabled: true }], roles: { intake: processor.id, planner: processor.id, worker: processor.id, toolCaller: "", specialists: {} }, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }
        });
        try {
            const worker = await runtime.createWorker(`Qualification of ${processor.model} for ${capability}`);
            let calls = 0;
            let elapsed = 0;
            const ask = async (premise, hypothesis) => {
                const began = performance.now();
                try {
                    const answered = await runtime.inferForWorker({
                        workerId: worker.id, processorId: processor.id, contextScope: "minimal",
                        ...entailmentRequest(premise, hypothesis), actor: { kind: "runtime", source: "qualification-probe" }
                    });
                    return entailmentLabel(answered.response.structured?.label);
                }
                catch {
                    return null;
                }
                finally {
                    calls += 1;
                    elapsed += performance.now() - began;
                }
            };
            const answer = async (pairs) => {
                const answers = [];
                for (let repetition = 0; repetition < repetitions; repetition += 1) {
                    for (const pair of pairs) {
                        const entry = { pair, proposition: await ask(pair.premise, pair.proposition), opposite: await ask(pair.premise, pair.opposite) };
                        input.onAnswer?.(processor.id, pair, entry);
                        answers.push(entry);
                    }
                }
                return answers;
            };
            const corpus = await answer(ATOMIC_ENTAILMENT_CORPUS);
            const latency = calls ? Math.round(elapsed / calls) : 0;
            const task = await answer(OUTAGE_TASK_SET);
            results.push({
                model: `${processor.provider}:${processor.model}`, processorId: processor.id,
                qualification: scoreQualification(capability, corpus, repetitions, latency),
                task: scoreQualification(capability, task, repetitions, latency)
            });
        }
        finally {
            runtime.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
    return results;
}
//# sourceMappingURL=qualification-probe.js.map