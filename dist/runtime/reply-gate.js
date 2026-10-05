// A deterministic check that may turn a reply back once.
//
// The first reply with faults is rejected (the writer is told the faults);
// after that nothing is rejected again, because the same writer given the
// same state tends to write the same reply, and refusing it repeatedly only
// spends the cycle budget. A later reply is weighed against the rejected one,
// and the one with fewer faults is kept.
export class ReplyGate {
    kept = null;
    review(value, faults) {
        if (faults.length && !this.kept) {
            this.kept = { value, faults: faults.length };
            return { rejected: true, faults };
        }
        if (this.kept && faults.length > this.kept.faults)
            return { rejected: false, value: this.kept.value };
        return { rejected: false, value };
    }
}
//# sourceMappingURL=reply-gate.js.map