// Semantic grounding: is a candidate fact something the user actually said?
//
// A fact is compared with the statement it was extracted from, and with the
// user's other past statements held in memory. The past statements form a
// baseline of how similar this fact is to things the user did not just say;
// the fact is grounded only if its similarity to the statement stands clearly
// above that baseline. The decision therefore comes from Speck's own memory
// and encoder rather than from a fixed word list or a fixed similarity value,
// and it adapts to the encoder, the language, and the user's vocabulary.
//
// Similarity measures whether a fact is about what the user said, not whether
// the user said it: it accepts paraphrases ("from Oz" -> "from Australia") but
// also related inferences ("lives in Ballarat" -> "lives in Australia"). The
// lexical rule fails the opposite way. Each signal is kept on the decision;
// when they agree the fact is stated or unstated, and when they disagree it is
// uncertain, which callers treat as lower-risk than stated (task-local only).
//
// Until memory holds enough past statements for a baseline, grounding uses the
// lexical rule alone (Shortcut S2, docs/COGNITIVE_SHORTCUTS.md).
// Shortcut S2 (docs/COGNITIVE_SHORTCUTS.md): the statistical parameters of the
// baseline test. They are a significance level and a minimum sample size, not
// a judgment, but they are fixed values until calibrated from outcomes.
export const GROUNDING_BASELINE_QUANTILE = 0.95;
export const GROUNDING_MINIMUM_BASELINE = 8;
const GROUNDING_MAXIMUM_BASELINE = 40;
export async function groundFacts(input) {
    const facts = [...new Set(input.facts.map((fact) => fact.trim()).filter(Boolean))];
    if (!facts.length)
        return { decisions: [], encoder: null };
    const current = normalized(input.statement);
    const past = [...new Set(input.pastStatements.map((text) => text.trim()).filter((text) => text && normalized(text) !== current))]
        .slice(0, GROUNDING_MAXIMUM_BASELINE);
    if (past.length < GROUNDING_MINIMUM_BASELINE) {
        return {
            encoder: null,
            decisions: facts.map((fact) => {
                const lexical = lexicallyGrounded(fact, input.statement);
                return {
                    fact, grounded: lexical, certainty: lexical ? "stated" : "unstated", lexical, semantic: null,
                    method: "lexical-cold-start", score: null, threshold: null, baselineSamples: past.length
                };
            })
        };
    }
    const statementUnits = units(input.statement);
    const pastUnits = past.map(units);
    const texts = [...facts, ...statementUnits, ...pastUnits.flat()];
    const { vectors, encoder } = await input.encoder.encode(texts);
    const factVectors = vectors.slice(0, facts.length);
    const statementVectors = vectors.slice(facts.length, facts.length + statementUnits.length);
    let offset = facts.length + statementUnits.length;
    const pastVectors = pastUnits.map((group) => {
        const slice = vectors.slice(offset, offset + group.length);
        offset += group.length;
        return slice;
    });
    return {
        encoder,
        decisions: facts.map((fact, index) => {
            const vector = factVectors[index];
            const score = bestMatch(vector, statementVectors);
            const baseline = pastVectors.map((group) => bestMatch(vector, group));
            const threshold = quantile(baseline, GROUNDING_BASELINE_QUANTILE);
            const semantic = score > threshold;
            const lexical = lexicallyGrounded(fact, input.statement);
            const certainty = semantic && lexical ? "stated" : semantic || lexical ? "uncertain" : "unstated";
            return {
                fact, grounded: certainty !== "unstated", certainty, lexical, semantic,
                method: "baseline", score, threshold, baselineSamples: baseline.length
            };
        })
    };
}
// A statement is compared as a whole and sentence by sentence, so a fact
// stated in one sentence of a longer turn is not diluted by the rest.
function units(text) {
    const sentences = (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
    return [...new Set([text.trim(), ...sentences])];
}
function bestMatch(vector, candidates) {
    return candidates.reduce((best, candidate) => Math.max(best, cosine(vector, candidate)), -1);
}
export function cosine(left, right) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] ** 2;
        rightNorm += right[index] ** 2;
    }
    return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
function quantile(values, q) {
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function normalized(text) {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}
// Shortcut S2 (docs/COGNITIVE_SHORTCUTS.md), cold-start fallback only: most of
// a fact's distinctive words must occur in the statement.
const LEXICAL_IGNORED = new Set([
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from", "by", "as", "is", "are", "was",
    "were", "be", "been", "am", "has", "have", "had", "do", "does", "did", "that", "this", "these", "those", "it", "its",
    "i", "me", "my", "mine", "you", "your", "he", "she", "his", "her", "they", "their", "them", "we", "our", "us",
    "user", "users", "person", "named", "called", "who", "which", "not", "no", "so", "than", "then", "there",
    // fragments left by splitting contractions ("I'm", "we're", "it's", "don't")
    "s", "m", "re", "ve", "ll", "d", "t"
]);
function distinctiveWords(text) {
    return text.toLowerCase().replace(/['’]s\b/g, "").split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word && !LEXICAL_IGNORED.has(word));
}
export function lexicallyGrounded(fact, statement) {
    const words = distinctiveWords(fact);
    if (!words.length)
        return false;
    const available = new Set(distinctiveWords(statement));
    return words.filter((word) => available.has(word)).length * 2 >= words.length;
}
//# sourceMappingURL=grounding.js.map