import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, mkdirSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { createHash } from 'crypto';

const PROJECT_DIR = resolve(process.env.DBT_PROJECT_DIR ?? process.cwd());
const DB_PATH = resolve(PROJECT_DIR, 'target/bk1_state.db');

interface ModelRow {
  unique_id: string;
  name: string;
  path: string;
  file_hash: string | null;
  lint_status: string;
  last_linted_at: string | null;
  violation_count: number;
  violations_json: string | null;
}

interface ManifestModelNode {
  resource_type: string;
  name: string;
  unique_id: string;
  original_file_path: string;
}

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.run(`
    CREATE TABLE IF NOT EXISTS models (
      unique_id        TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      path             TEXT NOT NULL,
      file_hash        TEXT,
      lint_status      TEXT NOT NULL DEFAULT 'pending',
      last_linted_at   TEXT,
      violation_count  INTEGER NOT NULL DEFAULT 0,
      violations_json  TEXT
    )
  `);
  _db.run(`
    CREATE TABLE IF NOT EXISTS file_content (
      path      TEXT PRIMARY KEY,
      content   TEXT NOT NULL,
      cached_at TEXT NOT NULL
    )
  `);
  // Migration: add sql_mtime column if not present
  try { _db.run(`ALTER TABLE models ADD COLUMN sql_mtime TEXT`); } catch {}
  return _db;
}

function readAndHash(filePath: string): { hash: string; content: string } {
  if (!existsSync(filePath)) return { hash: 'missing', content: '' };
  const content = readFileSync(filePath, 'utf-8');
  return { hash: createHash('sha256').update(content).digest('hex').slice(0, 16), content };
}

function getMtime(filePath: string): string {
  try { return String(statSync(filePath).mtimeMs); } catch { return 'missing'; }
}

function getProjectName(): string {
  const yml = resolve(PROJECT_DIR, 'dbt_project.yml');
  if (!existsSync(yml)) return basename(PROJECT_DIR);
  for (const line of readFileSync(yml, 'utf-8').split('\n')) {
    const m = line.match(/^name:\s*['"]?([^'"#\s]+)/);
    if (m) return m[1]!;
  }
  return basename(PROJECT_DIR);
}

interface SyncStats { total: number; added: number; changed: number; unchanged: number; pruned: number; }

// Incremental sync — stats all SQL files first (fast), only reads content for changed/new files.
async function incrementalSync(): Promise<SyncStats> {
  const manifestPath = resolve(PROJECT_DIR, 'target/manifest.json');
  if (!existsSync(manifestPath)) throw new Error('target/manifest.json not found. Run dbt compile or dbt parse first.');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { nodes: Record<string, ManifestModelNode> };
  const db = getDb();
  const models = Object.values(manifest.nodes).filter(n => n.resource_type === 'model');

  // Step 1: stat all SQL files (syscall only — no content read)
  const statted = models.map(m => ({
    model: m,
    sqlPath: resolve(PROJECT_DIR, m.original_file_path),
    mtime: getMtime(resolve(PROJECT_DIR, m.original_file_path)),
  }));

  // Step 2: bulk fetch all stored rows in one query
  interface StoredRow { unique_id: string; file_hash: string; lint_status: string; sql_mtime: string | null; }
  const storedMap = new Map(
    (db.prepare<StoredRow, []>(`SELECT unique_id, file_hash, lint_status, sql_mtime FROM models`).all())
      .map(r => [r.unique_id, r]),
  );

  // Step 3: read + hash only changed / new files
  type ReadResult = { hash: string; sqlContent: string; yamlContent: string; yamlRelPath: string };
  const reads = new Map<string, ReadResult>();
  for (const s of statted) {
    const existing = storedMap.get(s.model.unique_id);
    if (existing && existing.sql_mtime === s.mtime) continue; // unchanged — skip disk read
    const { hash, content: sqlContent } = readAndHash(s.sqlPath);
    const yamlRelPath = s.model.original_file_path.replace(/\.sql$/, '.yml');
    const { content: yamlContent } = readAndHash(resolve(PROJECT_DIR, yamlRelPath));
    reads.set(s.model.unique_id, { hash, sqlContent, yamlContent, yamlRelPath });
  }

  // Step 4: write everything in one transaction
  const insert       = db.prepare(`INSERT INTO models (unique_id, name, path, file_hash, sql_mtime, lint_status) VALUES (?, ?, ?, ?, ?, 'pending')`);
  const recheck      = db.prepare(`UPDATE models SET file_hash = ?, sql_mtime = ?, lint_status = 'needs_recheck', last_linted_at = NULL WHERE unique_id = ?`);
  const updateMtime  = db.prepare(`UPDATE models SET sql_mtime = ? WHERE unique_id = ?`);
  const upsertContent = db.prepare(`INSERT OR REPLACE INTO file_content (path, content, cached_at) VALUES (?, ?, ?)`);

  let added = 0, changed = 0, unchanged = 0;
  const now = new Date().toISOString();

  db.run('BEGIN');
  try {
    for (const s of statted) {
      const existing = storedMap.get(s.model.unique_id);
      const r = reads.get(s.model.unique_id);

      if (!r) {
        // mtime unchanged — no content update needed; backfill mtime if it was null
        if (existing && existing.sql_mtime === null) updateMtime.run(s.mtime, s.model.unique_id);
        unchanged++;
        continue;
      }

      if (!existing) {
        insert.run(s.model.unique_id, s.model.name, s.model.original_file_path, r.hash, s.mtime);
        added++;
      } else if (existing.file_hash !== r.hash) {
        recheck.run(r.hash, s.mtime, s.model.unique_id);
        changed++;
      } else {
        updateMtime.run(s.mtime, s.model.unique_id);
        unchanged++;
      }

      if (r.sqlContent) upsertContent.run(s.model.original_file_path, r.sqlContent, now);
      if (r.yamlContent) upsertContent.run(r.yamlRelPath, r.yamlContent, now);
    }

    // Prune deleted models
    const currentIds = new Set(models.map(m => m.unique_id));
    let pruned = 0;
    const pruneStmt = db.prepare(`DELETE FROM models WHERE unique_id = ?`);
    for (const row of db.prepare<{ unique_id: string }, []>(`SELECT unique_id FROM models`).all()) {
      if (!currentIds.has(row.unique_id)) { pruneStmt.run(row.unique_id); pruned++; }
    }

    db.run('COMMIT');
    return { total: models.length, added, changed, unchanged, pruned };
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// Public sync — kept for standalone use via model_state action="sync".
export async function syncManifestState(): Promise<string> {
  try {
    const s = await incrementalSync();
    return JSON.stringify(s);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

export interface LintViolation { code: string; rule: string; severity: string; file: string; evidence: string; fix: string; }
export interface LintOutput {
  project_name: string;
  summary: { total: number; by_severity: Record<string, number>; by_rule: Record<string, number> };
  violations: LintViolation[];
  semantic_review_queue: string[];
}

export interface RuleAggregate { code: string; severity: string; count: number; }
export interface AggregatedViolations {
  batchViolations: LintViolation[];
  batchByRule: RuleAggregate[];
  projectByRule: RuleAggregate[];
  semanticQueue: string[];
}

// Exported field list — read by the contract test in tests/skill-contract.test.ts
// to ensure skills.ts only references fields that actually exist on the response.
export const LINT_RESPONSE_VIOLATIONS_FIELDS = [
  'total',
  'project_total',
  'batch_by_rule',
  'project_by_rule',
  'details',
] as const;

// Pure aggregation — extracted from lintRun so it can be unit-tested without spawning the binary.
export function aggregateViolations(
  output: LintOutput,
  batchFileSet: Set<string>,
): AggregatedViolations {
  const sevOrder = (s: string) => s === 'blocker' ? 0 : s === 'major' ? 1 : 2;
  const tally = (vs: LintViolation[]): RuleAggregate[] => {
    const map = new Map<string, RuleAggregate>();
    for (const v of vs) {
      const e = map.get(v.code);
      if (e) e.count++; else map.set(v.code, { code: v.code, severity: v.severity, count: 1 });
    }
    return [...map.values()].sort(
      (a, b) => sevOrder(a.severity) - sevOrder(b.severity) || b.count - a.count,
    );
  };

  const batchViolations = output.violations.filter(v => batchFileSet.has(v.file));
  return {
    batchViolations,
    batchByRule:   tally(batchViolations),
    projectByRule: tally(output.violations),
    semanticQueue: output.semantic_review_queue.filter(p => batchFileSet.has(p)),
  };
}

// Single-call replacement for Steps 2-4 in /lint: sync + queue + run binary + filter violations.
// Eliminates ~4 LLM API round-trips on every lint run.
export async function lintRun(binaryPath: string, force: boolean): Promise<string> {
  // 1. Incremental sync
  let sync: SyncStats;
  try { sync = await incrementalSync(); }
  catch (err) { return JSON.stringify({ error: String(err) }); }

  // 2. Get queue — includes 'violations' so previously-flagged models keep getting checked
  //    until they're explicitly marked clean. Without this, a model that fails lint once is
  //    stuck out of the batch (and out of semantic checks) until /lint --full.
  const db = getDb();
  const totalPending = (db.prepare<{ count: number }, []>(
    `SELECT COUNT(*) as count FROM models WHERE lint_status IN ('pending', 'needs_recheck', 'violations')`,
  ).get()!).count;

  if (totalPending === 0) {
    return JSON.stringify({ nothing_to_lint: true, sync });
  }

  const batchRows = db.prepare<{ name: string; path: string }, [number]>(
    `SELECT name, path FROM models WHERE lint_status IN ('pending', 'needs_recheck', 'violations') ORDER BY lint_status DESC, name LIMIT ?`,
  ).all(100);
  const remaining = totalPending - batchRows.length;

  const batchFileSet = new Set<string>();
  for (const row of batchRows) {
    batchFileSet.add(row.path);
    batchFileSet.add(row.path.replace(/\.sql$/, '.yml'));
  }

  // 3. Run binary (with Python fallback)
  const pythonPath = binaryPath.replace(/bk1-lint$/, 'dbt_lint.py');
  let ran = false;
  for (const cmd of [
    existsSync(binaryPath) ? (force ? [binaryPath, '.', '--no-cache'] : [binaryPath, '.']) : null,
    existsSync(pythonPath) ? (force ? ['python', pythonPath, '.', '--no-cache'] : ['python', pythonPath, '.']) : null,
  ]) {
    if (!cmd) continue;
    const proc = Bun.spawn(cmd, { cwd: PROJECT_DIR, stdout: 'pipe', stderr: 'pipe' });
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    ran = true;
    break;
  }

  if (!ran) {
    return JSON.stringify({
      error: 'binary_not_found',
      message: `bk1-lint not found at ${binaryPath}. Run: cd lint && cargo build --release && cp target/release/bk1-lint ${dirname(binaryPath)}/`,
      sync,
      batch: { size: batchRows.length, remaining, queue: batchRows.map(r => r.name) },
    });
  }

  // 4. Read, filter, and aggregate violations.json
  const projectName = getProjectName();
  const violationsPath = resolve(dirname(binaryPath), 'data', projectName, 'violations.json');
  if (!existsSync(violationsPath)) {
    return JSON.stringify({ error: 'violations_not_found', path: violationsPath, sync });
  }

  const output = JSON.parse(readFileSync(violationsPath, 'utf-8')) as LintOutput;
  const agg = aggregateViolations(output, batchFileSet);

  return JSON.stringify({
    project_name: projectName,
    sync,
    batch: { size: batchRows.length, remaining, queue: batchRows.map(r => r.name) },
    violations: {
      total:           agg.batchViolations.length,
      project_total:   output.violations.length,
      batch_by_rule:   agg.batchByRule,
      project_by_rule: agg.projectByRule,
      details:         agg.batchViolations,
    },
    semantic_review_queue: agg.semanticQueue,
  });
}

// Returns a batch of models that need linting. limit controls batch size (default 100).
// Returns the batch plus a remaining count so the caller knows if more passes are needed.
export function getLintQueue(limit = 100): string {
  const db = getDb();

  const totalRow = db.prepare<{ count: number }, []>(
    `SELECT COUNT(*) as count FROM models WHERE lint_status IN ('pending', 'needs_recheck', 'violations')`,
  ).get()!;

  const rows = db.prepare<Pick<ModelRow, 'name' | 'path' | 'lint_status'>, [number]>(
    `SELECT name, path, lint_status FROM models
     WHERE lint_status IN ('pending', 'needs_recheck', 'violations')
     ORDER BY lint_status DESC, name
     LIMIT ?`,
  ).all(limit);

  const remaining = totalRow.count - rows.length;

  return JSON.stringify({
    batch: rows.length,
    total_pending: totalRow.count,
    remaining_after_batch: remaining,
    queue: rows,
  });
}

// Returns a status summary. Full per-model rows only for violations — avoids
// dumping thousands of clean-model rows into the agent's context.
export function getModelStatus(): string {
  const db = getDb();
  const summary = db.prepare(
    `SELECT lint_status, COUNT(*) as count FROM models GROUP BY lint_status ORDER BY lint_status`,
  ).all();
  const violations = db.prepare(
    `SELECT name, path, violation_count, last_linted_at FROM models
     WHERE lint_status = 'violations'
     ORDER BY violation_count DESC`,
  ).all();
  return JSON.stringify({ summary, models_with_violations: violations });
}

// Projection types — slim views of file content so semantic sub-agents only see
// what their rule needs. Cuts token usage by 60-90% per rule vs. raw content.
export type Projection =
  | 'descriptions'        // YAML: model + column descriptions only (rule A)
  | 'columns'             // YAML: column name + data_type in declared order (rule B)
  | 'identifiers'         // YAML: model name + column names only (rule D)
  | 'model_description'   // YAML: top-level model description only (rule E)
  | 'sql_compact';        // SQL: comments and blank lines stripped (rule C)

interface ColumnInfo { name: string; description?: string; data_type?: string; }
interface ModelInfo  { name: string; description?: string; columns: ColumnInfo[]; }

// Line-based parser for dbt schema YAML files. Handles the constrained shape
// dbt projects actually use — top-level `models:` list, each entry with `name`,
// optional `description` (inline, single-line, or | / > block scalar), and
// optional `columns:` list with name/description/data_type. Mirrors the regex
// approach used by lint/src/checks.rs::yaml_docs.
//
// Only entries under the `models:` top-level key are returned; entries under
// `sources:`, `seeds:`, etc. are ignored.
export function parseDbtSchemaYaml(text: string): ModelInfo[] {
  const lines = text.split('\n');
  const models: ModelInfo[] = [];
  let curModel: ModelInfo | null = null;
  let curColumn: ColumnInfo | null = null;
  let inModelsList = false;
  let inColumns = false;
  let modelIndent = -1;
  let columnIndent = -1;

  // Active block scalar: lines indented strictly deeper than keyIndent are appended.
  let block: { target: 'model_desc' | 'col_desc'; keyIndent: number; lines: string[] } | null = null;

  const indentOf = (s: string): number => {
    const m = s.match(/^( *)/);
    return m ? m[1]!.length : 0;
  };

  const flushBlock = () => {
    if (!block) return;
    const joined = block.lines.join(' ').trim().replace(/\s+/g, ' ');
    if (block.target === 'model_desc' && curModel) curModel.description = joined;
    if (block.target === 'col_desc' && curColumn) curColumn.description = joined;
    block = null;
  };

  const stripQuotes = (s: string) => s.trim().replace(/^["'](.*)["']$/, '$1').trim();
  const topKeyRe = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/;

  for (const raw of lines) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
      if (block) block.lines.push('');
      continue;
    }
    const ind = indentOf(raw);
    const body = raw.slice(ind);

    // Continue or close an active block scalar
    if (block) {
      if (ind > block.keyIndent) { block.lines.push(body); continue; }
      flushBlock();
    }

    // Top-level key — toggles whether we're inside the models: list.
    // Any non-models top-level key (version, sources, seeds, ...) closes the section.
    if (ind === 0 && topKeyRe.test(body)) {
      const m = topKeyRe.exec(body)!;
      inModelsList = m[1] === 'models';
      curModel = null;
      curColumn = null;
      inColumns = false;
      modelIndent = -1;
      columnIndent = -1;
      continue;
    }

    if (!inModelsList) continue;

    // Detect a new model entry — "- name: X" at the established model indent,
    // or the first list-entry we encounter under models:. This also closes any
    // open columns block from the previous model.
    const isListEntry = /^- name:\s+(\S+)/.exec(body);
    if (isListEntry && (modelIndent === -1 || ind === modelIndent)) {
      curModel = { name: isListEntry[1]!, columns: [] };
      curColumn = null;
      inColumns = false;
      modelIndent = ind;
      models.push(curModel);
      continue;
    }

    // Column entry — only valid when we're inside a model's columns: block.
    if (isListEntry && inColumns && curModel && ind >= columnIndent) {
      curColumn = { name: isListEntry[1]! };
      curModel.columns.push(curColumn);
      continue;
    }

    if (!curModel) continue;

    // columns: marker — opens the columns list for the current model.
    if (/^columns:\s*$/.test(body)) {
      inColumns = true;
      columnIndent = ind + 2;
      curColumn = null;
      continue;
    }

    // description: handling — inline scalar OR block scalar opener.
    // Binds to the current column if one is open, otherwise to the model.
    const descMatch = /^description:\s*(.*)$/.exec(body);
    if (descMatch) {
      const val = descMatch[1]!.trim();
      const target = curColumn ? 'col_desc' : 'model_desc';
      if (val === '|' || val === '>' || val === '|-' || val === '>-') {
        block = { target, keyIndent: ind, lines: [] };
      } else if (val.length > 0) {
        const text = stripQuotes(val);
        if (curColumn) curColumn.description = text;
        else curModel.description = text;
      }
      continue;
    }

    // data_type: <value>
    const dtMatch = /^data_type:\s*(.*)$/.exec(body);
    if (dtMatch && curColumn) {
      curColumn.data_type = stripQuotes(dtMatch[1]!);
      continue;
    }
  }

  flushBlock();
  return models;
}

// Strips line comments, block comments, and blank lines from SQL. Keeps every
// other token so rule C can still spot JOIN/GROUP BY/window funcs/CASE.
function compactSql(text: string): string {
  // Remove /* ... */ block comments (non-greedy, multi-line)
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out
    .split('\n')
    .map(l => {
      // Strip -- line comments (naive — does not honor strings, fine for dbt SQL shape)
      const i = l.indexOf('--');
      return (i === -1 ? l : l.slice(0, i)).trimEnd();
    })
    .filter(l => l.trim().length > 0)
    .join('\n');
  return out;
}

function renderModels(models: ModelInfo[], projection: Projection): string {
  const out: string[] = [];
  for (const m of models) {
    if (projection === 'identifiers') {
      out.push(`model: ${m.name}`);
      if (m.columns.length) out.push(`columns: ${m.columns.map(c => c.name).join(', ')}`);
    } else if (projection === 'columns') {
      out.push(`model: ${m.name}`);
      out.push('columns:');
      for (const c of m.columns) out.push(`  - ${c.name}${c.data_type ? ` (${c.data_type})` : ''}`);
    } else if (projection === 'model_description') {
      out.push(`model: ${m.name}`);
      out.push(`description: ${m.description ?? '<missing>'}`);
    } else if (projection === 'descriptions') {
      out.push(`model: ${m.name}`);
      out.push(`description: ${m.description ?? '<missing>'}`);
      if (m.columns.length) {
        out.push('columns:');
        for (const c of m.columns) {
          out.push(`  - ${c.name}: ${c.description ?? '<missing>'}`);
        }
      }
    }
  }
  return out.join('\n');
}

// Applies a projection to a single file's content. Returns null when the
// projection does not apply to this file type (caller decides whether to skip
// the file or fall back to raw content).
export function projectContent(path: string, content: string, projection: Projection): string | null {
  const isYaml = path.endsWith('.yml') || path.endsWith('.yaml');
  const isSql  = path.endsWith('.sql');

  if (projection === 'sql_compact') return isSql ? compactSql(content) : null;
  if (!isYaml) return null;

  const models = parseDbtSchemaYaml(content);
  if (models.length === 0) return '';
  return renderModels(models, projection);
}

// Returns cached file contents for a list of paths. Falls back to disk for uncached paths.
// Hard cap at 150 paths to prevent context-window overflow in sub-agents.
// projection (optional): return a slim per-rule view instead of raw content. Files where
// the projection does not apply (e.g. .sql with a YAML projection) are silently skipped —
// callers should only pass paths relevant to the projection.
export function fetchContent(paths: string[], projection?: Projection): string {
  if (paths.length === 0) return 'No paths specified.';
  if (paths.length > 150) return `Error: fetch_content called with ${paths.length} paths — cap is 150. Split into smaller batches.`;
  const db = getDb();
  const stmt = db.prepare<{ content: string }, [string]>(
    `SELECT content FROM file_content WHERE path = ?`,
  );
  const lines: string[] = [];
  for (const p of paths) {
    const row = stmt.get(p);
    const content = row?.content ?? (() => {
      const full = resolve(PROJECT_DIR, p);
      return existsSync(full) ? readFileSync(full, 'utf-8') : null;
    })();
    if (!content) continue;
    const body = projection ? projectContent(p, content, projection) : content;
    if (body === null) continue;
    lines.push(`=== ${p} ===\n${body}`);
  }
  return lines.length > 0 ? lines.join('\n\n') : 'No content found for the specified paths.';
}

// Marks all models as needs_recheck — used by /lint --full to force a complete re-scan.
export function resetModelState(): string {
  const db = getDb();
  const result = db.run(
    `UPDATE models SET lint_status = 'needs_recheck', last_linted_at = NULL`,
  );
  return JSON.stringify({ reset: result.changes });
}

// Records the lint result for a single model after checking.
export function markModelLinted(
  name: string,
  lintStatus: 'clean' | 'violations',
  violationCount: number,
  violationsJson: string,
): string {
  const db = getDb();
  const result = db.run(
    `UPDATE models
     SET lint_status = ?, violation_count = ?, violations_json = ?, last_linted_at = ?
     WHERE name = ?`,
    [lintStatus, violationCount, violationsJson, new Date().toISOString(), name],
  );
  if (result.changes === 0) return `Model "${name}" not found in state.`;
  return `${name} → ${lintStatus} (${violationCount} violation${violationCount === 1 ? '' : 's'}).`;
}
