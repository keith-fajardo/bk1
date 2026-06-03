import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { createHash } from 'crypto';
import { emitCoinEvent, COIN_REWARDS, COIN_PENALTIES } from './coin-events';
import { getProjectDir } from './project-dir';

// Per-project paths are derived from the LIVE project dir (getProjectDir) so a
// mid-session /project switch re-points them. The state DB connection is a
// singleton (see getDb / resetDb) — resetDb must be called on a switch so the
// next getDb() opens the new project's DB.
const dbPath = () => resolve(getProjectDir(), 'target/bk1_state.db');
// Lint HTML report — written on every lint_run so the user has a clickable artifact
// of the latest violations, and so /lint-deep can skip its expensive semantic pass
// when a recent report already exists (the app prompts the user before overwriting).
export const lintReportPath = () => resolve(getProjectDir(), '.bk1', 'lint-report.html');

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

// Close and forget the current project's DB connection. Called on a /project
// switch so the next getDb() opens the new project's target/bk1_state.db.
// Closing matters: an open bun:sqlite handle holds the file, and a stale
// connection would otherwise keep serving the old project's model/lint rows.
export function resetDb(): void {
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

function getDb(): Database {
  if (_db) return _db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
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
  // Migration: add prev_lint_status — preserves the LAST KNOWN TERMINAL status
  // ('clean' or 'violations') across a recheck transition, so markModelLinted
  // can detect regressions and fixes. NULL means "never linted to a terminal
  // state" → first lint, grandfathered (no penalty even if violations).
  try { _db.run(`ALTER TABLE models ADD COLUMN prev_lint_status TEXT`); } catch {}
  // Migration: add pending_column_changes — JSON {added,removed,redefined} recorded by
  // write_file the moment a model's output columns change, drained by run_dbt_command
  // after the next compile/build to run the accurate downstream column taint. NULL = none
  // pending. incrementalSync never touches this column, so it survives a sync untouched.
  try { _db.run(`ALTER TABLE models ADD COLUMN pending_column_changes TEXT`); } catch {}
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
  const yml = resolve(getProjectDir(), 'dbt_project.yml');
  if (!existsSync(yml)) return basename(getProjectDir());
  for (const line of readFileSync(yml, 'utf-8').split('\n')) {
    const m = line.match(/^name:\s*['"]?([^'"#\s]+)/);
    if (m) return m[1]!;
  }
  return basename(getProjectDir());
}

interface SyncStats { total: number; added: number; changed: number; unchanged: number; pruned: number; }

// Incremental sync — stats all SQL files first (fast), only reads content for changed/new files.
async function incrementalSync(): Promise<SyncStats> {
  const manifestPath = resolve(getProjectDir(), 'target/manifest.json');
  if (!existsSync(manifestPath)) throw new Error('target/manifest.json not found. Run dbt compile or dbt parse first.');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { nodes: Record<string, ManifestModelNode> };
  const db = getDb();
  const models = Object.values(manifest.nodes).filter(n => n.resource_type === 'model');

  // Step 1: stat all SQL files (syscall only — no content read)
  const statted = models.map(m => ({
    model: m,
    sqlPath: resolve(getProjectDir(), m.original_file_path),
    mtime: getMtime(resolve(getProjectDir(), m.original_file_path)),
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
    const { content: yamlContent } = readAndHash(resolve(getProjectDir(), yamlRelPath));
    reads.set(s.model.unique_id, { hash, sqlContent, yamlContent, yamlRelPath });
  }

  // Step 4: write everything in one transaction
  const insert       = db.prepare(`INSERT INTO models (unique_id, name, path, file_hash, sql_mtime, lint_status) VALUES (?, ?, ?, ?, ?, 'pending')`);
  // Recheck preserves the prior TERMINAL status into prev_lint_status before
  // overwriting lint_status with 'needs_recheck'. Only 'clean' / 'violations'
  // get preserved; 'pending' or 'needs_recheck' would be meaningless to keep.
  // The COALESCE keeps a previously preserved value if we recheck twice in a
  // row without an intervening markModelLinted call.
  const recheck      = db.prepare(`UPDATE models
     SET file_hash = ?, sql_mtime = ?,
         prev_lint_status = CASE WHEN lint_status IN ('clean','violations') THEN lint_status ELSE prev_lint_status END,
         lint_status = 'needs_recheck',
         last_linted_at = NULL
     WHERE unique_id = ?`);
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

export interface LintViolation { code: string; rule: string; severity: string; file: string; evidence: string; suggested_fix: string; }
export interface LintOutput {
  project_name: string;
  summary: { total: number; by_severity: Record<string, number>; by_rule: Record<string, number> };
  violations: LintViolation[];
  semantic_review_queue: string[];
}

export interface RuleAggregate { code: string; rule: string; severity: string; count: number; }
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
      if (e) e.count++; else map.set(v.code, { code: v.code, rule: v.rule, severity: v.severity, count: 1 });
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

  // 3. Run binary (with Python fallback) — unless we can short-circuit from cache.
  //
  // Short-circuit: if !force AND incrementalSync reports no added/changed/pruned
  // models AND a prior violations.json exists on disk, skip the binary run. The
  // previous run's output is still accurate because no input files changed. This
  // is what makes /lint-deep cheap across sessions: a fresh bk1 session can't see
  // the prior lint_run via conversation history, so it always calls lint_run
  // again — without this short-circuit, that re-call would re-spawn the binary
  // (cheap but visible). With it, the re-call is a single JSON read.
  const projectName = getProjectName();
  const violationsPath = resolve(dirname(binaryPath), 'data', projectName, 'violations.json');
  const canUseCache = !force
    && sync.added === 0
    && sync.changed === 0
    && sync.pruned === 0
    && existsSync(violationsPath);

  if (!canUseCache) {
    const pythonPath = binaryPath.replace(/bk1-lint$/, 'dbt_lint.py');
    let ran = false;
    let exitCode = 0;
    let binStderr = '';
    for (const cmd of [
      existsSync(binaryPath) ? (force ? [binaryPath, '.', '--no-cache'] : [binaryPath, '.']) : null,
      existsSync(pythonPath) ? (force ? ['python', pythonPath, '.', '--no-cache'] : ['python', pythonPath, '.']) : null,
    ]) {
      if (!cmd) continue;
      const proc = Bun.spawn(cmd, { cwd: getProjectDir(), stdout: 'pipe', stderr: 'pipe' });
      const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      exitCode = await proc.exited;
      binStderr = stderr;
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

    // The binary crashed (e.g. a panic) — surface its stderr instead of letting
    // the downstream check report a generic 'violations_not_found' with no cause.
    if (exitCode !== 0) {
      return JSON.stringify({
        error: 'binary_failed',
        exit_code: exitCode,
        stderr: binStderr.trim().split('\n').slice(0, 20).join('\n'),
        sync,
      });
    }
  }

  // 4. Read, filter, and aggregate violations.json
  if (!existsSync(violationsPath)) {
    return JSON.stringify({ error: 'violations_not_found', path: violationsPath, sync });
  }

  const output = JSON.parse(readFileSync(violationsPath, 'utf-8')) as LintOutput;
  const agg = aggregateViolations(output, batchFileSet);

  writeLintReportHtml({
    projectName,
    projectTotal: output.violations.length,
    batchSize:    batchRows.length,
    rules:        agg.projectByRule,
    violations:   output.violations,
  });

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
    report_path:           lintReportPath(),
    cached:                canUseCache,
  });
}

// Write the clickable lint-report.html alongside the per-project state DB. Single
// self-contained HTML file with inline CSS — no external dependencies, opens cleanly
// in any browser or the IDE's file preview.
function writeLintReportHtml(input: {
  projectName: string;
  projectTotal: number;
  batchSize: number;
  rules: RuleAggregate[];
  violations: LintViolation[];
}): void {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const sevColor: Record<string, string> = {
    blocker: '#f87171',
    major:   '#fb923c',
    minor:   '#fcd34d',
  };
  const sevOrder = (s: string) => s === 'blocker' ? 0 : s === 'major' ? 1 : 2;

  const ruleRows = [...input.rules]
    .sort((a, b) => sevOrder(a.severity) - sevOrder(b.severity) || b.count - a.count)
    .map(r => `
      <tr>
        <td><span class="sev" style="background:${sevColor[r.severity] ?? '#7ab890'}">${esc(r.severity)}</span></td>
        <td><code>${esc(r.code)}</code></td>
        <td>${esc(r.rule)}</td>
        <td class="num">${r.count}</td>
      </tr>`).join('');

  const detailRows = input.violations.slice(0, 500).map(v => `
    <tr>
      <td><span class="sev" style="background:${sevColor[v.severity] ?? '#7ab890'}">${esc(v.severity)}</span></td>
      <td><code>${esc(v.code)}</code></td>
      <td class="file">${esc(v.file)}</td>
      <td>${esc(v.evidence)}</td>
      <td>${esc(v.suggested_fix)}</td>
    </tr>`).join('');
  const truncatedNote = input.violations.length > 500
    ? `<p class="note">Showing the first 500 of ${input.violations.length} violations. Run the binary directly for the full list.</p>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bk1 lint — ${esc(input.projectName)}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; background: #0c1413; color: #c0fad2; margin: 0; padding: 2rem 3rem; }
  h1 { font-size: 1.4rem; color: #b9fecf; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; color: #b9fecf; margin: 2rem 0 .5rem; border-bottom: 1px solid #2a3a36; padding-bottom: .25rem; }
  .meta { color: #7ab890; font-size: .85rem; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th { text-align: left; color: #7ab890; font-weight: 600; padding: .4rem .6rem; border-bottom: 1px solid #2a3a36; }
  td { padding: .35rem .6rem; border-bottom: 1px solid #1a2522; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.file { color: #67e8f9; font-family: ui-monospace, SF Mono, monospace; font-size: .85rem; white-space: nowrap; }
  code { font-family: ui-monospace, SF Mono, monospace; color: #c4b5fd; }
  .sev { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; font-weight: 600; color: #0c1413; text-transform: lowercase; }
  .note { color: #5a8060; font-size: .85rem; font-style: italic; }
</style>
</head>
<body>
  <h1>${esc(input.projectName)} — lint report</h1>
  <div class="meta">${input.projectTotal} violation${input.projectTotal === 1 ? '' : 's'} · ${input.batchSize} file${input.batchSize === 1 ? '' : 's'} queued · generated ${new Date().toISOString()}</div>

  <h2>Rules</h2>
  <table>
    <thead><tr><th>severity</th><th>rule</th><th>description</th><th class="num">count</th></tr></thead>
    <tbody>${ruleRows}</tbody>
  </table>

  <h2>Violations</h2>
  ${truncatedNote}
  <table>
    <thead><tr><th>severity</th><th>rule</th><th>file</th><th>evidence</th><th>fix</th></tr></thead>
    <tbody>${detailRows}</tbody>
  </table>
</body>
</html>`;

  mkdirSync(dirname(lintReportPath()), { recursive: true });
  writeFileSync(lintReportPath(), html, 'utf-8');
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
// approach used by sidecars/lint/src/checks.rs::yaml_docs.
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
      const full = resolve(getProjectDir(), p);
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

// Pure transition logic — exported so it can be unit-tested without spawning
// SQLite. Returns the coin event to emit (or null for "no event").
// Transition rules:
//   prev=NULL          → grandfathered (first lint), no event regardless of new
//   prev='violations'  + new='clean'      → fixed, +lintFix
//   prev='violations'  + new='violations' → already violating, no event
//   prev='clean'       + new='violations' → regression, -newViolation
//   prev='clean'       + new='clean'      → no change, no event
export function computeLintTransition(
  prev: string | null,
  next: 'clean' | 'violations',
  name: string,
): { type: 'lint_fix' | 'new_violation'; delta: number; reason: string } | null {
  if (prev === 'violations' && next === 'clean') {
    return { type: 'lint_fix', delta: COIN_REWARDS.lintFix, reason: `Fixed lint: ${name}` };
  }
  if (prev === 'clean' && next === 'violations') {
    return { type: 'new_violation', delta: COIN_PENALTIES.newViolation, reason: `New lint violation: ${name}` };
  }
  return null;
}

// Records the lint result for a single model after checking. Reads the last
// known TERMINAL status from prev_lint_status (set by incrementalSync on every
// recheck), computes the transition, updates the row, and emits a coin event
// if applicable.
export function markModelLinted(
  name: string,
  lintStatus: 'clean' | 'violations',
  violationCount: number,
  violationsJson: string,
): string {
  const db = getDb();
  // Read prior state BEFORE updating so we can compute the transition.
  const prior = db.prepare<{ prev_lint_status: string | null }, [string]>(
    `SELECT prev_lint_status FROM models WHERE name = ?`,
  ).get(name);
  const prev = prior?.prev_lint_status ?? null;

  // Update row: persist new terminal status both as current AND as the new
  // prev_lint_status so the next recheck has the correct baseline.
  const result = db.run(
    `UPDATE models
     SET lint_status = ?, violation_count = ?, violations_json = ?, last_linted_at = ?,
         prev_lint_status = ?
     WHERE name = ?`,
    [lintStatus, violationCount, violationsJson, new Date().toISOString(), lintStatus, name],
  );
  if (result.changes === 0) return `Model "${name}" not found in state.`;

  // Emit AFTER the DB write so any side-effect handler reads back fresh state.
  const event = computeLintTransition(prev, lintStatus, name);
  if (event) emitCoinEvent(event);

  return `${name} → ${lintStatus} (${violationCount} violation${violationCount === 1 ? '' : 's'}).`;
}

// Pending column-change tracking for impact-aware editing. write_file records the
// column-level diff the moment a model edit lands; run_dbt_command drains it after the
// next compile/build to run the accurate downstream taint against fresh compiled SQL.
// The JSON shape mirrors lineage's ColumnDiff ({added,removed,redefined}); kept as a plain
// record here so state.ts stays decoupled from the (pure) lineage module.
export interface PendingColumnChanges { added: string[]; removed: string[]; redefined: string[]; }

// Merges into any already-pending changes for the model, so two edits before one compile
// don't lose the first edit's removed/added columns.
export function recordColumnChanges(modelName: string, changes: PendingColumnChanges): void {
  if (!changes.added.length && !changes.removed.length && !changes.redefined.length) return;
  const db = getDb();
  const row = db.prepare<{ pending_column_changes: string | null }, [string]>(
    `SELECT pending_column_changes FROM models WHERE name = ?`,
  ).get(modelName);
  if (!row) return; // model not in state yet (new, pre-sync) — nothing to attach to

  const prior: PendingColumnChanges = row.pending_column_changes
    ? JSON.parse(row.pending_column_changes)
    : { added: [], removed: [], redefined: [] };
  const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
  const merged: PendingColumnChanges = {
    added: merge(prior.added, changes.added),
    removed: merge(prior.removed, changes.removed),
    redefined: merge(prior.redefined, changes.redefined),
  };
  db.run(`UPDATE models SET pending_column_changes = ? WHERE name = ?`, [JSON.stringify(merged), modelName]);
}

// Returns and clears pending changes for the given models (those a compile/build touched).
// Clearing is the point: once we've compiled, the taint we report is authoritative and the
// pending record has served its purpose.
export function drainColumnChanges(modelNames: string[]): Record<string, PendingColumnChanges> {
  if (modelNames.length === 0) return {};
  const db = getDb();
  const out: Record<string, PendingColumnChanges> = {};
  const sel = db.prepare<{ pending_column_changes: string | null }, [string]>(
    `SELECT pending_column_changes FROM models WHERE name = ?`,
  );
  const clear = db.prepare(`UPDATE models SET pending_column_changes = NULL WHERE name = ?`);
  for (const name of modelNames) {
    const row = sel.get(name);
    if (row?.pending_column_changes) {
      out[name] = JSON.parse(row.pending_column_changes);
      clear.run(name);
    }
  }
  return out;
}
