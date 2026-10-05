// Pure helpers over the text of statements and replies.
// The declarative part of a turn: every sentence that is not a question.
// Shortcut S1 (docs/COGNITIVE_SHORTCUTS.md).
export function declarativeSentences(text) {
    return (text.match(/[^.!?\n]+[.!?]*/g) ?? [])
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence && !isQuestion(sentence))
        .join(" ");
}
// Shortcut S1 (docs/COGNITIVE_SHORTCUTS.md). Spoken input has no question
// marks, so a sentence is also a question when it opens with a question word
// ("is nginx running", "what is…"), or when a name or greeting is followed by
// one and then a subject pronoun ("Speck are you…", "hey can you…").
const QUESTION_OPENERS = new Set([
    "is", "are", "am", "was", "were", "do", "does", "did", "can", "could", "will", "would", "should", "shall",
    "may", "might", "have", "has", "had", "what", "who", "whom", "whose", "which", "when", "where", "why", "how"
]);
const SUBJECT_PRONOUNS = new Set(["i", "you", "we", "he", "she", "it", "they", "there", "this", "that"]);
export function isQuestion(sentence) {
    if (sentence.endsWith("?"))
        return true;
    const words = sentence.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
    if (QUESTION_OPENERS.has(words[0] ?? ""))
        return true;
    return QUESTION_OPENERS.has(words[1] ?? "") && SUBJECT_PRONOUNS.has(words[2] ?? "") && !SUBJECT_PRONOUNS.has(words[0] ?? "");
}
// A validated fact is kept only if it names a real candidate. A compound
// candidate may be split into several facts; fragments too short to stand
// alone are dropped.
// Shortcut S6 (docs/COGNITIVE_SHORTCUTS.md).
export function acceptedFacts(value, candidates) {
    if (!Array.isArray(value))
        return [];
    const accepted = [];
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item))
            continue;
        const { candidate, fact } = item;
        const index = Number(candidate);
        const text = typeof fact === "string" ? fact.trim() : "";
        if (!Number.isInteger(index) || index < 1 || index > candidates)
            continue;
        // Shortcut S6: "I'm Dana" is three words, "Dana" is one.
        if (text.split(/[\s'’]+/).filter(Boolean).length >= 3)
            accepted.push(text);
    }
    return [...new Set(accepted)];
}
// The quoted words occur in the statement, ignoring case, punctuation, and
// spacing.
export function quotedIn(quote, statement) {
    const normalize = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const words = normalize(quote);
    return words.length > 0 && ` ${normalize(statement)} `.includes(` ${words} `);
}
export function joinNaturally(items) {
    if (items.length <= 1)
        return items[0] ?? "the information you shared";
    if (items.length === 2)
        return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join("; ")}; and ${items.at(-1)}`;
}
export function stringList(value, limit) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}
// Texts that differ only in case, spacing, or punctuation are the same.
export function hypothesisKey(value) {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export function normalizedKey(value) {
    return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}
export function stableKey(value) {
    if (Array.isArray(value))
        return `[${value.map(stableKey).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
}
export function boundedConfidence(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : Math.max(0, Math.min(1, fallback));
}
//# sourceMappingURL=statements.js.map