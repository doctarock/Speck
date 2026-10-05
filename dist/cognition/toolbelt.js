// The toolbelt: the tools put in front of the Tool Caller for one message.
// A small Tool Caller shown every registered tool reached for ones nowhere
// near the topic (the causal test, 2026-10-03: airchat_status and
// browser_search for "Check the login status of Alice at 2:11 AM"). Speck
// chooses the candidates; the Tool Caller only chooses among them, or none.
//
// Relevance is read from the configured encoder: how close the topic is to
// each tool's card, measured against how close that tool usually is to
// messages that need no tool (some cards are near everything). Plugin tools
// enter as a family, so the Tool Caller can still pick the right one of
// them; a plugin also enters when it is named or was already used in the
// task. Speck's own tools are always offered: gating them by relevance only
// lost the tool a request needed (development set, 2026-10-04). Whether any
// tool is needed stays the Tool Caller's judgment over what is offered.
// Shortcut S32 (docs/COGNITIVE_SHORTCUTS.md): how far above its usual
// similarity to no-tool messages a plugin's best tool must be for the plugin
// to be offered, in standard deviations of that usual similarity. Set on the
// development set in src/benchmark/toolbelt-cases.ts with nomic-embed-text:
// the lowest bar at which no plugin reached a message needing no tool.
export const TOOLBELT = { family: 3 };
// Messages that need no tool, of varied kinds: the baseline each tool's
// similarity is measured against. None of them is a probe case.
export const TOOLBELT_REFERENCE = [
    "Good morning, how are you today?", "Thanks, that was really helpful.", "I think the second option is better because it is cheaper.",
    "Why do cats purr?", "My daughter starts school next week.", "The meeting ran long and everyone was tired.",
    "Explain how a heat pump works.", "If all bloops are razzies and all razzies are lazzies, are all bloops lazzies?",
    "The car would not start this morning even though the battery is new.", "What is the capital of Australia?",
    "I'm not sure that's right, can you double-check your reasoning?", "Summarise what we have established so far.",
    "The power went out at 6 PM and came back at 7.", "Which of the two explanations fits the evidence better?",
    "Tell me a joke about programmers.", "We moved house last year.", "The package arrived damaged.",
    "What would happen if the interest rate rose by one percent?", "I prefer tea to coffee.", "Okay, go on."
];
// What the encoder reads for a tool: its name, its plugin with what the
// plugin declares it covers, and the tool's own description. A plugin tool's
// description alone ("Summarise recent board activity.") does not say which
// board, and a plugin's description alone did not say it covers LinkedIn.
export function toolCard(tool) {
    const topics = tool.family?.topics;
    const covers = topics?.keywords.length ? ` Covers: ${topics.keywords.join(", ")}.` : "";
    const serves = topics?.examples.length ? ` For example: ${topics.examples.join("; ")}.` : "";
    const family = tool.family ? `${tool.family.name}${tool.family.description ? ` (${tool.family.description})` : ""}.${covers}${serves} ` : "";
    return `${tool.name.replace(/_/g, " ")}: ${family}${tool.description}`;
}
// The plugin family a tool belongs to; Speck's own tools have none.
export function familyOf(tool) {
    return tool.family?.id ?? (tool.source.startsWith("genesis:") ? tool.source.slice("genesis:".length) : null);
}
// Chooses the toolbelt from each tool's relevance (standard deviations above
// its baseline), the plugin families named in the topic, and the families
// whose tools the task already used.
export function selectToolbelt(input) {
    const thresholds = input.thresholds ?? TOOLBELT;
    const reasons = {};
    const families = new Map();
    for (const tool of input.tools) {
        const family = familyOf(tool);
        if (family)
            families.set(family, [...(families.get(family) ?? []), tool]);
    }
    const topic = squash(input.topic);
    const offered = new Set();
    for (const [family, members] of families) {
        const best = Math.max(...members.map((tool) => input.relevance.get(tool.name) ?? -Infinity));
        const name = members[0]?.family?.name ?? family;
        const reason = best >= thresholds.family ? `on topic (${best.toFixed(1)})`
            : [name, family].some((label) => squash(label).length >= 4 && topic.includes(squash(label))) ? "named"
                : members.some((tool) => input.usedTools?.has(tool.name)) ? "used in this task" : "";
        if (!reason)
            continue;
        reasons[family] = reason;
        for (const tool of members)
            offered.add(tool.name);
    }
    for (const tool of input.tools)
        if (!familyOf(tool))
            offered.add(tool.name);
    const tools = input.tools.map((tool) => tool.name).filter((name) => offered.has(name));
    return { tools, reasons };
}
// Lower case with everything but letters and digits removed, so "AirChat",
// "air chat" and "airchat" match.
function squash(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
// Standard deviations above a tool's baseline similarity.
export function standardised(score, baseline) {
    return (score - baseline.mean) / Math.max(baseline.sd, 1e-6);
}
export function cosine(left, right) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] ** 2;
        rightNorm += right[index] ** 2;
    }
    return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
//# sourceMappingURL=toolbelt.js.map