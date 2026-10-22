import type Database from "better-sqlite3";
import type { WorkerId } from "../types/ids.js";
import type { CognitiveEvent, NewCognitiveEvent } from "../types/model.js";

interface EventRow { sequence: number; event_json: string }

export class EventRepository {
  constructor(private readonly db: Database.Database) {}

  append<T>(event: NewCognitiveEvent<T>): CognitiveEvent<T> {
    const payload = { ...event, sequence: 0 } as CognitiveEvent<T>;
    const result = this.db.prepare(`INSERT INTO cognitive_events
      (id, worker_id, type, event_json, correlation_id, causation_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      event.id, event.workerId, event.type, JSON.stringify(payload), event.correlationId, event.causationId, event.occurredAt
    );
    const persisted = { ...event, sequence: Number(result.lastInsertRowid) };
    this.db.prepare("UPDATE cognitive_events SET event_json = ? WHERE sequence = ?")
      .run(JSON.stringify(persisted), persisted.sequence);
    return persisted;
  }

  listForWorker(workerId: WorkerId, afterSequence = 0, limit = 100): CognitiveEvent[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT sequence, event_json FROM cognitive_events
      WHERE worker_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`)
      .all(workerId, afterSequence, safeLimit) as EventRow[];
    return rows.map((row) => ({ ...(JSON.parse(row.event_json) as CognitiveEvent), sequence: row.sequence }));
  }

  listAll(afterSequence = 0, limit = 100): CognitiveEvent[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT sequence, event_json FROM cognitive_events
      WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`).all(afterSequence, safeLimit) as EventRow[];
    return rows.map((row) => ({ ...(JSON.parse(row.event_json) as CognitiveEvent), sequence: row.sequence }));
  }

  latestForWorker(workerId: WorkerId): CognitiveEvent | null {
    const row = this.db.prepare(`SELECT sequence, event_json FROM cognitive_events
      WHERE worker_id = ? ORDER BY sequence DESC LIMIT 1`).get(workerId) as EventRow | undefined;
    return row ? { ...(JSON.parse(row.event_json) as CognitiveEvent), sequence: row.sequence } : null;
  }
}
