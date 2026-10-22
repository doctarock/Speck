// A message unrelated to a task's induction is answered as itself: the rule
// state is not shown, does not make the reply provisional, is not checked
// against it, and Speck adds no rule statement. Found in the four-arm
// evaluation: arithmetic asked between examples was answered with the rule.

import assert from "node:assert/strict";
import test from "node:test";
import { concernsInduction } from "../cognition/induction-relevance.js";
import { completion, descriptors, withFixture } from "./support/controller-fixture.js";

const EXAMPLES = [{ item: "K12", label: "Teal" }, { item: "K15", label: "Amber" }].map((pair, index) => ({ ...pair, evidenceId: `e${index}` }));

test("which messages concern a task's induction", () => {
  assert.equal(concernsInduction("Quick one: what is 6 plus 12?", EXAMPLES, 0), false);
  // No operands of its own, so it stays with the task (no word lists decide otherwise).
  assert.equal(concernsInduction("What is my favourite tea?", EXAMPLES, 0), true);
  assert.equal(concernsInduction("How many apples is 3 times 4?", EXAMPLES, 0), false, "numbers of its own");
  assert.equal(concernsInduction("What label does K45 get?", EXAMPLES, 0), true, "names an item of the examples' shape");
  assert.equal(concernsInduction("Is it Teal?", EXAMPLES, 0), true, "names a label");
  assert.equal(concernsInduction("What rule decides it?", EXAMPLES, 0), true, "asks about the rule");
  assert.equal(concernsInduction("Here you go.", EXAMPLES, 2), true, "gives stated examples");
  assert.equal(concernsInduction("k99, please", EXAMPLES, 0), true, "item shape matched without case");
});

