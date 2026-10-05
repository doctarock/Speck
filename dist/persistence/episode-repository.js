// A conversation's episodes, stored whole as JSON per episode.
export class EpisodeRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    save(episode) {
        this.db.connection.prepare(`INSERT INTO episodes (id, session_id, episode_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET episode_json = excluded.episode_json, updated_at = excluded.updated_at`)
            .run(episode.id, episode.sessionId, JSON.stringify(episode), episode.updatedAt);
    }
    get(id) {
        const row = this.db.connection.prepare("SELECT episode_json FROM episodes WHERE id = ?").get(id);
        return row ? JSON.parse(row.episode_json) : null;
    }
    // A session's episodes, most recently active first.
    forSession(sessionId, limit = 50) {
        return this.db.connection.prepare("SELECT episode_json FROM episodes WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?")
            .all(sessionId, limit).map((row) => JSON.parse(row.episode_json));
    }
    forTask(taskId) {
        const row = this.db.connection.prepare("SELECT episode_json FROM episodes WHERE json_extract(episode_json, '$.taskId') = ? ORDER BY updated_at DESC LIMIT 1")
            .get(taskId);
        return row ? JSON.parse(row.episode_json) : null;
    }
}
//# sourceMappingURL=episode-repository.js.map