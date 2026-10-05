import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
export class SpeckDatabase {
    filePath;
    connection;
    constructor(filePath) {
        this.filePath = filePath;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.connection = new Database(filePath);
        this.connection.pragma("journal_mode = WAL");
        this.connection.pragma("foreign_keys = ON");
        this.connection.pragma("busy_timeout = 5000");
        this.migrate();
    }
    transaction(operation) {
        return this.connection.transaction(operation)();
    }
    close() {
        if (this.connection.open)
            this.connection.close();
    }
    migrate() {
        const version = this.connection.pragma("user_version", { simple: true });
        if (version > 5)
            throw new Error(`Database schema ${version} is newer than this Speck build supports`);
        if (version === 0) {
            this.connection.exec(`
        CREATE TABLE workers (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          objective TEXT NOT NULL,
          state_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX workers_status_idx ON workers(status);

        CREATE TABLE mental_objects (
          id TEXT PRIMARY KEY,
          worker_id TEXT REFERENCES workers(id) ON DELETE RESTRICT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          object_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_accessed_at TEXT NOT NULL
        );
        CREATE INDEX mental_objects_worker_idx ON mental_objects(worker_id, kind);

        CREATE TABLE cognitive_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          worker_id TEXT REFERENCES workers(id) ON DELETE RESTRICT,
          type TEXT NOT NULL,
          event_json TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          causation_id TEXT,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX cognitive_events_worker_sequence_idx ON cognitive_events(worker_id, sequence);
        CREATE INDEX cognitive_events_correlation_idx ON cognitive_events(correlation_id, sequence);
        PRAGMA user_version = 4;
      `);
        }
        if (version === 1) {
            // Phase 1 extends JSON envelopes without changing indexed columns. Readers
            // supply defaults for Phase 0 Mental Objects, so only the schema marker moves.
            this.connection.pragma("user_version = 4");
        }
        if (version === 2) {
            // Phase 2 adds activation noise and inline associative edges to the
            // Mental Object JSON envelope; hydration supplies defaults lazily.
            this.connection.pragma("user_version = 4");
        }
        if (version === 3) {
            // Phase 3 adds GWT workspace bookkeeping to Mental Object JSON.
            // Hydration derives safe defaults from the existing working role.
            this.connection.pragma("user_version = 4");
        }
        if (this.connection.pragma("user_version", { simple: true }) === 4) {
            // Schema 5: a conversation's episodes (the threads of messages about one
            // subject), each with the task that holds its reasoning.
            this.connection.exec(`
        CREATE TABLE IF NOT EXISTS episodes (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          episode_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS episodes_session_idx ON episodes(session_id, updated_at);
        PRAGMA user_version = 5;
      `);
        }
    }
}
//# sourceMappingURL=database.js.map