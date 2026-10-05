// Where a conversation's topics begin and end.
//
// A conversation holds episodes: threads of messages about one subject. Each
// new message adds to the episode it continues, extends an earlier one, or
// starts a new one, and several unrelated episodes may stay open at once.
// Speck decides from signals it computes: how close the message's meaning
// is to each episode, and which people and things it shares with each. A
// model reads the message only when those signals do not settle it.
// Shortcut S29 (docs/COGNITIVE_SHORTCUTS.md): the thresholds, set from
// nomic-embed-text-v1.5 on interleaved conversations. A message at least
// CONTINUE_AT close to an episode, and MARGIN ahead of the next, continues
// it; one below NEW_BELOW everywhere, sharing nothing, starts a new episode;
// anything between is ambiguous. Each shared referent adds REFERENT_BONUS
// (up to two): a name links a message to an episode that its meaning alone
// may not ("Felix is turning 12" after an introduction naming Felix).
// A message far from everything starts a new episode only if it has a
// subject of its own: at least SUBSTANTIAL content words. A short follow-up
// ("What happened first?") is far from everything too, but leans on the
// conversation, so it is read instead.
export const SEGMENTATION = { CONTINUE_AT: 0.62, MARGIN: 0.05, NEW_BELOW: 0.58, REFERENT_BONUS: 0.08, SUBSTANTIAL: 4, DEPENDENT_UNDER: 8 };
// Shortcut S29 (docs/COGNITIVE_SHORTCUTS.md): English function words, which
// carry no subject of their own.
const FUNCTION_WORDS = new Set(("a an the and or but if then so of to in on at by for with from about into over after before "
    + "is are was were be been being do does did have has had can could will would shall should may might must "
    + "i me my we our you your he him his she her it its they them their this that these those what which who whom whose "
    + "when where why how not no yes also just only very too more most first next last again what's it's that's there here").split(" "));
// Shortcut S29 (docs/COGNITIVE_SHORTCUTS.md): a short message that refers
// with a third-person pronoun ("I use it about half the time for work",
// "Is she allergic to nuts?") leans on something said before, so it is not
// a new subject. A message long enough to name what it refers to may use
// one freely, so only messages with fewer than DEPENDENT_UNDER content
// words count.
const POINTING_PRONOUNS = new Set(["it", "its", "they", "them", "their", "theirs", "he", "him", "his", "she", "her", "hers"]);
export function dependsOnEarlier(text) {
    const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
    return words.some((word) => POINTING_PRONOUNS.has(word.replace(/'s$/, ""))) && contentWords(text).length < SEGMENTATION.DEPENDENT_UNDER;
}
// The words of a message that carry a subject: not function words, and at
// least three letters.
export function contentWords(text) {
    return (text.toLowerCase().match(/[\p{L}][\p{L}'-]{2,}/gu) ?? []).filter((word) => !FUNCTION_WORDS.has(word));
}
export function cosine(left, right) {
    let dot = 0, leftNorm = 0, rightNorm = 0;
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] * left[index];
        rightNorm += right[index] * right[index];
    }
    return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
// Shortcut S29 (docs/COGNITIVE_SHORTCUTS.md): the names and specific terms a
// message mentions: capitalised words that do not begin a sentence, quoted
// terms, and identifiers with digits ("A17", "srv-02"). Lower-cased for
// comparison. A name written in lower case is missed.
export function referents(text) {
    const found = new Set();
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
        const words = sentence.split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
        words.forEach((word, index) => {
            const capitalised = /^\p{Lu}[\p{Ll}\p{N}'-]+$/u.test(word) && index > 0 && word !== "I";
            const identifier = /\p{L}/u.test(word) && /\d/.test(word) && word.length >= 2;
            if (capitalised || identifier)
                found.add(word.toLowerCase());
        });
    }
    for (const quoted of text.matchAll(/["“']([^"”']{2,40})["”']/g))
        found.add(quoted[1].trim().toLowerCase());
    return [...found];
}
// Shortcut S29 (docs/COGNITIVE_SHORTCUTS.md): a message that opens by
// marking a shift ("Unrelated, …", "Separately, …", "By the way, …") says it
// is not about the current subject. It may return to an earlier one ("By the
// way, Oscar starts university" after an introduction naming Oscar), so it
// only rules out the active episode.
const SHIFT_MARKER = /^\s*(?:unrelated|separately|by the way|btw|on (?:a|an)(?:other| different| separate| unrelated) (?:note|topic|subject|matter)|another (?:thing|question|topic)|different (?:topic|question|subject)|changing (?:the )?(?:topic|subject)|anyway|moving on)\b/i;
export function marksShift(text) {
    return SHIFT_MARKER.test(text);
}
// Which episode a message belongs to, from its meaning vector (null when no
// encoder is available) and its referents.
export function assignEpisode(vector, mentioned, all, substance = SEGMENTATION.SUBSTANTIAL, shifts = false, dependent = false) {
    // A message marking a shift is not about the active episode.
    const episodes = shifts ? all.filter((episode) => !episode.active) : all;
    if (!episodes.length)
        return { kind: "new", scores: [] };
    const scores = episodes.map((episode) => {
        const meaning = vector && episode.vectors.length ? Math.max(...episode.vectors.map((other) => cosine(vector, other))) : 0;
        const shared = mentioned.filter((term) => episode.referents.includes(term));
        return { episodeId: episode.id, meaning, shared, score: meaning + SEGMENTATION.REFERENT_BONUS * Math.min(2, shared.length) };
    }).sort((left, right) => right.score - left.score);
    const [best, second] = scores;
    const active = episodes.find((episode) => episode.active)?.id;
    // Without meaning vectors nothing can be judged by closeness: the
    // conversation stays on its subject, or, when the message marks a shift,
    // every other episode is a candidate.
    if (!vector)
        return active ? { kind: "continue", episodeId: active, basis: "persistence", scores }
            : { kind: "ambiguous", candidates: scores.map((entry) => entry.episodeId), scores };
    const ahead = !second || best.score - second.score >= SEGMENTATION.MARGIN;
    if (best.score >= SEGMENTATION.CONTINUE_AT && ahead)
        return { kind: "continue", episodeId: best.episodeId, basis: "meaning", scores };
    if (best.score < SEGMENTATION.NEW_BELOW && scores.every((entry) => !entry.shared.length) && substance >= SEGMENTATION.SUBSTANTIAL && !dependent)
        return { kind: "new", scores };
    // Not close enough to settle it by meaning, but clearly ahead of the rest
    // and close enough to be a candidate at all: it leads.
    if (best.score >= SEGMENTATION.NEW_BELOW && ahead)
        return { kind: "continue", episodeId: best.episodeId, basis: "leader", scores };
    // Otherwise nothing else leads, and a conversation stays on its subject
    // unless the user marks a shift: the message continues the active episode.
    if (active)
        return { kind: "continue", episodeId: active, basis: "persistence", scores };
    // A marked shift with no leader among the other episodes: read which one,
    // if any, the message returns to.
    const close = scores.filter((entry) => best.score - entry.score < SEGMENTATION.MARGIN * 2).map((entry) => entry.episodeId);
    return { kind: "ambiguous", candidates: close, scores };
}
//# sourceMappingURL=segmentation.js.map