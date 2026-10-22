// A conversation on Speck's default path: its turns and its rule learning,
// kept as JSON under the runtime's data directory so it survives restarts.

import fs from "node:fs";
import path from "node:path";
import { emptyRuleLearning, type RuleLearningState } from "./rule-learning.js";

export interface Session {
  id: string;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
  rules: RuleLearningState;
  // Each later component's own state, by component id (component.ts).
  state?: Record<string, unknown>;
  log: Array<{ turn: number; path: string; components?: Record<string, Record<string, unknown>>; at: string }>;
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "Main";

export class SessionStore {
  constructor(private readonly directory: string) {}

  private file(id: string): string {
    return path.join(this.directory, `${safe(id)}.json`);
  }

  load(id: string): Session {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as Session;
      return { id, turns: parsed.turns ?? [], rules: parsed.rules ?? emptyRuleLearning(), state: parsed.state ?? {}, log: parsed.log ?? [] };
    } catch {
      return { id, turns: [], rules: emptyRuleLearning(), log: [] };
    }
  }

  save(session: Session): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const target = this.file(session.id);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(session, null, 2));
    fs.renameSync(`${target}.tmp`, target);
  }

  clear(id: string): void {
    try { fs.rmSync(this.file(id)); } catch { /* nothing to clear */ }
  }
}
