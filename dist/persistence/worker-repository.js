import { NotFoundError, RevisionConflictError } from "../errors.js";
export class WorkerRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    insert(worker) {
        this.db.prepare(`INSERT INTO workers (id, status, objective, state_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(worker.id, worker.status, worker.objective.description, JSON.stringify(worker), worker.revision, worker.createdAt, worker.updatedAt);
        return worker;
    }
    get(id) {
        const row = this.db.prepare("SELECT state_json FROM workers WHERE id = ?").get(id);
        return row ? JSON.parse(row.state_json) : null;
    }
    require(id) {
        const worker = this.get(id);
        if (!worker)
            throw new NotFoundError("Worker", id);
        return worker;
    }
    list(status) {
        const rows = (status
            ? this.db.prepare("SELECT state_json FROM workers WHERE status = ? ORDER BY created_at, id").all(status)
            : this.db.prepare("SELECT state_json FROM workers ORDER BY created_at, id").all());
        return rows.map((row) => JSON.parse(row.state_json));
    }
    update(worker, expectedRevision) {
        const result = this.db.prepare(`UPDATE workers SET status = ?, objective = ?, state_json = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?`).run(worker.status, worker.objective.description, JSON.stringify(worker), worker.revision, worker.updatedAt, worker.id, expectedRevision);
        if (result.changes !== 1)
            throw new RevisionConflictError(worker.id);
        return worker;
    }
}
//# sourceMappingURL=worker-repository.js.map