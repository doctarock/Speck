// Claims in a reply, compared with what is known.
//
// Reading the claims out of a reply is a model's work (the same extraction
// that reads examples from the user's messages); comparing them is Speck's.
// Nothing here depends on how the knowledge was reached: observed labels and
// a predictor are enough, so any substrate that predicts can be checked.
// Shortcut S23 (docs/COGNITIVE_SHORTCUTS.md): numbers written as digits that
// the reply states but that appear nowhere in what its writer was shown. A
// number written out in words, or one the writer computed correctly, is not
// distinguished; the check is applied only to replies reporting a reasoning
// state, where every quantity is one Speck already holds.
export function ungroundedNumbers(reply, shown) {
    const numbers = (text) => [...text.matchAll(/(?<![\p{L}\p{N}.])\d+(?:\.\d+)?(?![\p{L}\p{N}])/gu)].map((match) => match[0]);
    // A number the writer was shown counts however it was written there: "2am"
    // grounds "2 am", and "A17" grounds "17".
    const grounded = new Set([...shown.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]));
    return [...new Set(numbers(reply).filter((number) => !grounded.has(number)))];
}
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
// Shortcut S23 (docs/COGNITIVE_SHORTCUTS.md): the counts a text states of a
// whole set, in digits or words ("all three examples", "the 8 examples", "these
// five labelled examples"). A typed quantity (how many of what), so it can be
// compared with the count Speck holds. Only definite references count: "one
// more example" is not a claim about the set.
export function countsOf(text, noun) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:all|the|these|those)\\s+(\\d+|${NUMBER_WORDS.join("|")})\\s+(?:\\p{L}+\\s+)?${noun}s?(?![\\p{L}\\p{N}])`, "giu");
    return [...text.matchAll(pattern)].map((match) => {
        const word = match[1].toLowerCase();
        return /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word);
    });
}
// The text with every definite count of the noun set to the count held,
// written as the writer wrote it (a word stays a word up to twenty).
export function correctCounts(text, noun, value) {
    const pattern = new RegExp(`((?<![\\p{L}\\p{N}])(?:all|the|these|those)\\s+)(\\d+|${NUMBER_WORDS.join("|")})(\\s+(?:\\p{L}+\\s+)?${noun}s?(?![\\p{L}\\p{N}]))`, "giu");
    return text.replace(pattern, (whole, before, count, after) => {
        const asWord = !/^\d+$/.test(count) && value < NUMBER_WORDS.length;
        const written = asWord ? NUMBER_WORDS[value] : String(value);
        const cased = asWord && /^[A-Z]/.test(count) ? written[0].toUpperCase() + written.slice(1) : written;
        return `${before}${cased}${after}`;
    });
}
// Item claims that contradict what is known. An observed item must carry its
// observed label; an unseen item must carry the predicted label (when the
// predictor does not settle it, the claim is not checked).
export function conflictingClaims(claims, observed, predict) {
    const key = (text) => text.trim().toUpperCase();
    const conflicts = [];
    for (const claim of claims) {
        const known = observed.find((entry) => key(entry.item) === key(claim.item));
        if (known) {
            if (key(known.label) !== key(claim.label))
                conflicts.push({ item: claim.item, claimed: claim.label, expected: known.label, basis: "observed" });
            continue;
        }
        const expected = predict(claim.item);
        if (expected !== null && key(expected) !== key(claim.label))
            conflicts.push({ item: claim.item, claimed: claim.label, expected, basis: "predicted" });
    }
    return conflicts;
}
// Actions a reply says were carried out that Speck's record cannot account
// for. With no operation performed, every claimed action is unfounded; once
// operations ran, matching a claim to one is a judgment this does not make.
export function unperformedActions(claimed, operationsPerformed) {
    return operationsPerformed === 0 ? [...claimed] : [];
}
// Shortcut S28 (docs/COGNITIVE_SHORTCUTS.md): the verbs whose completed form
// claims an action outside the conversation. Verbs that also describe a
// reply's own work or reasoning are left out ("updated the rule", "added
// A63", "created a summary", "written a poem below", "confirmed for all 8
// examples", "called parity", "ordered by number", "arranged by label"), so
// they are never read as claims.
const DONE_TO_THE_WORLD = [
    "booked", "reserved", "scheduled", "rescheduled", "sent", "emailed", "texted", "messaged",
    "saved", "deleted", "uploaded", "posted", "published", "submitted",
    "bought", "purchased", "paid", "cancelled", "canceled", "transferred", "installed", "restarted", "deployed", "set up"
];
// In the first person a few more verbs are unambiguous ("I've notified
// them", "I forwarded it"); as a state ("is notified") they are not claims.
const DONE_BY_ME = [...DONE_TO_THE_WORLD, "notified", "forwarded", "renamed", "downloaded"].join("|");
const DONE_STATE = DONE_TO_THE_WORLD.join("|");
const COMPLETED_ACTION = [
    // "I've booked", "I have just sent", "we booked"
    String.raw `\b(?:I|we)(?:'ve|’ve| have| had)?(?:\s+(?:just|now|already|successfully|also))?\s+(?:${DONE_BY_ME})\b`,
    // "has been booked", "have been successfully sent"
    String.raw `\b(?:has|have|had)\s+been\s+(?:\w+\s+)?(?:${DONE_STATE})\b`,
    // "is now booked", "are all set up"
    String.raw `\b(?:is|are)\s+(?:now\s+|all\s+)?(?:${DONE_STATE})\b`
].map((source) => new RegExp(source, "i"));
// Shortcut S28 (docs/COGNITIVE_SHORTCUTS.md): the sentences of a reply that
// state an action outside the conversation as done. A question, an offer or
// a plan ("I'll book it", "Shall I book it?") states nothing done, and a
// negation ("I haven't booked it") does not match.
export function claimedActions(reply) {
    return reply.split(/(?<=[.!?])\s+|\n+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence && !sentence.endsWith("?") && COMPLETED_ACTION.some((pattern) => pattern.test(sentence)));
}
//# sourceMappingURL=claims.js.map