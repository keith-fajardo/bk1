// Global, cross-project usage ledger.
//
// The Anthropic Admin Usage API can tell us org-wide spend but it has no idea
// which local dbt project bk1 was driving when each call fired. To break spend
// down "per project" we have to track it ourselves — one event row per LLM
// call, keyed by the absolute project path bk1 was launched in.
//
// Storage lives at ~/.bk1/usage.db so it survives across sessions and is
// shared by every dbt project bk1 ever runs against. Writes are best-effort:
// any failure is swallowed because usage tracking must never block real work.

import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BK1_HOME } from './bk1-home';

const DB_PATH = join(BK1_HOME, 'usage.db');

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  if (!existsSync(BK1_HOME)) mkdirSync(BK1_HOME, { recursive: true });
  const conn = new Database(DB_PATH);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      ts            INTEGER NOT NULL,
      project_path  TEXT    NOT NULL,
      model         TEXT    NOT NULL,
      input         INTEGER NOT NULL,
      output        INTEGER NOT NULL,
      cache_read    INTEGER NOT NULL,
      cache_write   INTEGER NOT NULL,
      cost_usd      REAL    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_project_ts ON usage_events (project_path, ts);
    CREATE TABLE IF NOT EXISTS turn_costs (
      ts            INTEGER NOT NULL,
      project_path  TEXT    NOT NULL,
      turn_label    TEXT    NOT NULL,
      primary_model TEXT    NOT NULL DEFAULT '',
      prompt_text   TEXT    NOT NULL DEFAULT '',
      summary       TEXT    NOT NULL DEFAULT '',
      cost_usd      REAL    NOT NULL,
      input         INTEGER NOT NULL,
      output        INTEGER NOT NULL,
      cache_read    INTEGER NOT NULL,
      cache_write   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turn_costs_ts ON turn_costs (ts DESC);
  `);
  // Migrate existing turn_costs tables that predate added columns.
  try { conn.exec(`ALTER TABLE turn_costs ADD COLUMN primary_model TEXT NOT NULL DEFAULT ''`); } catch {}
  try { conn.exec(`ALTER TABLE turn_costs ADD COLUMN prompt_text   TEXT NOT NULL DEFAULT ''`); } catch {}
  try { conn.exec(`ALTER TABLE turn_costs ADD COLUMN summary       TEXT NOT NULL DEFAULT ''`); } catch {}
  db = conn;
  return conn;
}

export interface ProjectUsageEvent {
  projectPath: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export function recordProjectUsage(evt: ProjectUsageEvent): void {
  try {
    getDb().prepare(`
      INSERT INTO usage_events (ts, project_path, model, input, output, cache_read, cache_write, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      evt.projectPath,
      evt.model,
      evt.input,
      evt.output,
      evt.cacheRead,
      evt.cacheWrite,
      evt.costUsd,
    );
  } catch {
    // Intentional: never let usage tracking break the agent loop.
  }
}

export interface TurnCostEvent {
  projectPath: string;
  turnLabel: string;
  primaryModel: string;
  promptText: string;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Returns the ts used for the insert so the caller can match the row for updateTurnSummary.
export function recordTurnCost(evt: TurnCostEvent): number {
  const ts = Date.now();
  try {
    getDb().prepare(`
      INSERT INTO turn_costs (ts, project_path, turn_label, primary_model, prompt_text, summary, cost_usd, input, output, cache_read, cache_write)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
    `).run(
      ts,
      evt.projectPath,
      evt.turnLabel,
      evt.primaryModel,
      evt.promptText,
      evt.costUsd,
      evt.input,
      evt.output,
      evt.cacheRead,
      evt.cacheWrite,
    );
  } catch {
    // Intentional: never let usage tracking break the agent loop.
  }
  return ts;
}

export function updateTurnSummary(ts: number, projectPath: string, summary: string): void {
  try {
    getDb().prepare(`UPDATE turn_costs SET summary = ? WHERE ts = ? AND project_path = ?`)
      .run(summary, ts, projectPath);
  } catch {
    // Intentional: never let usage tracking break the agent loop.
  }
}

export interface TurnHistoryRow {
  ts: number;
  projectPath: string;
  turnLabel: string;
  primaryModel: string;
  promptText: string;
  summary: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function loadTurnHistory(limit = 30): TurnHistoryRow[] {
  try {
    return getDb().prepare(`
      SELECT
        ts,
        project_path    AS projectPath,
        turn_label      AS turnLabel,
        primary_model   AS primaryModel,
        prompt_text     AS promptText,
        summary         AS summary,
        cost_usd        AS costUsd,
        input           AS inputTokens,
        output          AS outputTokens
      FROM turn_costs
      ORDER BY ts DESC
      LIMIT ?
    `).all(limit) as TurnHistoryRow[];
  } catch {
    return [];
  }
}

export interface ProjectTotals {
  projectPath: string;
  tokens: number;
  costUsd: number;
  firstSeen: number;
  lastSeen: number;
  callCount: number;
}

export function loadProjectTotals(): ProjectTotals[] {
  try {
    const rows = getDb().prepare(`
      SELECT
        project_path                                              AS projectPath,
        SUM(input + output + cache_read + cache_write)            AS tokens,
        SUM(cost_usd)                                             AS costUsd,
        MIN(ts)                                                   AS firstSeen,
        MAX(ts)                                                   AS lastSeen,
        COUNT(*)                                                  AS callCount
      FROM usage_events
      GROUP BY project_path
      ORDER BY costUsd DESC
    `).all() as ProjectTotals[];
    return rows;
  } catch {
    return [];
  }
}
