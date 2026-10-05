// How an induction standing is put into words: the report the writer is shown,
// and the sentence Speck adds to a reply itself. Pure functions of the
// standing (induction-standing.ts), so what is shown and what is stated come
// from the same computation.
import { generalises } from "./induction.js";
import { confirmingExamples } from "./induction-standing.js";
const describeExample = (example) => `${example.item} → ${example.label}`;
// A rule's short name: its feature, and for a threshold, where it splits.
export function ruleName(rule) {
    return rule.kind === "threshold" ? `${rule.feature} at ${rule.threshold}` : rule.feature;
}
// A rule as name and mapping: "remainder of the number divided by 4 (0, 2 → Red; 1, 3 → Blue)".
export function formalRule(assessment) {
    const mapping = assessment.description.split(" determines the label: ")[1];
    return mapping === undefined ? assessment.description : `${ruleName(assessment.rule)} (${mapping})`;
}
function listNames(names) {
    if (names.length <= 1)
        return names[0] ?? "none of them";
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
// What each answer to the experiment would leave standing, by rule name.
function outcomesOf(experiment, standing) {
    const named = new Map(standing.surviving.map((entry) => [entry.assessment.description, ruleName(entry.assessment.rule)]));
    return experiment.outcomes.map((outcome) => {
        const names = outcome.remaining.map((description) => named.get(description) ?? description);
        return `if it is ${outcome.label}, ${listNames(names)} ${names.length === 1 ? "remains" : names.length ? "remain" : "survives"}`;
    }).join("; ");
}
// Rules the standing found to be one rule described two ways.
function equivalences(standing) {
    return standing.surviving.flatMap((representative) => representative.equivalent.map((same) => ({ representative, same })));
}
// The report the writer is shown: every rule against every example, what the
// current message changed, Speck's conclusion, and the next example.
export function renderInductionReport(standing, currentEvidenceId) {
    const { examples } = standing;
    // What the examples in the user's current message did to each rule.
    const fresh = examples.filter((example) => example.evidenceId === currentEvidenceId);
    const changed = [];
    const lines = [];
    for (const { assessment, confidence, equivalent } of standing.surviving) {
        const confirmed = confirmingExamples(assessment.rule, examples);
        const now = confirmed.filter((example) => example.evidenceId === currentEvidenceId);
        if (now.length)
            changed.push(`- confirmed: ${assessment.description} (predicted ${now.map(describeExample).join(", ")})`);
        lines.push(`- SURVIVES: ${assessment.description} [confidence ${confidence.toFixed(2)}; ${confirmed.length} prediction(s) confirmed${generalises(assessment) ? "" : "; each value seen once, so it explains nothing yet"}]`);
        for (const same of equivalent)
            lines.push(`  - SAME RULE: ${same.assessment.description} [predicts the same label as it for every item, so it is not an alternative]`);
    }
    for (const { assessment } of standing.refuted) {
        const counter = assessment.counterExample;
        if (counter && fresh.some((example) => example.item === counter.item))
            changed.push(`- refuted: ${assessment.description} (by ${describeExample(counter)})`);
        lines.push(`- REFUTED: ${assessment.description} [by ${counter?.item} → ${counter?.label}]`);
    }
    // The choice between rules is Speck's, not the writer's.
    const leading = standing.leading;
    const conclusion = leading && standing.preferred.length
        ? `\nSPECK'S CONCLUSION: the best supported rule is "${leading.assessment.description}". It is consistent with all ${examples.length} examples, and ${confirmingExamples(leading.assessment.rule, examples).length} of them were predicted by it before they were seen. It is preferred as the simplest rule that generalises.`
            + standing.preferred.slice(1).map((other) => ` "${other.assessment.description}" is equally simple and also consistent with every example.`).join("")
        : "\nSPECK'S CONCLUSION: no rule is supported yet; every rule consistent with the examples only restates them.";
    const changedLine = fresh.length
        ? `\nWHAT THE CURRENT MESSAGE CHANGED (${fresh.map(describeExample).join(", ")}):\n${changed.length ? changed.join("\n") : "- no rule was confirmed or refuted"}`
        : "";
    const next = standing.next;
    const nextLine = next
        ? `\nMOST INFORMATIVE NEXT EXAMPLE: ${next.item} (${outcomesOf(next, standing)})`
        : standing.surviving.length > 1 ? "\nNO FURTHER EXAMPLE CAN TELL THE REMAINING RULES APART" : "";
    return `\nRULES (Speck checked each against every example: ${examples.map(describeExample).join(", ")}):\n${lines.join("\n")}${changedLine}${conclusion}${nextLine}`;
}
// Shortcut S24 (docs/COGNITIVE_SHORTCUTS.md): the part of a reply Speck states
// itself: rules found to be the same rule, and while the standing is
// unsettled, the rules still standing beside the conclusion (as mappings), the
// rules ruled out and by what, and the unseen example whose answer would tell
// most, with what each answer would leave. The conclusion is the writer's to
// state; it is included only when `written` leaves it out. Null when there is
// nothing to add.
export function renderInductionStatement(standing, written, statesConclusion) {
    const { examples, leading, next } = standing;
    if (!leading)
        return null;
    const conclusion = standing.preferred.length && !statesConclusion(written)
        ? `The best supported rule is "${leading.assessment.description}": it is consistent with all ${examples.length} examples, and ${confirmingExamples(leading.assessment.rule, examples).length} of them were predicted by it before they were seen.`
        : "";
    const same = equivalences(standing).map(({ representative, same: other }) => `${formalRule(other.assessment)} predicts the same label as ${ruleName(representative.assessment.rule)} for every item, so it is the same rule, not an alternative.`);
    if (!next) {
        const apart = standing.surviving.length > 1 ? [`No further example can tell ${listNames(standing.surviving.map((entry) => ruleName(entry.assessment.rule)))} apart.`] : [];
        return [conclusion, ...same, ...apart].filter(Boolean).join(" ") || null;
    }
    const standingRules = standing.surviving.slice(1, 4).map((entry) => formalRule(entry.assessment));
    const refuted = standing.refuted
        .filter((entry) => entry.assessment.counterExample)
        .map((entry) => `${ruleName(entry.assessment.rule)} (by ${describeExample(entry.assessment.counterExample)})`);
    return [
        conclusion,
        ...same,
        standingRules.length ? `Alternatives still consistent with every example: ${standingRules.join("; ")}.` : "",
        refuted.length ? `Ruled out: ${refuted.join("; ")}.` : "",
        `The most informative next example is ${next.item}: ${outcomesOf(next, standing)}.`,
        generalises(leading.assessment) ? "" : "No rule generalises yet."
    ].filter(Boolean).join(" ");
}
//# sourceMappingURL=induction-render.js.map