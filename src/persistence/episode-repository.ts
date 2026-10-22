// A conversation's episodes, stored whole as JSON per episode.

import type { SpeckDatabase } from "./database.js";

export interface EpisodeTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
  // The meaning vector of a user turn; absent when no encoder answered.
  vector?: number[];
  // How a user turn was placed in its episode: by Speck's signals, by the
  // reading role when they did not settle it, or by fallback; with each
  // open episode's score at the time.
  placement?: {
    decision: "continue" | "new" | "ambiguous" | "reply";
    by: "signals" | "persistence" | "reading" | "fallback" | "waiting-task";
    scores: Array<{ episodeId: string; meaning: number; shared: string[]; score: number }>;
    // Set when the user moved the turn: the episode Speck had placed it in.
    // With the scores, a labelled example of where Speck was wrong.
    correctedFrom?: string;
  };
}

export interface Episode {
  id: string;
  sessionId: string;
  // The task that holds the episode's reasoning; null until one is needed (an
  // episode the user made by moving a message into a new thread).
  taskId: string | null;
  // A closed episode (cancelled by the user) is no longer continued.
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  turns: EpisodeTurn[];
  referents: string[];
}

export class EpisodeRepository {
  constructor(private readonly db: SpeckDatabase) {}

  save(episode: Episode): void {
    this.db.connection.prepare(`INSERT INTO episodes (id, session_id, episode_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET episode_json = excluded.episode_json, updated_at = excluded.updated_at`)
      .run(episode.id, episode.sessionId, JSON.stringify(episode), episode.updatedAt);
  }

  get(id: string): Episode | null {
    const row = this.db.connection.prepare("SELECT episode_json FROM episodes WHERE id = ?").get(id) as { episode_json: string } | undefined;
    return row ? JSON.parse(row.episode_json) as Episode : null;
  }

  // A session's episodes, most recently active first.
  forSession(sessionId: string, limit = 50): Episode[] {
    return (this.db.connection.prepare("SELECT episode_json FROM episodes WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(sessionId, limit) as Array<{ episode_json: string }>).map((row) => JSON.parse(row.episode_json) as Episode);
  }

  forTask(taskId: string): Episode | null {
    const row = this.db.connection.prepare("SELECT episode_json FROM episodes WHERE json_extract(episode_json, '$.taskId') = ? ORDER BY updated_at DESC LIMIT 1")
      .get(taskId) as { episode_json: string } | undefined;
    return row ? JSON.parse(row.episode_json) as Episode : null;
  }
}
