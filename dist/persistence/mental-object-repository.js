export class MentalObjectRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    insert(object) {
        this.db.prepare(`INSERT INTO mental_objects
      (id, worker_id, kind, content, object_json, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(object.id, object.workerId, object.kind, object.content, JSON.stringify(object), object.createdAt, object.lastAccessedAt);
        return object;
    }
    get(id) {
        const row = this.db.prepare("SELECT object_json FROM mental_objects WHERE id = ?").get(id);
        return row ? hydrateMentalObject(JSON.parse(row.object_json)) : null;
    }
    update(object) {
        const result = this.db.prepare(`UPDATE mental_objects SET kind = ?, content = ?, object_json = ?, last_accessed_at = ?
      WHERE id = ?`).run(object.kind, object.content, JSON.stringify(object), object.lastAccessedAt, object.id);
        if (result.changes !== 1)
            throw new Error(`Mental object ${object.id} was not found`);
        return object;
    }
    listForWorker(workerId) {
        const rows = this.db.prepare("SELECT object_json FROM mental_objects WHERE worker_id = ? ORDER BY created_at, id")
            .all(workerId);
        return rows.map((row) => hydrateMentalObject(JSON.parse(row.object_json)));
    }
    listAll() {
        const rows = this.db.prepare("SELECT object_json FROM mental_objects ORDER BY created_at, id").all();
        return rows.map((row) => hydrateMentalObject(JSON.parse(row.object_json)));
    }
}
function hydrateMentalObject(object) {
    return {
        ...object,
        memoryRoles: Array.isArray(object.memoryRoles) ? object.memoryRoles : [],
        associations: Array.isArray(object.associations) ? object.associations : [],
        workspace: {
            attentionScore: object.workspace?.attentionScore ?? null,
            inWorkingMemory: object.workspace?.inWorkingMemory ?? object.memoryRoles?.includes("working") ?? false,
            broadcastCount: Number(object.workspace?.broadcastCount ?? 0),
            lastBroadcastAt: object.workspace?.lastBroadcastAt ?? null
        },
        activation: {
            ...object.activation,
            noise: Number(object.activation?.noise ?? 0),
            suppression: Number(object.activation?.suppression ?? 0),
            references: Array.isArray(object.activation?.references) ? object.activation.references : [object.createdAt]
        }
    };
}
//# sourceMappingURL=mental-object-repository.js.map