// Read-only access layer for the bundled Kimball knowledge-base SQLite DB.
//
// The DB is built by scripts/build_kimball_db.ts from the markdown sources in
// skills_data/kimball/knowledge_base/. install.sh deploys it to ~/.claude/skills/dbt/kimball/.
//
// Tool dispatcher (in tools.ts) calls these functions via the `kimball_query` tool.

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { join } from 'path';
import { bk1AssetsDir } from './bk1-home';

// Resolve the DB the same way the /kimball skill resolves the knowledge directory:
// installed location first, then repo-relative dev path.
function resolveDbPath(): string | null {
  const installed = join(bk1AssetsDir(), 'kimball/kimball.db');
  if (existsSync(installed)) return installed;
  const dev = join(import.meta.dir, '..', 'skills_data/kimball/kimball.db');
  if (existsSync(dev)) return dev;
  return null;
}

let cachedDb: Database | null = null;
let cachedDbPath: string | null = null;
function getDb(): Database | null {
  if (cachedDb) return cachedDb;
  const path = resolveDbPath();
  if (!path) return null;
  cachedDbPath = path;
  cachedDb = new Database(path, { readonly: true });
  return cachedDb;
}

// Used by tests to override the cached DB. Production callers should never need this.
export function _setKimballDbForTesting(db: Database | null): void {
  cachedDb = db;
  cachedDbPath = db ? '<test>' : null;
}

export interface KimballQueryInput {
  mode: 'concept' | 'search' | 'section' | 'chapter';
  q?: string;          // search term for concept / search modes
  chapter?: number;    // required for section / chapter modes
  section?: string;    // optional for section mode (heading or heading_path substring)
  limit?: number;      // for search mode; default 5, max 15
}

export interface ConceptHit {
  display_name: string;
  definition: string | null;
  cross_reference: string | null;
  chapters: { num: number; section_hint: string | null; is_defining: boolean }[];
}

export interface SectionHit {
  chapter_num: number;
  chapter_title: string;
  heading: string;
  heading_path: string;
  heading_level: number;
  content: string;
  excerpt?: string;   // first ~300 chars when returned by search (full content available via section mode)
}

export interface ChapterToc {
  num: number;
  title: string;
  sections: { heading_path: string; heading_level: number }[];
}

// FTS5 input sanitization. Users type natural language; we strip characters that confuse
// FTS5's query parser (quotes, asterisks, parens) and quote each token to avoid operator
// surprises. Empty / whitespace-only queries return '' so the caller can short-circuit.
function sanitizeFts(q: string): string {
  const tokens = q.replace(/["*()-]/g, ' ').split(/\s+/).filter(t => t.length > 0);
  return tokens.map(t => `"${t.replace(/"/g, '')}"`).join(' ');
}

export function lookupConcept(q: string): ConceptHit[] {
  const db = getDb(); if (!db) return [];
  const cleaned = sanitizeFts(q);
  if (!cleaned) return [];
  // Prefer exact-name matches first (cheaper, more precise), then fall back to FTS.
  const exact = db.prepare(`
    SELECT name FROM concepts WHERE name = ?
  `).all(q.toLowerCase()) as { name: string }[];
  const fts = db.prepare(`
    SELECT c.name
    FROM concepts c
    JOIN concepts_fts f ON f.rowid = c.rowid
    WHERE concepts_fts MATCH ?
    ORDER BY rank
    LIMIT 10
  `).all(cleaned) as { name: string }[];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of [...exact, ...fts]) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    names.push(r.name);
    if (names.length >= 5) break;
  }
  if (names.length === 0) return [];
  // Fetch concept + refs in a single round trip per concept (small N, fine to loop).
  const stmtConcept = db.prepare(`
    SELECT display_name, definition, cross_reference FROM concepts WHERE name = ?
  `);
  const stmtRefs = db.prepare(`
    SELECT chapter_num, section_hint, is_defining
    FROM concept_refs WHERE concept = ? ORDER BY ordinal
  `);
  const out: ConceptHit[] = [];
  for (const name of names) {
    const c = stmtConcept.get(name) as { display_name: string; definition: string | null; cross_reference: string | null } | undefined;
    if (!c) continue;
    const refs = stmtRefs.all(name) as { chapter_num: number; section_hint: string | null; is_defining: number }[];
    out.push({
      display_name: c.display_name,
      definition: c.definition,
      cross_reference: c.cross_reference,
      chapters: refs.map(r => ({ num: r.chapter_num, section_hint: r.section_hint, is_defining: !!r.is_defining })),
    });
  }
  return out;
}

export function searchSections(q: string, limit: number): SectionHit[] {
  const db = getDb(); if (!db) return [];
  const cleaned = sanitizeFts(q);
  if (!cleaned) return [];
  const bounded = Math.min(Math.max(1, limit), 15);
  const rows = db.prepare(`
    SELECT s.chapter_num, s.heading, s.heading_path, s.heading_level, s.content, c.title AS chapter_title
    FROM sections_fts f
    JOIN sections s ON s.id = f.rowid
    JOIN chapters c ON c.num = s.chapter_num
    WHERE sections_fts MATCH ?
    ORDER BY rank, s.chapter_num, s.position
    LIMIT ?
  `).all(cleaned, bounded) as Array<{
    chapter_num: number; chapter_title: string;
    heading: string; heading_path: string; heading_level: number; content: string;
  }>;
  return rows.map(r => ({
    chapter_num: r.chapter_num,
    chapter_title: r.chapter_title,
    heading: r.heading,
    heading_path: r.heading_path,
    heading_level: r.heading_level,
    // Search results return an excerpt to keep the response small; the agent can call
    // section mode to fetch full content if it wants more.
    content: r.content,
    excerpt: r.content.length > 400 ? r.content.slice(0, 400) + '…' : r.content,
  }));
}

export function getSection(chapter: number, sectionQuery?: string): SectionHit[] {
  const db = getDb(); if (!db) return [];
  if (sectionQuery) {
    const rows = db.prepare(`
      SELECT s.chapter_num, s.heading, s.heading_path, s.heading_level, s.content, c.title AS chapter_title
      FROM sections s JOIN chapters c ON c.num = s.chapter_num
      WHERE s.chapter_num = ?
        AND (LOWER(s.heading_path) LIKE '%' || LOWER(?) || '%' OR LOWER(s.heading) LIKE '%' || LOWER(?) || '%')
      ORDER BY s.position
    `).all(chapter, sectionQuery, sectionQuery) as Array<{
      chapter_num: number; chapter_title: string;
      heading: string; heading_path: string; heading_level: number; content: string;
    }>;
    return rows;
  }
  // No section query — return all sections for the chapter (caller can pick).
  const rows = db.prepare(`
    SELECT s.chapter_num, s.heading, s.heading_path, s.heading_level, s.content, c.title AS chapter_title
    FROM sections s JOIN chapters c ON c.num = s.chapter_num
    WHERE s.chapter_num = ? ORDER BY s.position
  `).all(chapter) as Array<{
    chapter_num: number; chapter_title: string;
    heading: string; heading_path: string; heading_level: number; content: string;
  }>;
  return rows;
}

// Returns a chapter's table of contents — heading list only, no content. Lightweight
// alternative to dumping every section when the agent just needs to know what's in there.
export function getChapterToc(chapter: number): ChapterToc | null {
  const db = getDb(); if (!db) return null;
  const chap = db.prepare(`SELECT num, title FROM chapters WHERE num = ?`).get(chapter) as { num: number; title: string } | undefined;
  if (!chap) return null;
  const sections = db.prepare(`
    SELECT heading_path, heading_level FROM sections WHERE chapter_num = ? ORDER BY position
  `).all(chapter) as { heading_path: string; heading_level: number }[];
  return { num: chap.num, title: chap.title, sections };
}

export function kimballQuery(input: KimballQueryInput): string {
  const db = getDb();
  if (!db) {
    return JSON.stringify({
      error: 'kimball_db_not_installed',
      message: 'Kimball knowledge base DB not found. Run "bun run setup" to build and install it.',
    }, null, 2);
  }

  switch (input.mode) {
    case 'concept': {
      if (!input.q) return JSON.stringify({ error: 'missing_query', message: 'Pass q="<concept name>"' });
      const hits = lookupConcept(input.q);
      return JSON.stringify({ mode: 'concept', q: input.q, count: hits.length, hits }, null, 2);
    }
    case 'search': {
      if (!input.q) return JSON.stringify({ error: 'missing_query', message: 'Pass q="<search query>"' });
      const hits = searchSections(input.q, input.limit ?? 5);
      // Return excerpts only — full content available via section mode. Keeps the search
      // response small (~1-2KB) even with 5 hits.
      const slim = hits.map(h => ({
        chapter_num: h.chapter_num,
        chapter_title: h.chapter_title,
        heading_path: h.heading_path,
        excerpt: h.excerpt,
      }));
      return JSON.stringify({ mode: 'search', q: input.q, count: slim.length, hits: slim }, null, 2);
    }
    case 'section': {
      if (typeof input.chapter !== 'number') return JSON.stringify({ error: 'missing_chapter', message: 'Pass chapter=<number>' });
      const hits = getSection(input.chapter, input.section);
      return JSON.stringify({ mode: 'section', chapter: input.chapter, count: hits.length, sections: hits }, null, 2);
    }
    case 'chapter': {
      if (typeof input.chapter !== 'number') return JSON.stringify({ error: 'missing_chapter', message: 'Pass chapter=<number>' });
      const toc = getChapterToc(input.chapter);
      if (!toc) return JSON.stringify({ error: 'chapter_not_found', chapter: input.chapter });
      return JSON.stringify(toc, null, 2);
    }
    default:
      return JSON.stringify({ error: 'unknown_mode', message: `Unknown mode: ${input.mode}` });
  }
}

export function kimballDbInfo(): { path: string | null; installed: boolean } {
  const p = resolveDbPath();
  // Touch the cache so subsequent calls share the open handle.
  if (p && !cachedDb) { cachedDbPath = p; }
  return { path: p, installed: !!p };
}

export { cachedDbPath as _cachedDbPathForDebug };

// ─── Markdown parsers ──────────────────────────────────────────────────────────
//
// Exported as pure functions so unit tests can exercise edge cases without needing
// a built DB. The build script (scripts/build_kimball_db.ts) consumes these.

export interface ParsedSection { heading: string; heading_path: string; level: number; content: string; }

export function parseSummary(md: string): { title: string; sections: ParsedSection[] } {
  const lines = md.split('\n');
  let title = '';
  const sections: ParsedSection[] = [];
  let lastH2 = '';
  let cur: ParsedSection | null = null;
  const flush = () => {
    if (cur) {
      cur.content = cur.content.trim();
      if (cur.content.length > 0 || cur.heading.length > 0) sections.push(cur);
    }
  };
  for (const line of lines) {
    const h1 = line.match(/^# +(.*)/);
    const h2 = line.match(/^## +(.*)/);
    const h3 = line.match(/^### +(.*)/);
    if (h1) { title = h1[1]!.trim(); continue; }
    if (h2) {
      flush();
      lastH2 = h2[1]!.trim();
      cur = { heading: lastH2, heading_path: lastH2, level: 2, content: '' };
      continue;
    }
    if (h3) {
      flush();
      const h = h3[1]!.trim();
      cur = { heading: h, heading_path: lastH2 ? `${lastH2} > ${h}` : h, level: 3, content: '' };
      continue;
    }
    if (cur) cur.content += line + '\n';
  }
  flush();
  return { title, sections };
}

export interface ParsedConcept {
  display_name: string;
  definition: string | null;
  cross_reference: string | null;
  refs: { chapter_num: number; section_hint: string | null; is_defining: boolean }[];
}

// Parses a single INDEX.md concept line. Returns null if the line doesn't match.
// Examples handled:
//   - **Accumulating snapshot fact table** — one row per pipeline... **Ch 2**, **Ch 4** (Inventory ..), Ch 5 (procurement)
//   - **Aliasing / role-playing views** — see Role-playing dimension
//   - **AND/OR query dilemma** — bridge queries... Ch 9 (Skill Keyword Bridge)
export function parseConceptLine(line: string): ParsedConcept | null {
  const m = line.match(/^- \*\*([^*]+)\*\*(?:\s+—\s+(.+))?$/);
  if (!m) return null;
  const display_name = m[1]!.trim();
  const rest = (m[2] ?? '').trim();

  // "see X" cross-reference: no chapter refs, just a pointer to another concept.
  const seeMatch = rest.match(/^see\s+(.+?)\.?$/i);
  if (seeMatch) {
    return { display_name, definition: null, cross_reference: seeMatch[1]!.trim(), refs: [] };
  }

  // Walk the rest looking for "**Ch N** (...)" or "Ch N (...)" patterns.
  const refPattern = /(\*\*Ch \d+\*\*|Ch \d+)\s*(\(([^)]+)\))?/g;
  const refs: ParsedConcept['refs'] = [];
  let firstRefIdx = -1;
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(rest)) !== null) {
    if (firstRefIdx === -1) firstRefIdx = match.index;
    const tok = match[1]!;
    const is_defining = tok.startsWith('**');
    const numMatch = tok.match(/(\d+)/);
    if (!numMatch) continue;
    refs.push({
      chapter_num: parseInt(numMatch[1]!, 10),
      section_hint: match[3] ?? null,
      is_defining,
    });
  }

  let definition: string | null;
  if (firstRefIdx > 0) {
    definition = rest.substring(0, firstRefIdx).replace(/[\s.,;]+$/, '').trim();
    if (definition.length === 0) definition = null;
  } else if (refs.length === 0) {
    definition = rest.length > 0 ? rest : null;
  } else {
    definition = null;
  }

  return { display_name, definition, cross_reference: null, refs };
}
