#!/usr/bin/env bun
//
// Builds the Kimball knowledge-base SQLite DB from markdown sources.
//
// Sources:   skills_data/kimball/knowledge_base/
// Output:    skills_data/kimball/kimball.db   (gitignored; install.sh copies to ~/.claude/skills/dbt/kimball/)
//
// Schema:
//   chapters       — one row per chapter (num, title, folder)
//   sections       — one row per ## / ### heading inside each chapter, with content
//   sections_fts   — FTS5 virtual table over heading_path + content + chapter_title
//   concepts       — one row per **bolded concept** in INDEX.md
//   concept_refs   — concept × chapter ref (with section hint + defining flag)
//
// Run:  bun run build:kimball

import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, statSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { parseSummary, parseConceptLine } from '../src/kimball';

const REPO_ROOT = join(import.meta.dir, '..');
const KB_DIR    = join(REPO_ROOT, 'skills_data/kimball/knowledge_base');
const OUT_DB    = join(REPO_ROOT, 'skills_data/kimball/kimball.db');

if (!existsSync(KB_DIR)) {
  console.error(`Knowledge base markdown not found at ${KB_DIR}.`);
  console.error('');
  console.error('The markdown sources are no longer shipped in this repo — the committed');
  console.error('kimball.db is the source of truth. To rebuild from scratch:');
  console.error('  cp -r ~/.claude/skills/kimball/knowledge_base ./skills_data/kimball/');
  console.error('  bun run build:kimball');
  console.error('See skills_data/kimball/README.md for details.');
  process.exit(1);
}

mkdirSync(dirname(OUT_DB), { recursive: true });
if (existsSync(OUT_DB)) unlinkSync(OUT_DB);

const db = new Database(OUT_DB);
// DELETE journal mode keeps the entire DB in one self-contained file (no -wal/-shm sidecars).
// That matters here: this DB is built once, committed to the repo, and copied around at install
// time. WAL mode would require shipping the sidecar files too, and readonly opens fail without them.
db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;');

// ─── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE chapters (
    num         INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    folder      TEXT NOT NULL
  );

  CREATE TABLE sections (
    id            INTEGER PRIMARY KEY,
    chapter_num   INTEGER NOT NULL REFERENCES chapters(num),
    heading       TEXT NOT NULL,            -- e.g. "Granularity"
    heading_path  TEXT NOT NULL,            -- e.g. "General Design Review Considerations > Granularity"
    heading_level INTEGER NOT NULL,         -- 2 for ##, 3 for ###
    content       TEXT NOT NULL,            -- body up to the next heading at same-or-higher level
    position      INTEGER NOT NULL          -- order within chapter (for stable ranking when FTS ties)
  );
  CREATE INDEX idx_sections_chapter ON sections(chapter_num);

  CREATE VIRTUAL TABLE sections_fts USING fts5(
    heading_path,
    content,
    chapter_title,
    content='sections',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TABLE concepts (
    name             TEXT PRIMARY KEY,      -- normalized lowercase form (for lookup)
    display_name     TEXT NOT NULL,         -- original casing from INDEX.md
    definition       TEXT,                  -- em-dash snippet, may be NULL for "see X" entries
    cross_reference  TEXT                   -- target concept name when entry is "see X"
  );

  CREATE TABLE concept_refs (
    concept       TEXT NOT NULL REFERENCES concepts(name),
    chapter_num   INTEGER NOT NULL,
    section_hint  TEXT,                     -- parenthetical "(Section name)" from INDEX.md
    is_defining   INTEGER NOT NULL,         -- 1 if **Ch N** (bolded), 0 if Ch N (referenced)
    ordinal       INTEGER NOT NULL          -- order this ref appeared in the concept's line
  );
  CREATE INDEX idx_concept_refs_concept ON concept_refs(concept);

  CREATE VIRTUAL TABLE concepts_fts USING fts5(
    name, display_name, definition,
    content='concepts', content_rowid='rowid',
    tokenize='porter unicode61'
  );
`);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function chapterNumFromFolder(folder: string): number | null {
  const m = folder.match(/^(\d{2})_/);
  return m ? parseInt(m[1]!, 10) : null;
}

// ─── Ingest chapters + sections ────────────────────────────────────────────────

const folders = readdirSync(KB_DIR)
  .filter(f => statSync(join(KB_DIR, f)).isDirectory())
  .filter(f => /^\d{2}_/.test(f))
  .sort();

const insertChapter = db.prepare('INSERT INTO chapters (num, title, folder) VALUES (?, ?, ?)');
const insertSection = db.prepare(`
  INSERT INTO sections (chapter_num, heading, heading_path, heading_level, content, position)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertFts = db.prepare(`
  INSERT INTO sections_fts (rowid, heading_path, content, chapter_title) VALUES (?, ?, ?, ?)
`);

let totalSections = 0;
for (const folder of folders) {
  const chapter_num = chapterNumFromFolder(folder);
  if (chapter_num === null) continue;
  const summaryPath = join(KB_DIR, folder, 'summary.md');
  if (!existsSync(summaryPath)) continue;
  const md = readFileSync(summaryPath, 'utf-8');
  const { title, sections } = parseSummary(md);
  insertChapter.run(chapter_num, title || folder, folder);
  let pos = 0;
  for (const s of sections) {
    const info = insertSection.run(
      chapter_num, s.heading, s.heading_path, s.level, s.content, pos++,
    );
    const rowid = Number(info.lastInsertRowid);
    insertFts.run(rowid, s.heading_path, s.content, title);
    totalSections++;
  }
}

// ─── Ingest INDEX.md concepts ──────────────────────────────────────────────────

const indexPath = join(KB_DIR, 'INDEX.md');
const indexText = readFileSync(indexPath, 'utf-8');

const insertConcept = db.prepare(`
  INSERT OR IGNORE INTO concepts (name, display_name, definition, cross_reference)
  VALUES (?, ?, ?, ?)
`);
const insertConceptFts = db.prepare(`
  INSERT INTO concepts_fts (rowid, name, display_name, definition) VALUES (?, ?, ?, ?)
`);
const insertConceptRef = db.prepare(`
  INSERT INTO concept_refs (concept, chapter_num, section_hint, is_defining, ordinal)
  VALUES (?, ?, ?, ?, ?)
`);

let conceptCount = 0;
let refCount = 0;
for (const rawLine of indexText.split('\n')) {
  const line = rawLine.trimEnd();
  if (!line.startsWith('- **')) continue;
  const parsed = parseConceptLine(line);
  if (!parsed) continue;
  const name = parsed.display_name.toLowerCase();
  const info = insertConcept.run(
    name, parsed.display_name, parsed.definition, parsed.cross_reference,
  );
  if (info.changes === 0) continue; // duplicate concept name (rare); skip subsequent
  conceptCount++;
  // Get the rowid we just inserted for the FTS table.
  const row = db.prepare('SELECT rowid FROM concepts WHERE name = ?').get(name) as { rowid: number } | undefined;
  if (row) insertConceptFts.run(row.rowid, name, parsed.display_name, parsed.definition ?? '');
  parsed.refs.forEach((r, i) => {
    insertConceptRef.run(name, r.chapter_num, r.section_hint, r.is_defining ? 1 : 0, i);
    refCount++;
  });
}

// ─── Report ───────────────────────────────────────────────────────────────────

const chapterCount = (db.prepare('SELECT COUNT(*) as c FROM chapters').get() as { c: number }).c;
const dbSize = statSync(OUT_DB).size;

db.close();

console.log(`Built ${OUT_DB}`);
console.log(`  chapters     ${chapterCount}`);
console.log(`  sections     ${totalSections}`);
console.log(`  concepts     ${conceptCount}`);
console.log(`  concept refs ${refCount}`);
console.log(`  db size      ${(dbSize / 1024).toFixed(1)} KB`);
