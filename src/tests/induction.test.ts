import assert from "node:assert/strict";
import test from "node:test";
import { claimedActions, conflictingClaims, correctCounts, countsOf, ungroundedNumbers, unperformedActions } from "../cognition/claims.js";
import { itemsMentioned, mostInformativeExample, probeDomain, statesRule, survivingRules, type LabelledExample } from "../cognition/induction.js";
import { groundableInduction, preferredPrediction, standingOf, unsettled } from "../cognition/induction-standing.js";
import { groundReply, mayClaimItems, type GroundableState } from "../cognition/reply-grounding.js";

const examples = (pairs: Array<[string, string]>): LabelledExample[] => pairs.map(([item, label], index) => ({ item, label, evidenceId: `e${index}` }));

test("induction keeps the rules every example satisfies, simplest first", () => {
  const first = survivingRules(examples([["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"]]));
  assert.equal(first[0]!.description, "parity of the number determines the label: even → Red; odd → Blue");
  assert.ok(first.length > 1, "several rules survive three examples");
  const all = survivingRules(examples([
    ["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"], ["A42", "Red"], ["A55", "Blue"], ["A63", "Blue"], ["A72", "Red"], ["A81", "Blue"]
  ]));
  assert.equal(all[0]!.description, "parity of the number determines the label: even → Red; odd → Blue");
  assert.ok(all.length < first.length, "later examples eliminate competing rules");
});

const EIGHT: Array<[string, string]> = [["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"], ["A42", "Red"], ["A55", "Blue"], ["A63", "Blue"], ["A72", "Red"], ["A81", "Blue"]];

test("a counter-example refutes a rule, and each rule is stated as its full mapping", () => {
  const few = examples([["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"]]);
  const rules = survivingRules(few);
  const describe = (feature: string) => rules.find((rule) => rule.rule.feature === feature)!.description;
  assert.equal(describe("digit sum"), "digit sum determines the label: 4, 8 → Blue; 6 → Red");
  assert.equal(describe("last digit"), "last digit determines the label: 1, 7 → Blue; 4 → Red; not yet seen: 0, 2, 3, 5, 6, 8, 9");
  const refuted = survivingRules(examples([["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"], ["A33", "Red"]]));
  assert.ok(!refuted.some((rule) => rule.key === "value:parity of the number"), "A33 → Red refutes parity");
});

test("rules that predict the same label for every item are one hypothesis, not competitors", () => {
  const all = examples(EIGHT);
  const held = survivingRules(all).map((assessment) => ({ rule: assessment.rule, confidence: 0.5 }));
  const standing = standingOf(all, held);
  const parity = standing.surviving.find((entry) => entry.assessment.rule.feature === "parity of the number")!;
  assert.deepEqual(parity.equivalent.map((entry) => entry.assessment.description), ["remainder of the number divided by 4 determines the label: 0, 2 → Red; 1, 3 → Blue"]);
  assert.ok(!standing.surviving.some((entry) => entry.assessment.rule.feature === "remainder of the number divided by 4"), "not listed as a separate survivor");
  // With only parity and its equivalent held, there is nothing left to test.
  const only = standingOf(all, held.filter((entry) => ["parity of the number", "remainder of the number divided by 4"].includes(entry.rule.feature)));
  assert.equal(only.surviving.length, 1);
  assert.equal(only.next, null);
  assert.ok(!unsettled(only));
});

test("the next example is the one whose answer is expected to eliminate the most of the surviving rules' weight", () => {
  const few = examples([["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"]]);
  const rules = survivingRules(few).map((assessment) => ({ assessment, weight: 0.5 }));
  const next = mostInformativeExample(few, rules)!;
  assert.ok(next && !["A17", "A24", "A31"].includes(next.item));
  // The leading rules make different concrete predictions for it.
  assert.ok(new Set(next.predictions.map((prediction) => prediction.label).filter(Boolean)).size > 1);
  // Each answer eliminates some rule, and the item is from the probe domain.
  for (const outcome of next.outcomes) assert.ok(outcome.remaining.length < rules.length, `${outcome.label} eliminates something`);
  assert.ok(next.expectedRemaining < 1);
  assert.ok(probeDomain(few).includes(next.item));
});


test("Speck recognises its own rules in a reply by the words their features are stated in", () => {
  const rules = survivingRules(examples(EIGHT));
  const parity = rules.find((rule) => rule.rule.feature === "parity of the number")!;
  const byFour = rules.find((rule) => rule.rule.feature === "remainder of the number divided by 4")!;
  assert.ok(statesRule("Even numbers are Red and odd numbers are Blue.", parity.rule));
  assert.ok(statesRule("It looks like parity decides the colour.", parity.rule));
  assert.ok(!statesRule("The label depends on the first digit.", parity.rule));
  assert.ok(statesRule("It depends on the remainder when divided by 4.", byFour.rule));
  assert.ok(!statesRule("It depends on the remainder when divided by 3.", byFour.rule));
});

test("a reply's quantities must be ones its writer was shown", () => {
  const shown = "It is consistent with all 8 examples, and 4 of them were predicted by it before they were seen. A17 → Blue";
  assert.deepEqual(ungroundedNumbers("Parity is confirmed by 6 out of 8 examples, including A17.", shown), ["6"]);
  assert.deepEqual(ungroundedNumbers("Parity fits all 8 examples; 4 were predicted.", shown), []);
});

test("a reply's item claims are checked against the examples and the preferred rule's predictions", () => {
  const held = examples(EIGHT);
  const standing = standingOf(held, [{ rule: survivingRules(held)[0]!.rule, confidence: 1 }]);
  const conflicts = conflictingClaims([
    { item: "A63", label: "Red" },    // contradicts an observed example
    { item: "A90", label: "Blue" },   // contradicts parity's prediction
    { item: "A10", label: "Red" },    // agrees with parity's prediction
    { item: "Even numbers", label: "Red" } // not an item the rule predicts: unchecked
  ], held, (item) => preferredPrediction(standing, item));
  assert.deepEqual(conflicts, [
    { item: "A63", claimed: "Red", expected: "Blue", basis: "observed" },
    { item: "A90", claimed: "Blue", expected: "Red", basis: "predicted" }
  ]);
});

test("items a reply names are recognised by the shape of the examples' items", () => {
  assert.deepEqual(itemsMentioned("A4 would separate parity from digit sum; a4 again, but not BA4 or A4b.", examples(EIGHT)), ["A4"]);
  assert.deepEqual(itemsMentioned("Try A10 or A63 next.", examples(EIGHT)), ["A10", "A63"]);
});

test("one standing gives the survivors, the conclusion and the next example together", () => {
  const few = examples([["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"]]);
  const held = survivingRules(few).map((assessment) => ({ rule: assessment.rule, confidence: 0.5 }));
  const standing = standingOf(few, held);
  assert.equal(standing.leading?.assessment.description, "parity of the number determines the label: even → Red; odd → Blue");
  assert.deepEqual(standing.preferred.map((entry) => entry.assessment.rule.feature), ["parity of the number"]);
  assert.ok(unsettled(standing), "the survivors still disagree on an unseen item");
  assert.equal(standing.next?.item, "A4");
  // A counter-example moves a held rule from surviving to refuted.
  const after = standingOf([...few, { item: "A33", label: "Red", evidenceId: "e3" }], held);
  assert.ok(after.refuted.some((entry) => entry.assessment.rule.feature === "parity of the number"));
  assert.ok(!after.surviving.some((entry) => entry.assessment.rule.feature === "parity of the number"));
  // The standing as a groundable state.
  const state = groundableInduction(standing);
  assert.ok(state.conclusion!.statedIn("Even numbers are Red."));
  assert.equal(state.predict("A10"), "Red");
  assert.deepEqual(state.proposal!.unseenItemsIn("Try A2, or A17 again."), ["A2"]);
});

test("reply grounding needs only a groundable state, whatever substrate supplies it", () => {
  // A hand-made state, not induction: a diagnosis that predicts by lookup.
  const state: GroundableState = {
    conclusion: { description: "the fuse has blown", statedIn: (text) => /fuse/i.test(text) },
    observed: [{ item: "lamp", label: "off" }],
    labels: ["on", "off"],
    itemIn: (subject) => ["lamp", "kettle"].includes(subject.trim().toLowerCase()) ? subject.trim().toLowerCase() : null,
    predict: (item) => item === "kettle" ? "off" : null,
    proposal: null,
    counts: []
  };
  assert.ok(mayClaimItems("The kettle will be on.", state));
  const faults = groundReply({ reply: "The breaker tripped; the lamp is on and the kettle will be on, 3 times over.", shown: "lamp is off", state, claims: [{ item: "lamp", label: "on" }, { item: "kettle", label: "on" }] });
  assert.deepEqual(faults.map((fault) => fault.kind), ["conclusion-unstated", "ungrounded-number", "observed-conflict", "predicted-conflict"]);
  assert.deepEqual(groundReply({ reply: "The fuse has blown; the lamp is off.", shown: "", state, claims: [{ item: "lamp", label: "off" }] }), []);
});

test("a claim whose subject only mentions an item says nothing about that item", () => {
  // From a live run: the extraction role read this phrase as an item, and a
  // faithful reply was rejected for "saying A4 would be Blue".
  const few = examples([["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"]]);
  const standing = standingOf(few, survivingRules(few).map((assessment) => ({ rule: assessment.rule, confidence: 0.5 })));
  const state = groundableInduction(standing);
  const reply = "Parity fits. The most informative next example is A4: parity of the number predicts Red, digit sum predicts Blue.";
  const phrase = { item: "A4: parity of the number predicts Red, digit sum predicts", label: "Blue" };
  assert.equal(state.itemIn(phrase.item), null);
  assert.equal(state.itemIn(" a4. "), "A4");
  assert.deepEqual(groundReply({ reply, shown: "A4", state, claims: [phrase] }).filter((fault) => fault.kind.endsWith("conflict")), []);
  assert.deepEqual(groundReply({ reply, shown: "A4", state, claims: [{ item: "A4", label: "Blue" }] }).map((fault) => fault.kind), ["predicted-conflict"]);
});

test("a reply's count of examples, in digits or words, must be the count Speck holds", () => {
  assert.deepEqual(countsOf("It is consistent with all three examples, then the 8 examples; these five labelled examples.", "example"), [3, 8, 5]);
  assert.deepEqual(countsOf("4 of them were predicted; one more example would help; two new examples could settle it.", "example"), []);
  // From a live run: the writer copied "all three examples" while Speck held five.
  const five = examples([["A17", "Blue"], ["A24", "Red"], ["A31", "Blue"], ["A42", "Red"], ["A55", "Blue"]]);
  const state = groundableInduction(standingOf(five, survivingRules(five).map((assessment) => ({ rule: assessment.rule, confidence: 0.5 }))));
  const faults = groundReply({ reply: "Parity is consistent with all three examples provided.", shown: "", state, claims: null });
  assert.deepEqual(faults.filter((fault) => fault.kind === "miscounted").map((fault) => fault.message), ["It says 3 examples, but Speck holds 5."]);
  assert.deepEqual(groundReply({ reply: "Parity is consistent with all five examples.", shown: "", state, claims: null }).filter((fault) => fault.kind === "miscounted"), []);
});

test("a definite count Speck holds is corrected in the writer's own style", () => {
  assert.equal(correctCounts("It is consistent with all three examples provided.", "example", 5), "It is consistent with all five examples provided.");
  assert.equal(correctCounts("All 3 examples fit; one more example would help.", "example", 6), "All 6 examples fit; one more example would help.");
  assert.equal(correctCounts("These Three examples fit.", "example", 8), "These Eight examples fit.");
});

test("a number is grounded however the writer was shown it", () => {
  // From the model-scale baseline: the notes said "2am", the reply "2 am".
  assert.deepEqual(ungroundedNumbers("Backups run nightly at 2 am on level 3.", "Backups run nightly at 2am. The server room is on level 3."), []);
  assert.deepEqual(ungroundedNumbers("A17 is item 17; there are 5 of them.", "A17 → Blue"), ["5"]);
});

test("a claimed action is unfounded only when Speck's record shows no operation at all", () => {
  assert.deepEqual(unperformedActions(["I've booked it"], 0), ["I've booked it"]);
  assert.deepEqual(unperformedActions(["I've saved the poem"], 1), [], "matching a claim to an operation is not decided here");
  assert.deepEqual(unperformedActions([], 0), []);
});

test("a reply's completed world actions are read from its grammar, not its offers, questions or own work", () => {
  const claimed = (reply: string) => claimedActions(reply).length > 0;
  // Claims, as the writers in the series made them.
  for (const reply of [
    "I've booked it for Tuesday at 7. Let me know if you need anything else!",
    "I've booked Tuesday at 7 for you.",
    "I have saved the poem to rain.txt.",
    "Your appointment has been booked for Tuesday at 7.",
    "Done. Your table is now booked.",
    "I sent the invitation this morning."
  ]) assert.ok(claimed(reply), reply);
  // Not claims: offers, plans, questions, negations, and the reply's own work.
  for (const reply of [
    "I'll book it for Tuesday at 7 PM.",
    "Understood. I will book it for Tuesday at 7 PM.",
    "What would you like me to book for Tuesday at 7?",
    "Is it booked already?",
    "I haven't booked anything yet.",
    "Okay, I've noted that you want to book it for Tuesday at 7. Let me confirm: are you referring to a specific event?",
    "I've noted your request to book it for Tuesday at 7. Please confirm if you need any further assistance.",
    "17 plus 25 is 42.",
    "I've updated the rule: parity of the number determines the label.",
    "I've added A63 to the examples.",
    // Reasoning and arrangement, from the series' rule replies.
    "This rule is confirmed for all 8 examples and predicted both new examples correctly before they were seen.",
    "The rule is called parity.",
    "I called it the parity rule.",
    "The examples are ordered by number.",
    "I arranged the examples by label.",
    "The server room is on level 3, backups run nightly at 2am, and the UPS was replaced in March."
  ]) assert.ok(!claimed(reply), reply);
  assert.deepEqual(claimedActions("Thanks! I've booked it for Tuesday. Anything else?"), ["I've booked it for Tuesday."]);
});
