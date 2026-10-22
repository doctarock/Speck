import fs from "node:fs";
import path from "node:path";
import { ATOMIC_ENTAILMENT_CORPUS_VERSION, PAIRED_ENTAILMENT_CORPUS_VERSION, type JudgmentCapability, type Qualification } from "./qualification.js";

const CORPUS_VERSIONS: Record<JudgmentCapability, string> = { "atomic-entailment": ATOMIC_ENTAILMENT_CORPUS_VERSION, "paired-entailment": PAIRED_ENTAILMENT_CORPUS_VERSION };

// Persistent processor competence: what Speck has observed each model doing.
//
// Calibration profiles live on a task worker and end with it. Competence is
// held per model (provider and model name, so it resets when a processor id is
// pointed at a different model) and per capability, survives restarts, and is
// updated only from outcomes Speck can attribute to a call. Decisions that were
// configuration (which protocol to use, which processor fills a role, how much
// context to allocate) are read from it instead.
//
// A claim about competence stays provisional until it is corroborated by an
// independent source or an observable outcome. Every judgment is kept with its
// provenance (producer, contract, aspect, evaluator, verdict, deterministic
// outcome, context), but only judgments by a different model, or deterministic
// outcomes, count towards a producer's competence. A model grading its own
// output is recorded as unobserved.

export interface CompetenceEvidence {
  at: string;
  success: boolean;
  source: string;
}

export interface CapabilityCompetence {
  successes: number;
  failures: number;
  // Most recent observations, newest last; the counts cover all of them.
  evidence: CompetenceEvidence[];
  meanLatencyMs: number | null;
  lastObserved: string;
}

// What a judgment is about. Replies are judged on quality; tool calls on
// execution (did it run), selection (was it the right action) and result (did
// it help). Aspects are kept apart so one cannot stand in for another: a tool
// that ran but was not wanted is an execution success and a selection failure.
export type Aspect = "quality" | "execution" | "selection" | "result";

export type Verdict = "accepted" | "rejected" | "unobserved";

export interface Judgment {
  at: string;
  contract: string;
  protocol: Protocol;
  aspect: Aspect;
  // The model that judged, "deterministic" for an observed outcome, or null
  // when nothing independent judged.
  evaluator: string | null;
  verdict: Verdict;
  // What was observed directly, if anything (for example "executed",
  // "invalid-arguments"), and what the judgment was about.
  deterministicOutcome: string | null;
  context: Record<string, unknown>;
}

export interface ProcessorCompetence {
  model: string;
  capabilities: Record<string, CapabilityCompetence>;
  // Judgments of this model's output, newest last.
  judgments: Judgment[];
  // The largest prompt-plus-reply observed, and the largest that overflowed.
  peakTokens: number;
  overflowTokens: number;
  // Judgment classes this model has been measured on, by the latest
  // measurement of each (see qualification.ts).
  qualifications?: Partial<Record<JudgmentCapability, Qualification>>;
}

// Capabilities are named by what was asked of the model: whether its replies
// to a contract over a protocol were usable ("tool-intent@native"), and how an
// aspect of its output was judged ("execution:tool-intent@native").
export type Protocol = "native" | "json";
export const protocolCapability = (contract: string, protocol: Protocol) => `${contract}@${protocol}`;
export const outcomeCapability = (contract: string, protocol: Protocol, aspect: Aspect = "quality") => `${aspect}:${contract}@${protocol}`;
const SCORED_ASPECTS: readonly Aspect[] = ["quality", "execution"];
// One observation from the provider's native tool-calling test call, used only
// while a model has no evidence for a contract (Shortcut S7).
export const NATIVE_VERIFICATION = "native-tools@verification";

const EVIDENCE_KEPT = 50;
const JUDGMENTS_KEPT = 200;

// Beta(1, 1) posterior mean: with no evidence a capability is unknown (0.5);
// each observation moves it, and more observations move it less.
export function competenceScore(entry: Pick<CapabilityCompetence, "successes" | "failures"> | undefined): number {
  return entry ? (entry.successes + 1) / (entry.successes + entry.failures + 2) : 0.5;
}

export function observations(entry: CapabilityCompetence | undefined): number {
  return entry ? entry.successes + entry.failures : 0;
}

type Records = Map<string, ProcessorCompetence>;
type Operation = (records: Records) => void;

// The file is shared: the server and CLI probes each hold a store on it. A
// store that wrote its whole in-memory copy on every save overwrote what
// another process had recorded since it loaded (a running server dropped
// qualifications measured by `probe qualify`). Each change is therefore kept
// as an operation, applied here at once and replayed onto the file's current
// contents when saving, under a lock; reads pick up what another process
// wrote. Counts add up, judgments append, peaks take the larger, and of two
// measurements of a judgment class the newer stands.
export class ProcessorCompetenceStore {
  private records: Records = new Map();
  private pending: Operation[] = [];
  private loadedVersion = "";

  // file is null for an in-memory store (tests, ephemeral runtimes).
  constructor(private readonly file: string | null) {
    this.reload();
  }

  get(model: string): ProcessorCompetence | undefined { return this.current().get(model); }

  list(): ProcessorCompetence[] { return [...this.current().values()].map((record) => structuredClone(record)); }

  capability(model: string, capability: string): CapabilityCompetence | undefined {
    return this.current().get(model)?.capabilities[capability];
  }

  record(model: string, capability: string, outcome: { success: boolean; source: string; latencyMs?: number; at?: string }): void {
    const observed = { ...outcome, at: outcome.at ?? new Date().toISOString() };
    this.apply((records) => recordIn(records, model, capability, observed));
  }

  // Records a judgment of the producer's output. It counts towards competence
  // only if the evaluator is independent of the producer (another model, or a
  // deterministic observation); otherwise it is kept as unobserved.
  judge(producer: string, judgment: Omit<Judgment, "at"> & { at?: string }): Judgment {
    const independent = judgment.evaluator !== null && judgment.evaluator !== producer;
    const recorded: Judgment = {
      ...judgment, at: judgment.at ?? new Date().toISOString(),
      verdict: independent ? judgment.verdict : "unobserved"
    };
    this.apply((records) => {
      const record = ensureIn(records, producer);
      record.judgments = [...record.judgments, recorded].slice(-JUDGMENTS_KEPT);
      if (recorded.verdict === "unobserved") return;
      recordIn(records, producer, outcomeCapability(recorded.contract, recorded.protocol, recorded.aspect), {
        success: recorded.verdict === "accepted", source: recorded.evaluator ?? "unknown", at: recorded.at
      });
    });
    return recorded;
  }

  // How often each evaluator accepted each producer's output for a contract
  // and aspect: the data that reveals a lenient or harsh evaluator.
  agreement(contract: string, aspect: Aspect = "quality"): Array<{ producer: string; evaluator: string; accepted: number; judged: number }> {
    const rows = new Map<string, { producer: string; evaluator: string; accepted: number; judged: number }>();
    for (const record of this.current().values()) {
      for (const judgment of record.judgments) {
        if (judgment.contract !== contract || judgment.aspect !== aspect || judgment.verdict === "unobserved" || !judgment.evaluator) continue;
        const key = `${record.model}\u0000${judgment.evaluator}`;
        const row = rows.get(key) ?? { producer: record.model, evaluator: judgment.evaluator, accepted: 0, judged: 0 };
        row.judged += 1;
        if (judgment.verdict === "accepted") row.accepted += 1;
        rows.set(key, row);
      }
    }
    return [...rows.values()];
  }

  recordQualification(model: string, qualification: Qualification): void {
    this.apply((records) => {
      const record = ensureIn(records, model);
      const held = record.qualifications?.[qualification.capability];
      if (held && held.measuredAt > qualification.measuredAt) return;
      record.qualifications = { ...(record.qualifications ?? {}), [qualification.capability]: qualification };
    });
  }

  // The model's measurement for a judgment class on the current corpus, if
  // any. A measurement on an older corpus is no measurement.
  qualification(model: string, capability: JudgmentCapability): Qualification | undefined {
    const measured = this.current().get(model)?.qualifications?.[capability];
    return measured && measured.corpus === CORPUS_VERSIONS[capability] ? measured : undefined;
  }

  recordTokens(model: string, tokens: number, overflowed: boolean): void {
    const record = this.current().get(model);
    if (record && (overflowed ? tokens <= record.overflowTokens : tokens <= record.peakTokens)) return;
    this.apply((records) => {
      const entry = ensureIn(records, model);
      if (overflowed) entry.overflowTokens = Math.max(entry.overflowTokens, tokens);
      else entry.peakTokens = Math.max(entry.peakTokens, tokens);
    });
  }

  // How well a protocol serves a contract: the chance its reply is usable
  // times the chance its outcome holds up. Unknown parts count as 0.5, so a
  // protocol that keeps failing loses to an untried one, which is how the
  // alternative gets explored.
  protocolScore(model: string, contract: string, protocol: Protocol): number {
    const compliance = this.capability(model, protocolCapability(contract, protocol));
    // The native test call is evidence about native compliance for every
    // contract, so a model that failed it does not get native explored as if
    // nothing were known.
    const verification = protocol === "native" ? this.capability(model, NATIVE_VERIFICATION) : undefined;
    const merged = compliance || verification ? {
      successes: (compliance?.successes ?? 0) + (verification?.successes ?? 0),
      failures: (compliance?.failures ?? 0) + (verification?.failures ?? 0)
    } : undefined;
    return SCORED_ASPECTS.reduce((score, aspect) => score * competenceScore(this.capability(model, outcomeCapability(contract, protocol, aspect))),
      competenceScore(merged));
  }

  hasEvidence(model: string, contract: string): boolean {
    return (["native", "json"] as const).some((protocol) => this.evidenceCount(model, contract, protocol) > 0);
  }

  preferredProtocol(model: string, contract: string): Protocol {
    return this.protocolScore(model, contract, "native") > this.protocolScore(model, contract, "json") ? "native" : "json";
  }

  // Evidence behind a role: observations of its contracts by this model.
  roleEvidence(model: string, contracts: readonly string[]): { score: number; observations: number } {
    let total = 0;
    let count = 0;
    for (const contract of contracts) {
      // A role is judged on the protocol this model has actually been observed
      // using for the contract; an untried protocol is no evidence either way.
      const evidence = (protocol: Protocol) => this.evidenceCount(model, contract, protocol);
      const protocol = evidence("native") > evidence("json") ? "native" : "json";
      total += this.protocolScore(model, contract, protocol);
      count += evidence(protocol);
    }
    return { score: contracts.length ? total / contracts.length : 0, observations: count };
  }

  // The context window this model has been seen to need: room for the largest
  // observed call plus a reply, doubled past any overflow, as a power of two
  // within the model's trained size.
  contextWindow(model: string, input: { minimum: number; maximum: number; replyReserve: number }): number {
    const record = this.current().get(model);
    const needed = Math.max(record?.peakTokens ?? 0, (record?.overflowTokens ?? 0) * 2) + input.replyReserve;
    let window = input.minimum;
    while (window < needed && window < input.maximum) window *= 2;
    return Math.min(window, input.maximum);
  }

  private evidenceCount(model: string, contract: string, protocol: Protocol): number {
    return observations(this.capability(model, protocolCapability(contract, protocol)))
      + SCORED_ASPECTS.reduce((count, aspect) => count + observations(this.capability(model, outcomeCapability(contract, protocol, aspect))), 0);
  }

  // The records, reloaded first if another process has written the file
  // since this store last read or wrote it.
  private current(): Records {
    if (this.file && !this.pending.length && fileVersion(this.file) !== this.loadedVersion) this.reload();
    return this.records;
  }

  private reload(): void {
    if (!this.file) return;
    this.records = readRecords(this.file);
    this.loadedVersion = fileVersion(this.file);
  }

  private apply(operation: Operation): void {
    this.current();
    operation(this.records);
    this.pending.push(operation);
    this.save();
  }

  // Replays this store's changes onto what the file holds now, so a change
  // another process saved in the meantime is kept.
  private save(): void {
    if (!this.file) {
      this.pending = [];
      return;
    }
    const file = this.file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    withLock(`${file}.lock`, () => {
      const merged = readRecords(file);
      for (const operation of this.pending) operation(merged);
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({ schema: "speck-processor-competence/v1", processors: [...merged.values()] }, null, 2)}\n`);
      fs.renameSync(temporary, file);
      this.records = merged;
      this.pending = [];
      this.loadedVersion = fileVersion(file);
    });
  }
}

function ensureIn(records: Records, model: string): ProcessorCompetence {
  let record = records.get(model);
  if (!record) {
    record = { model, capabilities: {}, judgments: [], peakTokens: 0, overflowTokens: 0 };
    records.set(model, record);
  }
  return record;
}

function recordIn(records: Records, model: string, capability: string, outcome: { success: boolean; source: string; latencyMs?: number; at: string }): void {
  const entry = ensureIn(records, model).capabilities[capability] ??= { successes: 0, failures: 0, evidence: [], meanLatencyMs: null, lastObserved: outcome.at };
  if (outcome.success) entry.successes += 1; else entry.failures += 1;
  entry.evidence = [...entry.evidence, { at: outcome.at, success: outcome.success, source: outcome.source }].slice(-EVIDENCE_KEPT);
  if (outcome.latencyMs !== undefined) {
    const n = entry.successes + entry.failures;
    entry.meanLatencyMs = entry.meanLatencyMs === null ? outcome.latencyMs : entry.meanLatencyMs + (outcome.latencyMs - entry.meanLatencyMs) / n;
  }
  if (outcome.at > entry.lastObserved) entry.lastObserved = outcome.at;
}

function readRecords(file: string): Records {
  const records: Records = new Map();
  if (!fs.existsSync(file)) return records;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { processors?: ProcessorCompetence[] };
    for (const record of parsed.processors ?? []) records.set(record.model, { ...record, judgments: record.judgments ?? [] });
  } catch { /* an unreadable store starts empty; evidence is re-gathered */ }
  return records;
}

function fileVersion(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
}

// Holds a lock file around a read-merge-write. A lock older than ten seconds
// was left by a process that died, and is taken over; after two seconds of
// waiting the write goes ahead unlocked rather than losing the record.
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 10_000;
function withLock(lock: string, body: () => void): void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      held = true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { force: true });
      } catch { /* released meanwhile */ }
      if (Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    body();
  } finally {
    if (held) fs.rmSync(lock, { force: true });
  }
}
