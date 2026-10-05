// Grounding a reply in the reasoning state it was written from.
//
// A reply restates what Speck holds; it is not new evidence. Any substrate
// whose state can say what a faithful reply must contain can have its replies
// checked here without a model's judgment: the substrate supplies a
// GroundableState, a model reads the reply's item claims (if any), and the
// comparison is Speck's. Induction supplies one (induction-standing.ts);
// another substrate becomes checkable by supplying its own.
import { conflictingClaims, countsOf, ungroundedNumbers } from "./claims.js";
// Whether the reply could make item claims worth reading: it uses a label.
export function mayClaimItems(reply, state) {
    const words = ` ${normalize(reply)} `;
    return state.labels.some((label) => normalize(label) && words.includes(` ${normalize(label)} `));
}
// What in the reply the state contradicts. `shown` is everything the writer
// was given; `claims` are the item claims read from the reply (null when not
// read).
export function groundReply(input) {
    const { reply, shown, state } = input;
    const faults = [];
    // An unseen item the reply proposes must be the one the state proposes.
    if (state.proposal) {
        const proposal = state.proposal;
        const others = proposal.unseenItemsIn(reply).filter((item) => item !== proposal.item.toUpperCase());
        if (others.length)
            faults.push({ kind: "other-proposal", message: `It proposes ${others.join(", ")}, but the unseen example that best separates the rules still standing is ${proposal.item}.` });
    }
    if (state.conclusion && !state.conclusion.statedIn(reply)) {
        faults.push({ kind: "conclusion-unstated", message: `It does not state Speck's conclusion, that ${state.conclusion.description}.` });
    }
    // A count of something the state counts must be its count, however it is
    // written: "all three examples" when Speck holds five is a stale copy.
    for (const { noun, value } of state.counts) {
        const wrong = [...new Set(countsOf(reply, noun).filter((count) => count !== value))];
        if (wrong.length)
            faults.push({ kind: "miscounted", message: `It says ${wrong.join(" and ")} ${noun}s, but Speck holds ${value}.` });
    }
    const invented = ungroundedNumbers(reply, shown);
    if (invented.length)
        faults.push({ kind: "ungrounded-number", message: `It states ${invented.join(", ")}, which appear nowhere in Speck's state or the conversation; give only the counts Speck reported.` });
    const claims = (input.claims ?? []).flatMap((claim) => {
        const item = state.itemIn(claim.item);
        return item ? [{ item, label: claim.label }] : [];
    });
    for (const conflict of conflictingClaims(claims, state.observed, state.predict)) {
        faults.push(conflict.basis === "observed"
            ? { kind: "observed-conflict", message: `It says ${conflict.item} is ${conflict.claimed}, but the user gave ${conflict.item} → ${conflict.expected}.` }
            : { kind: "predicted-conflict", message: `It says ${conflict.item} would be ${conflict.claimed}, but Speck's conclusion predicts ${conflict.expected}.` });
    }
    return faults;
}
function normalize(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
//# sourceMappingURL=reply-grounding.js.map