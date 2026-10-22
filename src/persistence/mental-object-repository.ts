import type Database from "better-sqlite3";
import type { MentalObjectId, WorkerId } from "../types/ids.js";
import type { MentalObject } from "../types/model.js";

interface ObjectRow { object_json: string }

export class MentalObjectRepository {
  constructor(private readonly db: Database.Database) {}

  insert(object: MentalObject): MentalObject {
    this.db.prepare(`INSERT INTO mental_objects
      (id, worker_id, kind, content, object_json, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(object.id, object.workerId, object.kind, object.content, JSON.stringify(object), object.createdAt, object.lastAccessedAt);
    return object;
  }

  get(id: MentalObjectId): MentalObject | null {
    const row = this.db.prepare("SELECT object_json FROM mental_objects WHERE id = ?").get(id) as ObjectRow | undefined;
    return row ? hydrateMentalObject(JSON.parse(row.object_json) as MentalObject) : null;
  }

  update(object: MentalObject): MentalObject {
    const result = this.db.prepare(`UPDATE mental_objects SET kind = ?, content = ?, object_json = ?, last_accessed_at = ?
      WHERE id = ?`).run(object.kind, object.content, JSON.stringify(object), object.lastAccessedAt, object.id);
    if (result.changes !== 1) throw new Error(`Mental object ${object.id} was not found`);
    return object;
  }

  listForWorker(workerId: WorkerId): MentalObject[] {
    const rows = this.db.prepare("SELECT object_json FROM mental_objects WHERE worker_id = ? ORDER BY created_at, id")
      .all(workerId) as ObjectRow[];
    return rows.map((row) => hydrateMentalObject(JSON.parse(row.object_json) as MentalObject));
  }

  listAll(): MentalObject[] {
    const rows = this.db.prepare("SELECT object_json FROM mental_objects ORDER BY created_at, id").all() as ObjectRow[];
    return rows.map((row) => hydrateMentalObject(JSON.parse(row.object_json) as MentalObject));
  }
}

function hydrateMentalObject(object: MentalObject): MentalObject {
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
