import fs from "node:fs";
import path from "node:path";
import { ATOMIC_ENTAILMENT_CORPUS_VERSION } from "./qualification.js";
const CORPUS_VERSIONS = { "atomic-entailment": ATOMIC_ENTAILMENT_CORPUS_VERSION };
export const protocolCapability = (contract, protocol) => `${contract}@${protocol}`;
export const outcomeCapability = (contract, protocol, aspect = "quality") => `${aspect}:${contract}@${protocol}`;
const SCORED_ASPECTS = ["quality", "execution"];
// One observation from the provider's native tool-calling test call, used only
// while a model has no evidence for a contract (Shortcut S7).
export const NATIVE_VERIFICATION = "native-tools@verification";
const EVIDENCE_KEPT = 50;
const JUDGMENTS_KEPT = 200;
// Beta(1, 1) posterior mean: with no evidence a capability is unknown (0.5);
// each observation moves it, and more observations move it less.
export function competenceScore(entry) {
    return entry ? (entry.successes + 1) / (entry.successes + entry.failures + 2) : 0.5;
}
export function observations(entry) {
    return entry ? entry.successes + entry.failures : 0;
}
// The file is shared: the server and CLI probes each hold a store on it. A
// store that wrote its whole in-memory copy on every save overwrote what
// another process had recorded since it loaded (a running server dropped
// qualifications measured by `probe qualify`). Each change is therefore kept
// as an operation, applied here at once and replayed onto the file's current
// contents when saving, under a lock; reads pick up what another process
// wrote. Counts add up, judgments append, peaks take the larger, and of two
// measurements of a judgment class the newer stands.
export class ProcessorCompetenceStore {
    file;
    records = new Map();
    pending = [];
    loadedVersion = "";
    // file is null for an in-memory store (tests, ephemeral runtimes).
    constructor(file) {
        this.file = file;
        this.reload();
    }
    get(model) { return this.current().get(model); }
    list() { return [...this.current().values()].map((record) => structuredClone(record)); }
    capability(model, capability) {
        return this.current().get(model)?.capabilities[capability];
    }
    record(model, capability, outcome) {
        const observed = { ...outcome, at: outcome.at ?? new Date().toISOString() };
        this.apply((records) => recordIn(records, model, capability, observed));
    }
    // Records a judgment of the producer's output. It counts towards competence
    // only if the evaluator is independent of the producer (another model, or a
    // deterministic observation); otherwise it is kept as unobserved.
    judge(producer, judgment) {
        const independent = judgment.evaluator !== null && judgment.evaluator !== producer;
        const recorded = {
            ...judgment, at: judgment.at ?? new Date().toISOString(),
            verdict: independent ? judgment.verdict : "unobserved"
        };
        this.apply((records) => {
            const record = ensureIn(records, producer);
            record.judgments = [...record.judgments, recorded].slice(-JUDGMENTS_KEPT);
            if (recorded.verdict === "unobserved")
                return;
            recordIn(records, producer, outcomeCapability(recorded.contract, recorded.protocol, recorded.aspect), {
                success: recorded.verdict === "accepted", source: recorded.evaluator ?? "unknown", at: recorded.at
            });
        });
        return recorded;
    }
    // How often each evaluator accepted each producer's output for a contract
    // and aspect: the data that reveals a lenient or harsh evaluator.
    agreement(contract, aspect = "quality") {
        const rows = new Map();
        for (const record of this.current().values()) {
            for (const judgment of record.judgments) {
                if (judgment.contract !== contract || judgment.aspect !== aspect || judgment.verdict === "unobserved" || !judgment.evaluator)
                    continue;
                const key = `${record.model}\u0000${judgment.evaluator}`;
                const row = rows.get(key) ?? { producer: record.model, evaluator: judgment.evaluator, accepted: 0, judged: 0 };
                row.judged += 1;
                if (judgment.verdict === "accepted")
                    row.accepted += 1;
                rows.set(key, row);
            }
        }
        return [...rows.values()];
    }
    recordQualification(model, qualification) {
        this.apply((records) => {
            const record = ensureIn(records, model);
            const held = record.qualifications?.[qualification.capability];
            if (held && held.measuredAt > qualification.measuredAt)
                return;
            record.qualifications = { ...(record.qualifications ?? {}), [qualification.capability]: qualification };
        });
    }
    // The model's measurement for a judgment class on the current corpus, if
    // any. A measurement on an older corpus is no measurement.
    qualification(model, capability) {
        const measured = this.current().get(model)?.qualifications?.[capability];
        return measured && measured.corpus === CORPUS_VERSIONS[capability] ? measured : undefined;
    }
    recordTokens(model, tokens, overflowed) {
        const record = this.current().get(model);
        if (record && (overflowed ? tokens <= record.overflowTokens : tokens <= record.peakTokens))
            return;
        this.apply((records) => {
            const entry = ensureIn(records, model);
            if (overflowed)
                entry.overflowTokens = Math.max(entry.overflowTokens, tokens);
            else
                entry.peakTokens = Math.max(entry.peakTokens, tokens);
        });
    }
    // How well a protocol serves a contract: the chance its reply is usable
    // times the chance its outcome holds up. Unknown parts count as 0.5, so a
    // protocol that keeps failing loses to an untried one, which is how the
    // alternative gets explored.
    protocolScore(model, contract, protocol) {
        const compliance = this.capability(model, protocolCapability(contract, protocol));
        // The native test call is evidence about native compliance for every
        // contract, so a model that failed it does not get native explored as if
        // nothing were known.
        const verification = protocol === "native" ? this.capability(model, NATIVE_VERIFICATION) : undefined;
        const merged = compliance || verification ? {
            successes: (compliance?.successes ?? 0) + (verification?.successes ?? 0),
            failures: (compliance?.failures ?? 0) + (verification?.failures ?? 0)
        } : undefined;
        return SCORED_ASPECTS.reduce((score, aspect) => score * competenceScore(this.capability(model, outcomeCapability(contract, protocol, aspect))), competenceScore(merged));
    }
    hasEvidence(model, contract) {
        return ["native", "json"].some((protocol) => this.evidenceCount(model, contract, protocol) > 0);
    }
    preferredProtocol(model, contract) {
        return this.protocolScore(model, contract, "native") > this.protocolScore(model, contract, "json") ? "native" : "json";
    }
    // Evidence behind a role: observations of its contracts by this model.
    roleEvidence(model, contracts) {
        let total = 0;
        let count = 0;
        for (const contract of contracts) {
            // A role is judged on the protocol this model has actually been observed
            // using for the contract; an untried protocol is no evidence either way.
            const evidence = (protocol) => this.evidenceCount(model, contract, protocol);
            const protocol = evidence("native") > evidence("json") ? "native" : "json";
            total += this.protocolScore(model, contract, protocol);
            count += evidence(protocol);
        }
        return { score: contracts.length ? total / contracts.length : 0, observations: count };
    }
    // The context window this model has been seen to need: room for the largest
    // observed call plus a reply, doubled past any overflow, as a power of two
    // within the model's trained size.
    contextWindow(model, input) {
        const record = this.current().get(model);
        const needed = Math.max(record?.peakTokens ?? 0, (record?.overflowTokens ?? 0) * 2) + input.replyReserve;
        let window = input.minimum;
        while (window < needed && window < input.maximum)
            window *= 2;
        return Math.min(window, input.maximum);
    }
    evidenceCount(model, contract, protocol) {
        return observations(this.capability(model, protocolCapability(contract, protocol)))
            + SCORED_ASPECTS.reduce((count, aspect) => count + observations(this.capability(model, outcomeCapability(contract, protocol, aspect))), 0);
    }
    // The records, reloaded first if another process has written the file
    // since this store last read or wrote it.
    current() {
        if (this.file && !this.pending.length && fileVersion(this.file) !== this.loadedVersion)
            this.reload();
        return this.records;
    }
    reload() {
        if (!this.file)
            return;
        this.records = readRecords(this.file);
        this.loadedVersion = fileVersion(this.file);
    }
    apply(operation) {
        this.current();
        operation(this.records);
        this.pending.push(operation);
        this.save();
    }
    // Replays this store's changes onto what the file holds now, so a change
    // another process saved in the meantime is kept.
    save() {
        if (!this.file) {
            this.pending = [];
            return;
        }
        const file = this.file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        withLock(`${file}.lock`, () => {
            const merged = readRecords(file);
            for (const operation of this.pending)
                operation(merged);
            const temporary = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, `${JSON.stringify({ schema: "speck-processor-competence/v1", processors: [...merged.values()] }, null, 2)}\n`);
            fs.renameSync(temporary, file);
            this.records = merged;
            this.pending = [];
            this.loadedVersion = fileVersion(file);
        });
    }
}
function ensureIn(records, model) {
    let record = records.get(model);
    if (!record) {
        record = { model, capabilities: {}, judgments: [], peakTokens: 0, overflowTokens: 0 };
        records.set(model, record);
    }
    return record;
}
function recordIn(records, model, capability, outcome) {
    const entry = ensureIn(records, model).capabilities[capability] ??= { successes: 0, failures: 0, evidence: [], meanLatencyMs: null, lastObserved: outcome.at };
    if (outcome.success)
        entry.successes += 1;
    else
        entry.failures += 1;
    entry.evidence = [...entry.evidence, { at: outcome.at, success: outcome.success, source: outcome.source }].slice(-EVIDENCE_KEPT);
    if (outcome.latencyMs !== undefined) {
        const n = entry.successes + entry.failures;
        entry.meanLatencyMs = entry.meanLatencyMs === null ? outcome.latencyMs : entry.meanLatencyMs + (outcome.latencyMs - entry.meanLatencyMs) / n;
    }
    if (outcome.at > entry.lastObserved)
        entry.lastObserved = outcome.at;
}
function readRecords(file) {
    const records = new Map();
    if (!fs.existsSync(file))
        return records;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const record of parsed.processors ?? [])
            records.set(record.model, { ...record, judgments: record.judgments ?? [] });
    }
    catch { /* an unreadable store starts empty; evidence is re-gathered */ }
    return records;
}
function fileVersion(file) {
    try {
        const stat = fs.statSync(file);
        return `${stat.mtimeMs}:${stat.size}`;
    }
    catch {
        return "";
    }
}
// Holds a lock file around a read-merge-write. A lock older than ten seconds
// was left by a process that died, and is taken over; after two seconds of
// waiting the write goes ahead unlocked rather than losing the record.
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 10_000;
function withLock(lock, body) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;
    while (!held) {
        try {
            fs.closeSync(fs.openSync(lock, "wx"));
            held = true;
        }
        catch {
            try {
                if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS)
                    fs.rmSync(lock, { force: true });
            }
            catch { /* released meanwhile */ }
            if (Date.now() > deadline)
                break;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    try {
        body();
    }
    finally {
        if (held)
            fs.rmSync(lock, { force: true });
    }
}
//# sourceMappingURL=competence.js.map