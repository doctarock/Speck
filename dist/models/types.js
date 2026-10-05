// A judgment-only processor (an NLI cross-encoder) answers one class of
// judgment and nothing else: it never fills a role, validates a reply or is
// chosen by default, and is reached only as a qualified checker.
export function judgmentOnly(descriptor) {
    return descriptor.provider === "nli";
}
//# sourceMappingURL=types.js.map