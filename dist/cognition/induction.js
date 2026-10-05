// Deterministic induction over labelled examples.
//
// When a task supplies examples of the form "item → label", the work of
// proposing candidate rules, checking them against every example, eliminating
// the ones a counter-example refutes, and finding the next example that would
// best tell the survivors apart, does not need a model. Speck describes each
// item by a fixed vocabulary of features, enumerates the simple rules over
// those features, and keeps exactly the rules that every example satisfies.
// A model extracts the examples from the user's words and writes the reply;
// nothing in between is a model's judgment.
// Shortcut S19 (docs/COGNITIVE_SHORTCUTS.md): the feature vocabulary. It
// describes symbolic items (a letter prefix and a number); items whose
// classification depends on meaning are outside it.
export function featuresOf(item) {
    const text = item.trim();
    const features = {};
    const prefix = text.match(/^[^\d]*/)?.[0].trim() ?? "";
    if (prefix)
        features["letter prefix"] = prefix.toUpperCase();
    const digits = text.match(/\d+/)?.[0];
    if (digits !== undefined) {
        const value = Number(digits);
        const digitSum = [...digits].reduce((sum, digit) => sum + Number(digit), 0);
        features["number"] = value;
        features["parity of the number"] = value % 2 === 0 ? "even" : "odd";
        features["remainder of the number divided by 3"] = value % 3;
        features["remainder of the number divided by 4"] = value % 4;
        features["remainder of the number divided by 5"] = value % 5;
        features["last digit"] = value % 10;
        features["first digit"] = Number(digits[0]);
        features["digit sum"] = digitSum;
        features["parity of the digit sum"] = digitSum % 2 === 0 ? "even" : "odd";
        features["number of digits"] = digits.length;
    }
    return features;
}
// Shortcut S22 (docs/COGNITIVE_SHORTCUTS.md): the words a statement of each
// feature uses, so Speck can recognise its own rules in a reply. Any one term
// suffices; a paraphrase outside the list is not recognised.
const FEATURE_TERMS = {
    "letter prefix": ["letter prefix", "prefix", "first letter", "leading letter"],
    "number": ["number", "value"],
    "parity of the number": ["parity", "even", "odd"],
    "last digit": ["last digit", "final digit", "ones digit", "units digit", "ends in", "ending in", "end in"],
    "first digit": ["first digit", "leading digit", "starts with", "starting with", "begins with"],
    "digit sum": ["digit sum", "sum of the digits", "sum of its digits", "sum of digits", "digits add up", "digits sum"],
    "parity of the digit sum": ["digit sum", "sum of the digits", "sum of its digits", "sum of digits"],
    "number of digits": ["number of digits", "digit count", "digits long", "how many digits"]
};
for (const divisor of [3, 4, 5]) {
    FEATURE_TERMS[`remainder of the number divided by ${divisor}`] = [
        `divided by ${divisor}`, `dividing by ${divisor}`, `divisible by ${divisor}`, `multiple of ${divisor}`, `multiples of ${divisor}`,
        `mod ${divisor}`, `modulo ${divisor}`, `remainder by ${divisor}`, `remainder of ${divisor}`
    ];
}
// Whether a text states the rule, in the words its feature is stated in (and,
// for a threshold, the threshold itself).
export function statesRule(text, rule) {
    const normalized = ` ${normalizeWords(text)} `;
    const mentions = (phrase) => normalized.includes(` ${normalizeWords(phrase)} `);
    const terms = FEATURE_TERMS[rule.feature] ?? [rule.feature];
    if (!terms.some(mentions))
        return false;
    return rule.kind === "threshold" ? mentions(String(rule.threshold)) : true;
}
// Whether a subject is an item induction can describe: one with a number
// (S19's feature vocabulary). "A17" is; "my wife" is not.
export function isInductionItem(subject) {
    return featuresOf(subject).number !== undefined && /^[\p{L}]*\s*\d+$/u.test(subject.trim());
}
// What remains of a text once the given examples' items and labels are taken
// out: empty when the text is nothing but those examples.
export function beyondExamples(text, examples) {
    let rest = ` ${text} `;
    for (const example of examples) {
        for (const word of [example.item, example.label]) {
            rest = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu"), " ");
        }
    }
    return rest.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
// The items a text names, recognised by the shape of the examples' items (the
// same letter prefix followed by a number), in upper case.
export function itemsMentioned(text, examples) {
    const prefixes = [...new Set(examples.map((example) => example.item.trim().match(/^[^\d]*/)?.[0].trim() ?? ""))].filter(Boolean);
    if (!prefixes.length)
        return [];
    const escaped = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return [...new Set([...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped})\\d+(?![\\p{L}\\p{N}])`, "giu"))].map((match) => match[0].toUpperCase()))];
}
function normalizeWords(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const NUMERIC_FEATURES = ["number", "digit sum", "last digit", "first digit"];
// Features whose value is (nearly) unique per item: a value table over them
// memorises the examples rather than explaining them.
const IDENTIFYING_FEATURES = new Set(["number"]);
export function ruleKey(rule) {
    return rule.kind === "value" ? `value:${rule.feature}` : `threshold:${rule.feature}:${rule.threshold}`;
}
// Every simple rule the examples could support: a value table for each
// categorical feature, and each threshold on a numeric feature that splits the
// examples into two labels.
export function candidateRules(examples) {
    const rules = [];
    const featureNames = new Set(examples.flatMap((example) => Object.keys(featuresOf(example.item))));
    for (const feature of featureNames) {
        if (!IDENTIFYING_FEATURES.has(feature))
            rules.push({ kind: "value", feature });
    }
    const labels = [...new Set(examples.map((example) => example.label))];
    if (labels.length === 2) {
        for (const feature of NUMERIC_FEATURES.filter((name) => featureNames.has(name))) {
            const values = [...new Set(examples.map((example) => featuresOf(example.item)[feature]).filter((value) => typeof value === "number"))].sort((a, b) => a - b);
            for (let index = 1; index < values.length; index += 1) {
                const threshold = values[index];
                for (const [below, atOrAbove] of [[labels[0], labels[1]], [labels[1], labels[0]]]) {
                    rules.push({ kind: "threshold", feature, threshold, below, atOrAbove });
                }
            }
        }
    }
    return rules;
}
export function predict(rule, examples, item) {
    const value = featuresOf(item)[rule.feature];
    if (value === undefined)
        return null;
    if (rule.kind === "threshold")
        return typeof value === "number" ? (value < rule.threshold ? rule.below : rule.atOrAbove) : null;
    const seen = examples.find((example) => featuresOf(example.item)[rule.feature] === value);
    return seen?.label ?? null;
}
export function assess(rule, examples) {
    let counterExample = null;
    let covered = 0;
    const table = new Map();
    for (const example of examples) {
        const value = featuresOf(example.item)[rule.feature];
        if (value === undefined)
            continue;
        covered += 1;
        const expected = rule.kind === "threshold"
            ? (typeof value === "number" ? (value < rule.threshold ? rule.below : rule.atOrAbove) : null)
            : table.get(value) ?? null;
        if (expected !== null && expected !== example.label && !counterExample)
            counterExample = example;
        if (rule.kind === "value" && !table.has(value))
            table.set(value, example.label);
    }
    const complexity = rule.kind === "value" ? table.size : 2;
    return {
        key: ruleKey(rule), rule, description: describe(rule, table), consistent: counterExample === null && covered > 0,
        counterExample, complexity, covered
    };
}
// Surviving rules: every rule all the examples satisfy. Rules that generalise
// (fewer cases than examples) come first, simplest first. A value table with
// one entry per example explains nothing yet, but it still predicts and can be
// refuted, so it survives as an unsupported alternative.
export function survivingRules(examples) {
    return candidateRules(examples)
        .map((rule) => assess(rule, examples))
        .filter((assessment) => assessment.consistent && assessment.covered === examples.length)
        .sort(compareRules);
}
// Speck's preference between rules: rules that generalise first, then the
// simplest, then the one covering most examples.
export function compareRules(left, right) {
    return Number(generalises(right)) - Number(generalises(left))
        || left.complexity - right.complexity || right.covered - left.covered || left.key.localeCompare(right.key);
}
// Whether neither rule is preferred to the other on Speck's criteria.
export function equallyPreferred(left, right) {
    return generalises(left) === generalises(right) && left.complexity === right.complexity && left.covered === right.covered;
}
export function generalises(assessment) {
    return assessment.complexity < assessment.covered;
}
// The items an experiment could ask about: the examples' prefix with every
// number up to twice the largest seen (at least 1 to 40).
export function probeDomain(examples) {
    const prefix = examples[0]?.item.match(/^[^\d]*/)?.[0] ?? "";
    const numbers = examples.map((example) => Number(example.item.match(/\d+/)?.[0])).filter(Number.isFinite);
    const limit = Math.max(20, ...numbers) * 2;
    return Array.from({ length: limit }, (_, index) => `${prefix}${index + 1}`);
}
// Whether two rules are one rule described two ways: over the whole domain,
// each predicts every item, and they predict the same label for each. A rule
// that has yet to predict some item is not equivalent to one that has: the
// answer for that item could still tell them apart.
export function observationallyEquivalent(left, right, examples, domain) {
    return domain.every((item) => {
        const a = predict(left, examples, item);
        return a !== null && a === predict(right, examples, item);
    });
}
// The unseen item whose answer is expected to eliminate the most of the
// surviving rules' weight. An answer eliminates every rule that predicted a
// different label; a rule with no prediction for the item survives any
// answer. Each answer is weighted by the rules that predict it (a rule with no
// prediction spreads its weight over the labels). Null when no answer to any
// item could eliminate anything: the rules cannot be told apart by example.
export function mostInformativeExample(examples, rules) {
    if (rules.length < 2)
        return null;
    const labels = [...new Set(examples.map((example) => example.label))];
    const total = rules.reduce((sum, rule) => sum + rule.weight, 0);
    if (!labels.length || total <= 0)
        return null;
    const seen = new Set(examples.map((example) => example.item.trim().toUpperCase()));
    let best = null;
    for (const item of probeDomain(examples)) {
        if (seen.has(item.toUpperCase()))
            continue;
        const predictions = rules.map((rule) => ({ rule, label: predict(rule.assessment.rule, examples, item) }));
        let expected = 0;
        let eliminates = false;
        const outcomes = labels.map((label) => {
            const standing = predictions.filter((entry) => entry.label === null || entry.label === label);
            const remainingWeight = standing.reduce((sum, entry) => sum + entry.rule.weight, 0);
            const probability = predictions.reduce((sum, entry) => sum + (entry.label === label ? entry.rule.weight : entry.label === null ? entry.rule.weight / labels.length : 0), 0) / total;
            expected += probability * remainingWeight / total;
            if (remainingWeight < total)
                eliminates = true;
            return { label, remaining: standing.map((entry) => entry.rule.assessment.description) };
        });
        if (!eliminates)
            continue;
        if (!best || expected < best.expectedRemaining - 1e-9) {
            best = { item, predictions: predictions.map((entry) => ({ description: entry.rule.assessment.description, label: entry.label })), outcomes, expectedRemaining: expected };
        }
    }
    return best;
}
// The finite set of values a feature can take, when there is one.
function featureDomain(feature) {
    if (feature === "parity of the number" || feature === "parity of the digit sum")
        return ["even", "odd"];
    const divisor = feature.match(/^remainder of the number divided by (\d+)$/)?.[1];
    if (divisor)
        return Array.from({ length: Number(divisor) }, (_, index) => index);
    if (feature === "last digit")
        return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    if (feature === "first digit")
        return [1, 2, 3, 4, 5, 6, 7, 8, 9];
    return null;
}
// The rule as its full mapping: the values grouped by the label they give,
// and, for a feature with finite values, the ones not yet seen.
function describe(rule, table) {
    if (rule.kind === "threshold")
        return `${rule.feature} below ${rule.threshold} → ${rule.below}; ${rule.threshold} or above → ${rule.atOrAbove}`;
    const order = (left, right) => String(left).localeCompare(String(right), undefined, { numeric: true });
    const byLabel = new Map();
    for (const [value, label] of [...table.entries()].sort(([left], [right]) => order(left, right)))
        byLabel.set(label, [...(byLabel.get(label) ?? []), value]);
    const groups = [...byLabel].map(([label, values]) => `${values.join(", ")} → ${label}`).join("; ");
    const unseen = (featureDomain(rule.feature) ?? []).filter((value) => !table.has(value));
    return `${rule.feature} determines the label: ${groups}${unseen.length ? `; not yet seen: ${unseen.join(", ")}` : ""}`;
}
//# sourceMappingURL=induction.js.map