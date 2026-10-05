const RISK_ORDER = {
    "read-only": 0,
    "reversible-mutation": 1,
    "destructive-mutation": 2,
    "external-side-effect": 3
};
export class ToolRegistry {
    tools = new Map();
    register(definition, execute) {
        const normalized = normalizeDefinition(definition);
        if (this.tools.has(normalized.name))
            throw new TypeError(`Tool ${normalized.name} is already registered`);
        this.tools.set(normalized.name, { definition: normalized, execute });
        return normalized;
    }
    upsert(definition, execute) {
        const normalized = normalizeDefinition(definition);
        this.tools.set(normalized.name, { definition: normalized, execute });
        return normalized;
    }
    list() {
        return [...this.tools.values()].map(({ definition }) => structuredClone(definition))
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    availableForAutonomy() {
        return this.list().filter((tool) => tool.risk === "read-only");
    }
    resolve(intent) {
        const requested = normalizeName(intent.intent);
        const matches = [...this.tools.values()].filter(({ definition }) => definition.name === requested || definition.intents.includes(requested));
        if (matches.length === 0)
            throw new TypeError(`No registered tool resolves intent "${intent.intent}"`);
        if (matches.length > 1)
            throw new TypeError(`Intent "${intent.intent}" is ambiguous`);
        return matches[0];
    }
    assertAuthorized(definition, authorization) {
        const granted = new Set((authorization?.permissions ?? []).map((permission) => permission.trim()).filter(Boolean));
        const missing = definition.requiredPermissions.filter((permission) => !granted.has(permission));
        if (missing.length)
            throw new TypeError(`Tool ${definition.name} requires permission "${missing[0]}"`);
        if (definition.risk === "read-only")
            return;
        if (!authorization?.approved || !authorization.approvedBy.trim()) {
            throw new TypeError(`Tool ${definition.name} requires explicit approval for ${definition.risk}`);
        }
    }
    validateArguments(definition, arguments_) {
        for (const [name, schema] of Object.entries(definition.inputSchema)) {
            const value = arguments_[name];
            if (value === undefined) {
                if (schema.required)
                    throw new TypeError(`Tool ${definition.name} is missing required argument "${name}"`);
                continue;
            }
            const acceptedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
            const matches = acceptedTypes.some((type) => type === "array" ? Array.isArray(value)
                : type === "object" ? isRecord(value)
                    : typeof value === type);
            if (!matches)
                throw new TypeError(`Tool ${definition.name} argument "${name}" must be ${acceptedTypes.join(" or ")}`);
            if (schema.enum && !schema.enum.includes(value)) {
                throw new TypeError(`Tool ${definition.name} argument "${name}" must be one of ${schema.enum.join(", ")}`);
            }
        }
        const unknown = Object.keys(arguments_).filter((name) => !(name in definition.inputSchema));
        if (unknown.length)
            throw new TypeError(`Tool ${definition.name} received unknown argument "${unknown[0]}"`);
    }
    async execute(registered, arguments_, context, timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
        const relayAbort = () => controller.abort(context.signal.reason);
        context.signal.addEventListener("abort", relayAbort, { once: true });
        try {
            return await Promise.race([
                registered.execute(arguments_, { ...context, signal: controller.signal }),
                new Promise((_resolve, reject) => controller.signal.addEventListener("abort", () => {
                    const error = new Error(String(controller.signal.reason instanceof Error
                        ? controller.signal.reason.message : controller.signal.reason ?? "Tool execution aborted"));
                    error.name = "AbortError";
                    reject(error);
                }, { once: true }))
            ]);
        }
        finally {
            clearTimeout(timeout);
            context.signal.removeEventListener("abort", relayAbort);
        }
    }
}
export function riskAtMost(actual, maximum) {
    return RISK_ORDER[actual] <= RISK_ORDER[maximum];
}
function normalizeDefinition(definition) {
    const name = normalizeName(definition.name);
    if (!name)
        throw new TypeError("Tool name is required");
    if (!definition.description.trim())
        throw new TypeError(`Tool ${name} requires a description`);
    return {
        ...definition,
        name,
        description: definition.description.trim(),
        intents: [...new Set([name, ...definition.intents.map(normalizeName).filter(Boolean)])],
        inputSchema: { ...definition.inputSchema },
        ...(definition.outputSchema ? { outputSchema: { ...definition.outputSchema } } : {}),
        sideEffects: [...new Set(definition.sideEffects.map(String).filter(Boolean))],
        requiredPermissions: [...new Set(definition.requiredPermissions.map(String).filter(Boolean))],
        source: definition.source.trim() || "runtime"
    };
}
function normalizeName(value) {
    return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
//# sourceMappingURL=registry.js.map