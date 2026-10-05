// Where a task's induction stands: one computation of the rules the task
// holds against every example, used wherever Speck reports, checks or states
// that standing, so what the writer is shown, what its reply is checked
// against, and what Speck adds to the reply cannot disagree.
import { assess, compareRules, equallyPreferred, generalises, itemsMentioned, mostInformativeExample, observationallyEquivalent, predict, probeDomain, statesRule } from "./induction.js";
// Whether examples are enough to learn from: two or more, with two labels.
export function learnable(examples) {
    return examples.length >= 2 && new Set(examples.map((example) => example.label.toUpperCase())).size >= 2;
}
export function standingOf(examples, held) {
    const assessed = held.map((entry) => ({ assessment: assess(entry.rule, examples), confidence: entry.confidence, equivalent: [] }));
    const consistent = assessed.filter((entry) => entry.assessment.consistent).sort((left, right) => compareRules(left.assessment, right.assessment));
    const refuted = assessed.filter((entry) => !entry.assessment.consistent);
    // Rules that make identical predictions over the whole domain are one
    // hypothesis; the preferred description stands for the class.
    const domain = probeDomain(examples);
    const surviving = [];
    for (const entry of consistent) {
        const same = surviving.find((representative) => observationallyEquivalent(representative.assessment.rule, entry.assessment.rule, examples, domain));
        if (same)
            same.equivalent.push(entry);
        else
            surviving.push(entry);
    }
    const leading = surviving[0] ?? null;
    const preferred = leading && generalises(leading.assessment)
        ? [leading, ...surviving.slice(1).filter((other) => equallyPreferred(leading.assessment, other.assessment))]
        : [];
    const next = mostInformativeExample(examples, surviving.map((entry) => ({ assessment: entry.assessment, weight: entry.confidence })));
    return { examples, surviving, refuted, leading, preferred, next };
}
// Whether the standing leaves the answer open: some unseen item's answer
// would still eliminate a surviving rule.
export function unsettled(standing) {
    return standing.next !== null;
}
// Examples that confirmed a prediction the rule made from the examples before
// them: the support a rule earns, as opposed to merely not being refuted.
export function confirmingExamples(rule, examples) {
    return examples.filter((example, index) => predict(rule, examples.slice(0, index), example.item) === example.label);
}
// The label the preferred rules agree on for an item; null when they
// disagree, none predicts, or there is no conclusion.
export function preferredPrediction(standing, item) {
    const labels = new Set(standing.preferred.map((entry) => predict(entry.assessment.rule, standing.examples, item)));
    if (labels.size !== 1)
        return null;
    const [label] = [...labels];
    return label ?? null;
}
// The standing as a state a reply can be grounded in.
export function groundableInduction(standing) {
    const leading = standing.leading;
    const seen = new Set(standing.examples.map((example) => example.item.trim().toUpperCase()));
    return {
        conclusion: leading && standing.preferred.length
            ? { description: leading.assessment.description, statedIn: (text) => standing.preferred.flatMap((entry) => [entry, ...entry.equivalent]).some((entry) => statesRule(text, entry.assessment.rule)) }
            : null,
        observed: standing.examples.map((example) => ({ item: example.item, label: example.label })),
        labels: [...new Set(standing.examples.map((example) => example.label))],
        // An item is a subject that is exactly one item-shaped token.
        itemIn: (subject) => {
            const items = itemsMentioned(subject, standing.examples);
            return items.length === 1 && subject.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toUpperCase() === items[0] ? items[0] : null;
        },
        predict: (item) => preferredPrediction(standing, item),
        counts: [{ noun: "example", value: standing.examples.length }],
        proposal: standing.next
            ? { item: standing.next.item, unseenItemsIn: (text) => itemsMentioned(text, standing.examples).filter((item) => !seen.has(item)) }
            : null
    };
}
//# sourceMappingURL=induction-standing.js.map