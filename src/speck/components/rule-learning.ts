// Rule learning as a component (admitted 2026-10-20): labelled examples the
// user writes in mapping notation are read structurally, Speck derives the
// rules they allow, and a message about them gets the derivation as notes. A
// reply that gives an asked item a label other than the one every preferred
// rule agrees on is replaced by Speck's answer.
//
// Evidence: four-arm C+ 100% against C 85.6% on unseen rule tasks; partial
// blind follow-up B′ 34/34 against plain 30/34; default-path runs: varied
// held-out set equal to plain (27/28 each), no cost on general turns.

import { predictionFaults } from "../../cognition/induction-answer.js";
import type { Component, TurnContext } from "../component.js";
import { readExamples } from "../examples.js";
import { addExamples, contribution } from "../rule-learning.js";

type Found = NonNullable<ReturnType<typeof contribution>>;

export const ruleLearning: Component = {
  id: "rule",

  async observe(context) {
    const read = await readExamples(context.registry, context.readerProcessorId, context.message);
    const added = read ? addExamples(context.session.rules, context.turn, read.accepted, read.rejected) : 0;
    context.scratch.set("rule.read", { examplesAdded: added, readerRejected: read?.rejected.length ?? 0 });
  },

  async contribute(context) {
    const found = contribution(context.session.rules, context.message, context.turn);
    if (!found) return null;
    context.scratch.set("rule.found", found);
    // The section after the shared heading (component.ts NOTES_HEADING).
    return found.notes.split("\n").slice(2).join("\n");
  },

  async review(context, reply) {
    const found = context.scratch.get("rule.found") as Found | undefined;
    if (!found) return null;
    const labels = [...new Set(context.session.rules.examples.map((example) => example.label))];
    const settled = found.predictions.length === 1 ? found.predictions[0]! : null;
    if (!settled?.label || !predictionFaults(reply, found.predictions, labels).length) return null;
    return {
      reply: `${settled.item}: ${settled.label}. (Speck's rule: ${found.standing.leading?.assessment.description ?? "the preferred rules agree"}.)`,
      reason: `every preferred rule gives ${settled.item} → ${settled.label}`
    };
  },

  record(context) {
    return context.scratch.get("rule.read") as Record<string, unknown> ?? {};
  }
};
