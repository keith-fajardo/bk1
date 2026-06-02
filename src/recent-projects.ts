// Recently-used dbt project directories, for the /project switcher.
//
// Persisted at ~/.bk1/projects.json (under BK1_HOME, alongside pet.json /
// auth.json) so the list survives across launches and across the standalone vs.
// VS Code-extension installs. Stored as a string[] of absolute paths,
// most-recent-first. The current launch dir is recorded on startup so the very
// first switch already has somewhere to go back to.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { BK1_HOME } from './bk1-home';
import { isDbtProject } from './project-dir';

const RECENTS_FILE = join(BK1_HOME, 'projects.json');
const MAX_RECENTS = 10;

function read(): string[] {
  if (!existsSync(RECENTS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(RECENTS_FILE, 'utf-8'));
    return Array.isArray(data) ? data.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function write(paths: string[]): void {
  try {
    mkdirSync(dirname(RECENTS_FILE), { recursive: true });
    writeFileSync(RECENTS_FILE, JSON.stringify(paths, null, 2), 'utf-8');
  } catch {
    // Recents are a convenience, not load-bearing — a failed write must never
    // break a project switch. Swallow and move on.
  }
}

// Recent projects, most-recent-first, filtered to paths that still exist and
// are still dbt projects (a project may have been moved/deleted between runs).
export function getRecentProjects(): string[] {
  return read().filter(p => isDbtProject(p));
}

// Move `dir` to the front of the recents list (dedup, cap, persist). Called on
// launch for the initial dir and on every successful /project switch.
export function recordRecentProject(dir: string): void {
  const abs = resolve(dir);
  const next = [abs, ...read().filter(p => resolve(p) !== abs)].slice(0, MAX_RECENTS);
  write(next);
}
