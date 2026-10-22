// The paired judgment (2026-10-22): Speck forms a proposition's opposite from
// the parse (fixtures/negation-parses.json), asks the checker about both, and
// commits a verdict only when the two answers are opposed.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { opposed, scorePairedQualification, type ContrastivePair, type EntailmentLabel, type PairAnswer } from "../metacognition/qualification.js";
import { oppositeOf, quantifiedSubject } from "../speck/negation.js";
import { pairedEntailment } from "../speck/paired-entailment.js";
import type { ParsedToken } from "../speck/parse.js";

const PARSES = JSON.parse(fs.readFileSync(path.resolve("src", "tests", "fixtures", "negation-parses.json"), "utf8")) as Record<string, ParsedToken[]>;
const opposite = (text: string) => oppositeOf(text, PARSES[text]!, "verb-or-wrapper");

test("a clause is negated through its verb, keeping its tense and any prefix; a negated clause loses its negation", () => {
  assert.equal(opposite("Tom completed the marathon."), "Tom did not complete the marathon.");
  assert.equal(opposite("The road was closed."), "The road was not closed.");
  assert.equal(opposite("The battery is empty."), "The battery is not empty.");
  assert.equal(opposite("Mia's sister lives abroad."), "Mia's sister does not live abroad.");
  assert.equal(opposite("Lucy's colleague co-wrote the report."), "Lucy's colleague did not co-write the report.");
  assert.equal(opposite("Lucia did not pass the driving test."), "Lucia did pass the driving test.");
  assert.equal(opposite("Hana has never been to Brazil."), "Hana has been to Brazil.");
  assert.equal(opposite("The bakery no longer sells rye bread."), "The bakery sells rye bread.");
});

test("a quantified subject takes the wrapper, whose negation is exact", () => {
  for (const text of ["Every guest had left by midnight.", "No virus was detected in the sample.", "Two of the printers work.", "There was nothing left in the bottle."]) {
    assert.ok(quantifiedSubject(PARSES[text]!), text);
    assert.match(opposite(text), /^It is not true that /);
  }
  assert.equal(quantifiedSubject(PARSES["Tom completed the marathon."]!), false);
});

test("only verdicts whose two answers are opposed count; the rest are reported as abstentions", () => {
  const pair = (label: EntailmentLabel): ContrastivePair => ({ premise: "p", proposition: "q", opposite: "not q", label });
  const answers: PairAnswer[] = [];
  for (let n = 0; n < 60; n += 1) for (const label of ["entailment", "contradiction", "neutral"] as const) answers.push({ pair: pair(label), proposition: label, opposite: opposed(label) });
  answers.push({ pair: pair("contradiction"), proposition: "contradiction", opposite: "neutral" });
  const scored = scorePairedQualification(answers, 1, 20);
  assert.equal(scored.qualified, true);
  assert.deepEqual(scored.abstained, { correct: 1, total: 181 });
  assert.deepEqual(scored.byLabel.contradiction, { correct: 120, total: 120 }, "a committed pair scores its proposition and its opposite");
  const wrong = [...answers, ...Array.from({ length: 12 }, () => ({ pair: pair("contradiction"), proposition: "entailment" as const, opposite: "contradiction" as const }))];
  assert.equal(scorePairedQualification(wrong, 1, 20).qualified, false, "consistent but wrong verdicts are errors");
});

test("the runtime ask commits only on opposed answers, and is void without a parse", async () => {
  const text = "Tom completed the marathon.";
  const parse = async (proposition: string) => PARSES[proposition] ?? null;
  const consistent = await pairedEntailment(async (_p, hypothesis) => hypothesis === text ? "entailment" : "contradiction", "Tom ran and finished.", text, parse);
  assert.equal(consistent.label, "entailment");
  assert.equal(consistent.opposite, "Tom did not complete the marathon.");
  const inconsistent = await pairedEntailment(async () => "entailment", "Tom ran.", text, parse);
  assert.equal(inconsistent.label, null);
  const unparsed = await pairedEntailment(async () => "entailment", "Tom ran.", text, async () => null);
  assert.deepEqual(unparsed, { label: null, opposite: null, answers: { proposition: null, opposite: null } });
});
