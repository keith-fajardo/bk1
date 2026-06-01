// Cross-session conversation history.
//
// Each bk1 launch creates a new session row at startup. As the conversation
// progresses, message inserts are batched and flushed to disk via a debounced
// saveSessionMessages call from app.tsx. /history opens a picker showing
// recent sessions for the current project; selecting one loads its messages
// into the live conversation view and the LLM history ref so the next prompt
// continues with full prior context.
//
// Storage: ~/.bk1/sessions.db (bun:sqlite), so it persists across bk1 versions
// and survives extension upgrades. Same persistence model as auth.json / pet.json.
//
// Per-project scoping: list operations filter by project_path so the picker
// in one dbt project doesn't surface unrelated sessions from another. Useful
// because users often run bk1 in multiple projects on the same machine.

import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BK1_HOME } from './bk1-home';

const DB_PATH = join(BK1_HOME, 'sessions.db');

export interface StoredMessage {
  role:    'user' | 'assistant';
  content: string;
  info?:   boolean;
}

export interface SessionInfo {
  id:           number;
  started_at:   string;
  last_used_at: string;
  title:        string | null;
  model:        string;
  message_count: number;
}

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  if (!existsSync(BK1_HOME)) mkdirSync(BK1_HOME, { recursive: true });
  const conn = new Database(DB_PATH);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT    NOT NULL,
      last_used_at  TEXT    NOT NULL,
      project_path  TEXT    NOT NULL,
      model         TEXT    NOT NULL,
      title         TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_by_project
      ON sessions(project_path, last_used_at DESC);

    CREATE TABLE IF NOT EXISTS session_messages (
      session_id INTEGER NOT NULL,
      idx        INTEGER NOT NULL,
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      info       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, idx)
    );
    -- FTS5 over message content. Maintained manually in saveSessionMessages
    -- (insert/delete) so we don't depend on FTS5 triggers (simpler to reason
    -- about when we replace-all on save). UNINDEXED columns are stored but
    -- not tokenized — session_id is just needed for the WHERE join.
    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
      session_id UNINDEXED,
      content,
      tokenize = 'porter unicode61'
    );
  `);
  db = conn;
  return conn;
}

export function createSession(projectPath: string, model: string): number {
  const now = new Date().toISOString();
  const row = getDb()
    .query<{ id: number }, [string, string, string, string]>(
      `INSERT INTO sessions (started_at, last_used_at, project_path, model)
       VALUES (?, ?, ?, ?)
       RETURNING id`
    )
    .get(now, now, projectPath, model);
  if (!row) throw new Error('createSession: insert returned no row');
  return row.id;
}

// Replace-all save. Simpler than incremental tracking and the sessions are
// small enough (typically <100 messages) that the write is cheap.
export function saveSessionMessages(sessionId: number, messages: StoredMessage[]): void {
  const conn = getDb();
  const now = new Date().toISOString();
  // Title = the first user message, trimmed to a reasonable preview length.
  // We only set it once (COALESCE) so the title stays stable across saves.
  const firstUser = messages.find(m => m.role === 'user');
  const title = firstUser ? firstUser.content.split('\n')[0]!.slice(0, 80) : null;

  conn.transaction(() => {
    conn.query(`DELETE FROM session_messages WHERE session_id = ?`).run(sessionId);
    conn.query(`DELETE FROM session_messages_fts WHERE session_id = ?`).run(sessionId);
    const insertMsg = conn.prepare(
      `INSERT INTO session_messages (session_id, idx, role, content, info)
       VALUES (?, ?, ?, ?, ?)`
    );
    const insertFts = conn.prepare(
      `INSERT INTO session_messages_fts (session_id, content) VALUES (?, ?)`
    );
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      insertMsg.run(sessionId, i, m.role, m.content, m.info ? 1 : 0);
      insertFts.run(sessionId, m.content);
    }
    conn.query(
      `UPDATE sessions
         SET last_used_at = ?,
             title = COALESCE(title, ?)
       WHERE id = ?`
    ).run(now, title, sessionId);
  })();
}

// Search across sessions: title LIKE OR FTS-matched content. Returns the same
// SessionInfo shape as listRecentSessions, plus an optional content snippet
// when the match was in the message body. snippet() returns a short excerpt
// around the matched term so users can scan results without opening each one.
export interface SessionSearchHit extends SessionInfo {
  snippet?: string;  // ~30 chars of context around the FTS match, if any
}

export function searchSessions(projectPath: string, query: string, limit = 20): SessionSearchHit[] {
  const trimmed = query.trim();
  if (trimmed === '') {
    return listRecentSessions(projectPath, limit).map(s => ({ ...s }));
  }
  const conn = getDb();
  // Sanitize for FTS5: wrap each whitespace-separated term in double quotes
  // so user input can't accidentally trigger FTS5 operator syntax (NEAR, OR,
  // column filters, etc.) — we want plain term matching, not query DSL.
  const ftsQuery = trimmed
    .split(/\s+/)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
  const like = `%${trimmed}%`;
  const rows = conn
    .query<{
      id: number; started_at: string; last_used_at: string;
      title: string | null; model: string; message_count: number;
      snippet: string | null;
    }, [string, string, string, number]>(
      `SELECT s.id, s.started_at, s.last_used_at, s.title, s.model,
              (SELECT COUNT(*) FROM session_messages WHERE session_id = s.id) AS message_count,
              (SELECT snippet(session_messages_fts, 1, '', '', '…', 8)
                 FROM session_messages_fts
                WHERE session_messages_fts MATCH ?2
                  AND session_id = s.id
                LIMIT 1) AS snippet
         FROM sessions s
        WHERE s.project_path = ?1
          AND (
            COALESCE(s.title, '') LIKE ?3
            OR EXISTS (
              SELECT 1 FROM session_messages_fts
               WHERE session_messages_fts MATCH ?2
                 AND session_id = s.id
            )
          )
        ORDER BY s.last_used_at DESC
        LIMIT ?4`
    )
    .all(projectPath, ftsQuery, like, limit);
  return rows.map(r => ({
    id: r.id,
    started_at: r.started_at,
    last_used_at: r.last_used_at,
    title: r.title,
    model: r.model,
    message_count: r.message_count,
    snippet: r.snippet ?? undefined,
  }));
}

export function listRecentSessions(projectPath: string, limit = 20): SessionInfo[] {
  const rows = getDb()
    .query<{
      id: number; started_at: string; last_used_at: string;
      title: string | null; model: string; message_count: number;
    }, [string, number]>(
      `SELECT s.id, s.started_at, s.last_used_at, s.title, s.model,
              (SELECT COUNT(*) FROM session_messages WHERE session_id = s.id) AS message_count
         FROM sessions s
        WHERE s.project_path = ?
          AND EXISTS (SELECT 1 FROM session_messages WHERE session_id = s.id)
        ORDER BY s.last_used_at DESC
        LIMIT ?`
    )
    .all(projectPath, limit);
  return rows;
}

export function loadSessionMessages(sessionId: number): StoredMessage[] {
  const rows = getDb()
    .query<{ role: string; content: string; info: number }, [number]>(
      `SELECT role, content, info
         FROM session_messages
        WHERE session_id = ?
        ORDER BY idx ASC`
    )
    .all(sessionId);
  return rows.map(r => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
    info: r.info === 1,
  }));
}

export function deleteSession(sessionId: number): void {
  const conn = getDb();
  conn.transaction(() => {
    conn.query(`DELETE FROM session_messages WHERE session_id = ?`).run(sessionId);
    conn.query(`DELETE FROM session_messages_fts WHERE session_id = ?`).run(sessionId);
    conn.query(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  })();
}

// Pretty-format a session for the picker line. Keeps the column layout tight
// so it fits in a typical terminal width without wrapping.
export function formatSessionLine(s: SessionInfo): string {
  const date = new Date(s.last_used_at);
  const datePart = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  const title = s.title ?? '(empty)';
  const count = `${s.message_count}m`;
  return `${datePart}  ${count.padStart(5)}  ${title}`;
}
