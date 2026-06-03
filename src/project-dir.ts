// The active dbt project directory — the single source of truth.
//
// This was previously a module-level `const PROJECT_DIR` duplicated in tools.ts
// and state.ts, frozen at launch. It is now mutable session state behind a
// getter so the user can switch projects mid-session (/project picker) without
// relaunching. Every reader calls getProjectDir() at use time; the three things
// that captured the dir at import time (the resolved system prompt, the SQLite
// connection singleton, the lint-report path) are rebuilt explicitly on switch
// — see changeProject() in app.tsx.
//
// Initialized from DBT_PROJECT_DIR (env override) or the launch CWD, matching
// the original behavior.

import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

let projectDir = resolve(process.env.DBT_PROJECT_DIR ?? process.cwd());

export function getProjectDir(): string {
  return projectDir;
}

// A directory is a valid dbt project target if it contains dbt_project.yml.
// Mirrors the launch-time expectation; the switch UI uses this to reject a bad
// path before tearing down per-project state.
export function isDbtProject(dir: string): boolean {
  return existsSync(join(resolve(dir), 'dbt_project.yml'));
}

// Returns a human-readable error if dir's dbt_project.yml exists but cannot be
// read, else null. On macOS, projects under ~/Desktop, ~/Documents, ~/Downloads
// are TCC-gated: existsSync (so isDbtProject) passes, yet open() throws EPERM.
// changeProject probes this before tearing down state so a /project switch fails
// with an actionable message instead of crashing later in buildSystemPrompt.
export function projectAccessError(dir: string): string | null {
  const path = join(resolve(dir), 'dbt_project.yml');
  try {
    readFileSync(path, 'utf-8');
    return null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return `Permission denied reading ${path}. On macOS, grant your terminal Full Disk Access (System Settings → Privacy & Security → Full Disk Access), then retry.`;
    }
    return `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Point the session at a new project directory. Returns the resolved path.
// Throws if the path isn't a dbt project so callers can surface the error
// without having mutated anything downstream. Callers are responsible for
// rebuilding the dependent state (DB connection, system prompt, session) after
// this returns — see changeProject() in app.tsx.
export function setProjectDir(dir: string): string {
  const next = resolve(dir);
  if (!isDbtProject(next)) {
    throw new Error(`Not a dbt project (no dbt_project.yml): ${next}`);
  }
  projectDir = next;
  return next;
}
