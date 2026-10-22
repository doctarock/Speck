import type Database from "better-sqlite3";
import { NotFoundError, RevisionConflictError } from "../errors.js";
import type { WorkerId } from "../types/ids.js";
import type { Worker, WorkerStatus } from "../types/model.js";

interface WorkerRow { state_json: string }

export class WorkerRepository {
  constructor(private readonly db: Database.Database) {}

  insert(worker: Worker): Worker {
    this.db.prepare(`INSERT INTO workers (id, status, objective, state_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      worker.id, worker.status, worker.objective.description, JSON.stringify(worker), worker.revision, worker.createdAt, worker.updatedAt
    );
    return worker;
  }

  get(id: WorkerId): Worker | null {
    const row = this.db.prepare("SELECT state_json FROM workers WHERE id = ?").get(id) as WorkerRow | undefined;
    return row ? JSON.parse(row.state_json) as Worker : null;
  }

  require(id: WorkerId): Worker {
    const worker = this.get(id);
    if (!worker) throw new NotFoundError("Worker", id);
    return worker;
  }

  list(status?: WorkerStatus): Worker[] {
    const rows = (status
      ? this.db.prepare("SELECT state_json FROM workers WHERE status = ? ORDER BY created_at, id").all(status)
      : this.db.prepare("SELECT state_json FROM workers ORDER BY created_at, id").all()) as WorkerRow[];
    return rows.map((row) => JSON.parse(row.state_json) as Worker);
  }

  update(worker: Worker, expectedRevision: number): Worker {
    const result = this.db.prepare(`UPDATE workers SET status = ?, objective = ?, state_json = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?`).run(
      worker.status, worker.objective.description, JSON.stringify(worker), worker.revision, worker.updatedAt, worker.id, expectedRevision
    );
    if (result.changes !== 1) throw new RevisionConflictError(worker.id);
    return worker;
  }
}
