// Speck's plan-level coalition bundling: connected Working Memory members
// become coherent bundles. ACA's Step 5 coalition remains the candidate field.
export function bundleContextCoalitions(graph, workingMemory) {
    const remaining = new Set(workingMemory);
    const coalitions = [];
    while (remaining.size > 0) {
        const seed = [...remaining].sort()[0];
        const queue = [seed];
        const members = [];
        remaining.delete(seed);
        while (queue.length > 0) {
            const id = queue.shift();
            const object = graph.get(id);
            if (!object)
                continue;
            members.push(object);
            for (const candidateId of [...remaining]) {
                const candidate = graph.get(candidateId);
                const connected = object.associations.some((edge) => edge.targetId === candidateId)
                    || candidate?.associations.some((edge) => edge.targetId === id) === true;
                if (connected) {
                    remaining.delete(candidateId);
                    queue.push(candidateId);
                }
            }
        }
        members.sort((left, right) => (right.workspace.attentionScore ?? Number.NEGATIVE_INFINITY)
            - (left.workspace.attentionScore ?? Number.NEGATIVE_INFINITY)
            || left.id.localeCompare(right.id));
        coalitions.push({
            id: members.map((member) => member.id).sort().join("+"),
            members,
            score: Math.max(...members.map((member) => member.workspace.attentionScore ?? Number.NEGATIVE_INFINITY))
        });
    }
    return coalitions.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
//# sourceMappingURL=coalitions.js.map