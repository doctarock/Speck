// Measures the toolbelt (S32) on labelled messages: whether a tool each
// message needs is offered, whether a plugin is offered off its topic, and
// how often a message needing no tool is offered none. The tools are the
// running server's, plugins included.
import { familyOf, selectToolbelt, TOOLBELT } from "../cognition/toolbelt.js";
export async function measureToolbelt(input) {
    const relevances = [];
    for (const entry of input.cases) {
        const topic = entry.request ? `${entry.request}\n${entry.message}` : entry.message;
        const selected = await input.toolbelt.select({ tools: input.tools, topic });
        if (!selected)
            throw new Error("The encoder is unavailable; the toolbelt cannot be measured");
        relevances.push(selected.relevance);
    }
    return (input.thresholds ?? [TOOLBELT]).map((thresholds) => {
        const cases = input.cases.map((entry, index) => {
            const topic = entry.request ? `${entry.request}\n${entry.message}` : entry.message;
            const selection = selectToolbelt({ tools: input.tools, relevance: relevances[index], topic, thresholds });
            const families = new Set(input.tools.filter((tool) => selection.tools.includes(tool.name)).map(familyOf).filter((family) => Boolean(family)));
            return {
                message: entry.message, needs: entry.needs, family: entry.family ?? null, offered: selection.tools, reasons: selection.reasons,
                hit: entry.needs.length ? selection.tools.some((tool) => entry.needs.some((prefix) => tool.startsWith(prefix))) : null,
                leaked: [...families].filter((family) => family !== entry.family)
            };
        });
        const needing = cases.filter((entry) => entry.hit !== null);
        const noTool = cases.filter((entry) => entry.hit === null);
        return {
            thresholds,
            recall: { hit: needing.filter((entry) => entry.hit).length, total: needing.length },
            leaks: cases.reduce((sum, entry) => sum + entry.leaked.length, 0),
            pluginOnNoTool: noTool.filter((entry) => entry.leaked.length).length,
            emptyOnNoTool: { empty: noTool.filter((entry) => !entry.offered.length).length, total: noTool.length },
            meanOffered: cases.reduce((sum, entry) => sum + entry.offered.length, 0) / Math.max(1, cases.length),
            cases
        };
    });
}
//# sourceMappingURL=toolbelt-probe.js.map