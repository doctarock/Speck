export class EventRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    append(event) {
        const payload = { ...event, sequence: 0 };
        const result = this.db.prepare(`INSERT INTO cognitive_events
      (id, worker_id, type, event_json, correlation_id, causation_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(event.id, event.workerId, event.type, JSON.stringify(payload), event.correlationId, event.causationId, event.occurredAt);
        const persisted = { ...event, sequence: Number(result.lastInsertRowid) };
        this.db.prepare("UPDATE cognitive_events SET event_json = ? WHERE sequence = ?")
            .run(JSON.stringify(persisted), persisted.sequence);
        return persisted;
    }
    listForWorker(workerId, afterSequence = 0, limit = 100) {
        const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
        const rows = this.db.prepare(`SELECT sequence, event_json FROM cognitive_events
      WHERE worker_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`)
            .all(workerId, afterSequence, safeLimit);
        return rows.map((row) => ({ ...JSON.parse(row.event_json), sequence: row.sequence }));
    }
    listAll(afterSequence = 0, limit = 100) {
        const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
        const rows = this.db.prepare(`SELECT sequence, event_json FROM cognitive_events
      WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`).all(afterSequence, safeLimit);
        return rows.map((row) => ({ ...JSON.parse(row.event_json), sequence: row.sequence }));
    }
    latestForWorker(workerId) {
        const row = this.db.prepare(`SELECT sequence, event_json FROM cognitive_events
      WHERE worker_id = ? ORDER BY sequence DESC LIMIT 1`).get(workerId);
        return row ? { ...JSON.parse(row.event_json), sequence: row.sequence } : null;
    }
}
//# sourceMappingURL=event-repository.js.map