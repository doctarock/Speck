// The reader's structural support check: which model-read pairs a message
// writes as examples. Cases include the exact spurious pairs found in the
// four-arm evaluation (2026-10-19). The check uses no word lists.

import assert from "node:assert/strict";
import test from "node:test";
import { supportExample, supportExamples } from "../cognition/example-support.js";

const reason = (text: string, item: string, label: string) => {
  const result = supportExample(text, { item, label });
  return "reason" in result ? result.reason : "accepted";
};

test("examples written in mapping notation are accepted, with the line that writes them", () => {
  const text = "I'll give you labelled items. Work out what decides the label.\nK12 → Teal\nK15 -> Amber\nK22 => Teal\nK33: Amber\nK40 = Teal\nK41 ⇒ Amber";
  for (const [item, label] of [["K12", "Teal"], ["K15", "Amber"], ["K22", "Teal"], ["K33", "Amber"], ["K40", "Teal"], ["K41", "Amber"]] as const) {
    const result = supportExample(text, { item, label });
    assert.ok(!("reason" in result), `${item} → ${label}`);
    assert.match(result.sentence, new RegExp(item));
  }
  assert.equal(reason("apple → Blue\ncarrot → Red", "apple", "Blue"), "accepted");
  assert.equal(reason("Sorry, I got one wrong: K42 → Amber.", "K42", "Amber"), "accepted");
});

test("the pairs found in the four-arm evaluation are rejected", () => {
  assert.equal(reason("What label does T98 get? Answer with just the label.", "T98", "T98"), "self-mapping");
  assert.equal(reason("What label does Z20 get? Answer with just the label.", "Z20", "label"), "no-explicit-mapping");
  assert.equal(reason("Quick one: what is 5 times 11?", "5", "times"), "no-explicit-mapping");
  assert.equal(reason("My locker number is 27.", "27", "locker number"), "no-explicit-mapping");
});

test("a pair written inside a question or inside quotation marks is not asserted", () => {
  assert.equal(reason("Is K47 → Teal?", "K47", "Teal"), "question");
  assert.equal(reason("If K12 → Teal, what would K13 be?", "K12", "Teal"), "question");
  assert.equal(reason("He wrote \"K12 → Teal\" on the board.", "K12", "Teal"), "quoted");
  assert.equal(reason("She said “K12 → Teal” yesterday.", "K12", "Teal"), "quoted");
});

test("examples in prose are not accepted (the cost of using no word lists)", () => {
  assert.equal(reason("H46 is Sand. H57 is Plum.", "H46", "Sand"), "no-explicit-mapping");
  assert.equal(reason("K42 is not Teal.", "K42", "Teal"), "no-explicit-mapping");
  assert.equal(reason("Suppose G71 is Rust.", "G71", "Rust"), "no-explicit-mapping");
  assert.equal(reason("Room 12 is on the second floor and room 30 is upstairs.", "room 30", "upstairs"), "no-explicit-mapping");
});

test("a known limit: a hypothetical written in notation, without a question mark, is accepted", () => {
  // Telling it apart needs the meaning of "suppose", which a structural check
  // does not have. Recorded so the limit is visible.
  assert.equal(reason("Suppose G71 → Rust.", "G71", "Rust"), "accepted");
});

test("swapped pairs are restored to the message's order", () => {
  const swapped = supportExample("Here are some: H11: Plum, H24: Sand.", { item: "Plum", label: "H11" });
  assert.ok(!("reason" in swapped) && swapped.item === "H11" && swapped.label === "Plum" && swapped.swapped === true);
  const arrow = supportExample("J13 => Flint\nJ26 => Pearl", { item: "Flint", label: "J13" });
  assert.ok(!("reason" in arrow) && arrow.item === "J13" && arrow.label === "Flint");
});

test("identifiers the message does not contain, and incomplete pairs, are rejected", () => {
  assert.equal(reason("K12 → Teal\nK15 → Amber", "K99", "Teal"), "no-explicit-mapping");
  assert.equal(reason("K12 → Teal", "", "Teal"), "incomplete");
  assert.equal(reason("K12 → Teal", "K12", " "), "incomplete");
});

test("duplicates are accepted once; contradictions are each accepted here and settled when held", () => {
  const read = supportExamples("K12 → Teal\nK12 → Teal\nK15 → Amber", [{ item: "K12", label: "Teal" }, { item: "k12", label: "teal" }, { item: "K15", label: "Amber" }]);
  assert.deepEqual(read.accepted.map((entry) => `${entry.item}→${entry.label}`), ["K12→Teal", "K15→Amber"]);
  const conflicting = supportExamples("K12 → Teal\nK12 → Amber", [{ item: "K12", label: "Teal" }, { item: "K12", label: "Amber" }]);
  assert.equal(conflicting.accepted.length, 2, "both are written; InductionWork withdraws the contradicted item");
});

test("item and label are matched as whole words, case-insensitively, including non-ASCII letters", () => {
  assert.equal(reason("k12 → teal", "K12", "Teal"), "accepted");
  assert.equal(reason("K120 → Teal", "K12", "Teal"), "no-explicit-mapping");
  assert.equal(reason("Tromsø → Øst", "Tromsø", "Øst"), "accepted");
});
