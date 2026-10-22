// Speck applies its rule to the item a message asks about: the writer is
// told the label the preferred rules agree on, and a reply giving another
// label is turned back with the correction (smoke-d, 2026-10-20: the writer
// stated the rule correctly, then mislabelled the item).

import assert from "node:assert/strict";
import test from "node:test";
import { askedPredictions, predictionFaults, renderPredictions } from "../cognition/induction-answer.js";
import { survivingRules } from "../cognition/induction.js";
import { standingOf } from "../cognition/induction-standing.js";
import { completion, descriptors, withFixture } from "./support/controller-fixture.js";

const PAIRS: Array<[string, string]> = [["K12", "Teal"], ["K15", "Amber"], ["K22", "Teal"], ["K33", "Amber"], ["K40", "Teal"], ["K57", "Amber"]];
const examples = PAIRS.map(([item, label], index) => ({ item, label, evidenceId: `e${index}` }));
const standing = standingOf(examples, survivingRules(examples).map((entry) => ({ rule: entry.rule, confidence: 0.5 })));

test("the asked item's label is Speck's when its preferred rules agree, and open when they disagree", () => {
  assert.deepEqual(askedPredictions("What label does K45 get? Answer with just the label.", standing), [{ item: "K45", label: "Amber" }]);
  assert.deepEqual(askedPredictions("And K61?", standing), [{ item: "K61", label: null }], "parity and the thresholds disagree on K61");
  assert.deepEqual(askedPredictions("What label does K12 get?", standing), [], "a seen example is not a prediction");
  assert.match(renderPredictions([{ item: "K45", label: "Amber" }]), /K45 → Amber/);
});

test("a reply must give the predicted label first", () => {
  const asked = [{ item: "K45", label: "Amber" }];
  assert.deepEqual(predictionFaults("Amber", asked, ["Teal", "Amber"]), []);
  assert.deepEqual(predictionFaults("K45 is Amber: odd numbers are Amber, even ones Teal.", asked, ["Teal", "Amber"]), []);
  assert.match(predictionFaults("Teal", asked, ["Teal", "Amber"])[0]!, /K45 → Amber/);
  assert.equal(predictionFaults("Teal", [{ item: "K61", label: null }], ["Teal", "Amber"]).length, 0, "nothing is imposed when the rules disagree");
});

test("a reply that states the rule before answering is not a fault; a rival label beside the item is (default-path run, 2026-10-20)", () => {
  const m52 = [{ item: "M52", label: "silver" }];
  const labels = ["gold", "silver"];
  assert.deepEqual(predictionFaults("Based strictly on the pattern you defined (odd numbers = gold, even numbers = silver), here's the answer:\n\n**M52 = Silver**", m52, labels), []);
  assert.deepEqual(predictionFaults("Based on the best-supported rule (parity: odd → gold, even → silver), the tag for **M52** is:\n**silver**.", m52, labels), []);
  assert.deepEqual(predictionFaults("Odd numbers are gold and even ones silver.", m52, labels), [], "the predicted label is given though the item is not named");
  const bx45 = [{ item: "BX45", label: "Ochre" }];
  assert.match(predictionFaults("The rule is the remainder divided by 3: 0 → Ochre, otherwise Saffron. So BX45 is Saffron.", bx45, ["Ochre", "Saffron"])[0]!, /gives Saffron/);
  assert.match(predictionFaults("I can't tell from these examples.", m52, labels)[0]!, /state it/);
});

