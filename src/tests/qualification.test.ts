// Judgment qualification: a checker's judgments of a class count only once it
// has been measured qualified for that class.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProcessorCompetenceStore } from "../metacognition/competence.js";
import { ATOMIC_ENTAILMENT_CORPUS, opposed, scoreQualification, type EntailmentLabel, type PairAnswer } from "../metacognition/qualification.js";
import { qualify, withFixture } from "./support/controller-fixture.js";

// The corpus answered three times, as the probe asks it.
const answering = (answer: (label: EntailmentLabel) => [EntailmentLabel | null, EntailmentLabel | null]): PairAnswer[] =>
  [0, 1, 2].flatMap(() => ATOMIC_ENTAILMENT_CORPUS.map((pair) => {
    const [proposition, opposite] = answer(pair.label);
    return { pair, proposition, opposite };
  }));

test("a model that answers every pair correctly is qualified", () => {
  const measured = scoreQualification("atomic-entailment", answering((label) => [label, opposed(label)]), 1, 100);
  assert.equal(measured.qualified, true);
  assert.equal(measured.overall.correct, measured.overall.total);
});

test("a model that says yes to a proposition and to its opposite is not qualified, however often it is right", () => {
  // The 1.2B's pattern (2026-10-03): "entailment" for nearly everything.
  const measured = scoreQualification("atomic-entailment", answering(() => ["entailment", "entailment"]), 1, 100);
  assert.equal(measured.qualified, false);
  assert.equal(measured.byLabel.entailment.correct, measured.byLabel.entailment.total);
  assert.equal(measured.byLabel.contradiction.correct, 0);
  assert.equal(measured.negationConsistency.correct, 0);
});

test("answering neutral to everything is not negation consistency", () => {
  // The 0.6B's pattern: never wrong about a pair's consistency because it
  // never commits.
  const measured = scoreQualification("atomic-entailment", answering(() => ["neutral", "neutral"]), 1, 100);
  assert.equal(measured.qualified, false);
  assert.equal(measured.negationConsistency.total, 0);
});

test("missing contradictions disqualify a model even when its overall score passes", () => {
  // Everything right except eight contradictions called neutral (their
  // opposites answered correctly): the error that lets a held hypothesis
  // survive the evidence against it.
  let missed = 0;
  const measured = scoreQualification("atomic-entailment", answering((label) => {
    if (label === "contradiction" && missed < 8) { missed += 1; return ["neutral", opposed(label)]; }
    return [label, opposed(label)];
  }), 3, 100);
  // 112/120 contradictions is 93%, but its lower bound is below the bar.
  assert.ok(measured.lowerBounds.overall >= 0.85);
  assert.ok(measured.byLabel.contradiction.correct / measured.byLabel.contradiction.total > 0.9);
  assert.ok(measured.lowerBounds.contradiction < 0.9);
  assert.equal(measured.qualified, false);
});

test("one stochastic miss does not disqualify a checker that is otherwise right", () => {
  let missed = 0;
  const measured = scoreQualification("atomic-entailment", answering((label) => {
    if (label === "contradiction" && missed < 1) { missed += 1; return ["contradiction", "contradiction"]; }
    return [label, opposed(label)];
  }), 3, 100);
  assert.ok(measured.negationConsistency.correct < measured.negationConsistency.total);
  assert.equal(measured.qualified, true);
});

test("a measurement on an older corpus is no measurement", () => {
  const store = new ProcessorCompetenceStore(null);
  const measured = scoreQualification("atomic-entailment", answering((label) => [label, opposed(label)]), 1, 100);
  store.recordQualification("ollama:m", { ...measured, corpus: "atomic-entailment/0" });
  assert.equal(store.qualification("ollama:m", "atomic-entailment"), undefined);
  store.recordQualification("ollama:m", measured);
  assert.equal(store.qualification("ollama:m", "atomic-entailment")?.qualified, true);
});

test("the checker is the cheapest qualified model other than the producer's, and none when only the producer is qualified", async () => {
  await withFixture("direct", async (f) => {
    assert.equal(f.runtime.qualifiedProcessor("worker", "atomic-entailment"), null, "nothing measured, nothing qualified");
    qualify(f.runtime, "worker");
    assert.equal(f.runtime.qualifiedProcessor("worker", "atomic-entailment"), null, "a model does not check its own output");
    qualify(f.runtime, "planner", 300);
    qualify(f.runtime, "intake", 120);
    assert.equal(f.runtime.qualifiedProcessor("worker", "atomic-entailment"), "intake");
  });
});

test("a qualification recorded by one process survives another's later save, and the newer measurement stands", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "speck-qualification-"));
  const file = path.join(directory, "competence.json");
  try {
    const server = new ProcessorCompetenceStore(file);
    const probe = new ProcessorCompetenceStore(file);
    const correct = answering((label) => [label, opposed(label)]);
    probe.recordQualification("ollama:m", scoreQualification("atomic-entailment", correct, 3, 100, "2026-10-03T10:00:00.000Z"));
    server.record("ollama:m", "c@json", { success: true, source: "server" });
    assert.equal(new ProcessorCompetenceStore(file).qualification("ollama:m", "atomic-entailment")?.qualified, true);
    // An older measurement arriving later does not replace a newer one.
    server.recordQualification("ollama:m", { ...scoreQualification("atomic-entailment", answering(() => ["neutral", "neutral"]), 3, 100, "2026-10-02T10:00:00.000Z") });
    assert.equal(new ProcessorCompetenceStore(file).qualification("ollama:m", "atomic-entailment")?.qualified, true);
    assert.equal(server.qualification("ollama:m", "atomic-entailment")?.qualified, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
