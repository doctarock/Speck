// The deterministic derivation as it stands, pinned before the reader
// remediation: what it concludes from valid examples, and how it behaves on
// reordered, duplicated, malformed, missing and contradictory examples. The
// derivation is not changed by the remediation; these tests show it is not.

import assert from "node:assert/strict";
import test from "node:test";
import { ruleKey, survivingRules, type LabelledExample } from "../cognition/induction.js";
import { learnable, preferredPrediction, standingOf, type InductionStanding } from "../cognition/induction-standing.js";

const examples = (pairs: Array<[string, string]>): LabelledExample[] => pairs.map(([item, label], index) => ({ item, label, evidenceId: `e${index}` }));
// As InductionWork holds them: every surviving rule adopted at confidence 0.5.
const standing = (given: LabelledExample[]): InductionStanding => standingOf(given, survivingRules(given).map((entry) => ({ rule: entry.rule, confidence: 0.5 })));
const summary = (state: InductionStanding) => ({
  surviving: state.surviving.map((entry) => ruleKey(entry.assessment.rule)),
  preferred: state.preferred.map((entry) => ruleKey(entry.assessment.rule)),
  predictions: ["K47", "K50", "K61", "K88"].map((item) => preferredPrediction(state, item))
});

const PARITY: Array<[string, string]> = [["K12", "Teal"], ["K15", "Amber"], ["K22", "Teal"], ["K33", "Amber"], ["K40", "Teal"], ["K57", "Amber"]];

test("valid examples: parity is among the preferred rules; unseen items are predicted only where the preferred rules agree", () => {
  const state = summary(standing(examples(PARITY)));
  assert.ok(state.preferred.includes("value:parity of the number"));
  // Parity, a digit-sum threshold and a last-digit threshold are equally
  // preferred on these six examples. They agree on K47 and K50, and disagree
  // on K61 and K88, where the derivation abstains.
  assert.deepEqual(state.predictions, ["Amber", "Teal", null, null]);
});

test("the derivation does not depend on the order the examples arrive in", () => {
  const reference = summary(standing(examples(PARITY)));
  for (const order of [[5, 4, 3, 2, 1, 0], [3, 0, 5, 1, 4, 2], [1, 3, 5, 0, 2, 4]]) {
    assert.deepEqual(summary(standing(examples(order.map((index) => PARITY[index]!)))), reference, `order ${order.join(",")}`);
  }
});

test("a repeated example changes nothing", () => {
  assert.deepEqual(summary(standing(examples([...PARITY, ["K12", "Teal"], ["K15", "Amber"]]))), summary(standing(examples(PARITY))));
});

test("items outside the feature vocabulary (no number) yield no conclusion and no prediction", () => {
  const state = summary(standing(examples([["apple", "Teal"], ["pear", "Amber"], ["plum", "Teal"]])));
  assert.deepEqual(state.preferred, []);
  assert.deepEqual(state.predictions, [null, null, null, null]);
});

test("too few examples are not learnable, and none give nothing", () => {
  assert.equal(learnable(examples([["K12", "Teal"]])), false);
  assert.equal(learnable(examples([])), false);
  assert.deepEqual(summary(standing(examples([]))), { surviving: [], preferred: [], predictions: [null, null, null, null] });
});

test("contradictory labels for one item leave no surviving rule, so nothing is predicted (abstention)", () => {
  const state = summary(standing(examples([...PARITY, ["K12", "Amber"]])));
  assert.deepEqual(state.surviving, []);
  assert.deepEqual(state.predictions, [null, null, null, null]);
});

test("one self-mapping in the examples destroys the conclusion: why the reader must keep it out", () => {
  const clean = summary(standing(examples(PARITY)));
  const polluted = summary(standing(examples([...PARITY, ["K45", "K45"]])));
  assert.ok(!polluted.preferred.includes("value:parity of the number"));
  assert.notDeepEqual(polluted.predictions, clean.predictions);
});
