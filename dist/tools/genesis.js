export function registerGenesisTools(registry, manager) {
    const registered = [];
    const seen = new Set();
    const occupied = new Set(registry.list().map((tool) => tool.name));
    const plugins = new Map((manager.listPlugins?.() ?? []).map((plugin) => [String(plugin.id ?? ""), plugin]));
    for (const descriptor of manager.listTools()) {
        const name = String(descriptor.name || "").trim();
        if (!name || seen.has(name) || occupied.has(name))
            continue;
        seen.add(name);
        const definition = {
            name,
            description: String(descriptor.description || `Genesis plugin tool ${name}`),
            intents: [name],
            inputSchema: normalizeGenesisParameters(descriptor.parameters),
            risk: classifyGenesisRisk(descriptor),
            sideEffects: inferSideEffects(name),
            // Genesis scopes are invocation lanes (for example intake/worker), not
            // authority grants. Plugin manifests already gate registration.
            requiredPermissions: [],
            source: `genesis:${String(descriptor.pluginId || "plugin")}`,
            ...(descriptor.pluginId ? { family: {
                    id: String(descriptor.pluginId),
                    name: String(plugins.get(String(descriptor.pluginId))?.name ?? descriptor.pluginId),
                    description: String(plugins.get(String(descriptor.pluginId))?.description ?? ""),
                    // What the plugin declares it is about (Genesis core API 1.5.0).
                    topics: declaredTopics(plugins.get(String(descriptor.pluginId))?.manifest?.topics)
                } } : {})
        };
        registered.push(registry.upsert(definition, async (args, context) => {
            if (typeof manager.executeTool === "function") {
                const executed = await manager.executeTool(name, args, {
                    workerId: context.workerId,
                    executionId: context.executionId,
                    intent: context.intent
                });
                if (executed?.handled !== true)
                    throw new Error(`Genesis tool ${name} was not handled`);
                return executed.result ?? null;
            }
            const executed = await manager.runHook("intake:tool-call", {
                handled: false, name, args, result: null,
                workerId: context.workerId, executionId: context.executionId, intent: context.intent
            });
            if (executed?.handled !== true)
                throw new Error(`Genesis tool ${name} was not handled`);
            return executed.result ?? null;
        }));
    }
    return registered;
}
function declaredTopics(value) {
    const strings = (list) => (Array.isArray(list) ? list : []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
    return { keywords: strings(value?.keywords), examples: strings(value?.examples) };
}
export function classifyGenesisRisk(descriptor) {
    const risk = String(descriptor.risk || "normal").toLowerCase();
    if (risk === "read-only" || risk === "readonly" || risk === "low")
        return "read-only";
    if (risk === "approval" || risk === "high")
        return "external-side-effect";
    if (risk === "medium")
        return "reversible-mutation";
    const segments = String(descriptor.name || "").toLowerCase().split(/[_-]/);
    const readVerbs = ["get", "list", "read", "search", "inspect", "query", "fetch", "check", "status", "diagnose", "preview", "find"];
    return segments.slice(0, 3).some((segment) => readVerbs.includes(segment))
        ? "read-only" : "reversible-mutation";
}
function normalizeGenesisParameters(parameters) {
    const schemaProperties = parameters?.type === "object" && isRecord(parameters.properties)
        ? parameters.properties
        : parameters;
    const required = new Set(Array.isArray(parameters?.required) ? parameters.required.map(String) : []);
    const result = {};
    for (const [name, raw] of Object.entries(schemaProperties ?? {})) {
        if (schemaProperties === parameters && ["type", "required", "additionalProperties", "$schema"].includes(name))
            continue;
        if (isRecord(raw)) {
            const declared = Array.isArray(raw.type) ? raw.type : [raw.type];
            const types = declared.map(String).filter(isToolParameterType);
            const values = Array.isArray(raw.enum)
                ? raw.enum.filter((value) => ["string", "number", "boolean"].includes(typeof value))
                : undefined;
            result[name] = {
                type: types.length > 1 ? types : types[0] ?? "string",
                ...(required.has(name) ? { required: true } : {}),
                ...(values?.length ? { enum: values } : {}),
                ...(raw["x-composed"] === true ? { composed: true } : {})
            };
            continue;
        }
        const alternatives = String(raw || "string").toLowerCase().split("|").map((entry) => entry.trim()).filter(Boolean);
        const types = [...new Set(alternatives.map((entry) => entry.split(/[ (]/)[0] ?? "")
                .filter((entry) => ["string", "number", "boolean", "object", "array"].includes(entry)))];
        result[name] = types.length > 1
            ? { type: types }
            : types.length === 1
                ? { type: types[0] }
                : { type: "string", ...(alternatives.length ? { enum: alternatives } : {}) };
    }
    return result;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isToolParameterType(value) {
    return ["string", "number", "boolean", "object", "array"].includes(value);
}
function inferSideEffects(name) {
    const verb = name.toLowerCase().split(/[_-]/)[0] ?? "";
    return ["get", "list", "read", "search", "inspect", "query", "fetch", "check", "status", "diagnose", "preview"]
        .includes(verb) ? [] : ["May mutate plugin or external state"];
}
//# sourceMappingURL=genesis.js.map