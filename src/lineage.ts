// Column-level lineage tracer.
//
// Parses compiled dbt SQL and answers: "which input columns does each output column derive from?"
// Used by /impact <model>.<column> to propagate taint through the descendant graph.
//
// v1 scope (intentional). Supported:
//   - Named columns in CTEs and the final SELECT (col, t.col, expr as col)
//   - Aliases through nested CTEs
//   - JOINs with explicit table qualification (o.col, not bare col)
//   - cast(...) and single-column functions (coalesce(col, literal), lower(col), etc.)
//   - UNION ALL where both sides name the same columns
//
// Not supported (returns unsupported reason per output column, falls back gracefully):
//   - SELECT * (no manifest column catalog to expand against in v1)
//   - Window functions, aggregations with GROUP BY
//   - CASE expressions over multiple source columns
//   - Correlated subqueries
//   - Unqualified column refs when multiple FROM tables exist (ambiguous)

import { Parser } from 'node-sql-parser';

export interface ColumnSource {
  table: string;
  column: string;
}

export interface ColumnLineage {
  // Output column name → resolved sources, or null if we couldn't trace it.
  columns: Record<string, ColumnSource[] | null>;
  // Per-column reason for null entries. Surfaces in the /impact report so users see why
  // a column couldn't be traced (e.g. "select * — column list not available").
  unsupported: Record<string, string>;
  // Top-level failure (parse error, multi-statement, etc). When set, `columns` is empty.
  fatal?: string;
}

const parser = new Parser();

// Most dbt warehouses parse cleanly under postgresql dialect; bigquery/snowflake have
// some dialect quirks but node-sql-parser handles the common 80%.
type Dialect = 'postgresql' | 'bigquery' | 'snowflake' | 'mysql' | 'sqlite';
const DIALECT_MAP: Record<string, Dialect> = {
  postgres: 'postgresql', postgresql: 'postgresql', redshift: 'postgresql',
  bigquery: 'bigquery', snowflake: 'snowflake', mysql: 'mysql',
  sqlite: 'sqlite', duckdb: 'postgresql',
};

export function pickDialect(warehouseType?: string | null): Dialect {
  if (!warehouseType) return 'postgresql';
  return DIALECT_MAP[warehouseType.toLowerCase()] ?? 'postgresql';
}

// AST node types — narrow what we need; everything else is `unknown` and the dispatcher
// returns "unsupported" for shapes we don't recognize.
interface ColumnRefAst {
  type: 'column_ref';
  table: string | null;
  column: { expr: { type: string; value: string } } | string;
}
interface SelectAst {
  type: 'select';
  with: CteAst[] | null;
  columns: SelectColumnAst[] | '*';
  from: FromAst[] | null;
  groupby?: unknown;
  _next?: SelectAst;
  set_op?: string;
}
interface CteAst {
  name: { value: string };
  stmt: SelectAst;
}
interface FromAst {
  db?: string | null;
  table?: string;
  as?: string | null;
  join?: string;
  expr?: SelectAst;
}
interface SelectColumnAst {
  type: 'expr';
  expr: ExprAst;
  as: string | null;
}
type ExprAst = ColumnRefAst | { type: string; [k: string]: unknown };

function colName(ref: ColumnRefAst): string {
  if (typeof ref.column === 'string') return ref.column;
  return ref.column.expr.value;
}

// Returns the AST shape that has CTEs + a final SELECT (handles statement arrays).
function pickStatement(ast: unknown): SelectAst | null {
  if (Array.isArray(ast)) {
    const last = ast[ast.length - 1];
    return pickStatement(last);
  }
  if (ast && typeof ast === 'object' && (ast as { type?: string }).type === 'select') {
    return ast as SelectAst;
  }
  return null;
}

function buildCteMap(withClause: CteAst[] | null): Record<string, SelectAst> {
  const m: Record<string, SelectAst> = {};
  for (const cte of withClause ?? []) m[cte.name.value] = cte.stmt;
  return m;
}

// Maps alias → resolved table reference (CTE name if it's a CTE, raw table name otherwise).
interface AliasEntry { name: string; isCte: boolean; }
function buildAliasMap(from: FromAst[] | null, ctes: Record<string, SelectAst>): Record<string, AliasEntry> {
  const m: Record<string, AliasEntry> = {};
  for (const f of from ?? []) {
    if (!f.table) continue;
    const alias = f.as ?? f.table;
    m[alias] = { name: f.table, isCte: f.table in ctes };
  }
  return m;
}

// Single-arg passthrough functions — applying them doesn't change column attribution.
// (Multi-arg functions like coalesce are handled by walking each argument.)
const PASSTHROUGH_FUNCS = new Set([
  'cast', 'coalesce', 'nullif', 'lower', 'upper', 'trim', 'ltrim', 'rtrim',
  'substring', 'substr', 'abs', 'round', 'ceil', 'floor', 'length', 'len',
  'to_char', 'to_date', 'to_timestamp', 'date_trunc', 'date_part', 'extract',
  'concat', 'replace', 'cast_as', 'try_cast',
]);

interface TraceContext {
  ctes: Record<string, SelectAst>;
  aliases: Record<string, AliasEntry>;
  // Guard against pathological deep CTE recursion (cycles shouldn't exist in dbt, but defense in depth).
  depth: number;
}

const MAX_DEPTH = 25;

// Resolves a column_ref to its ultimate sources, walking through any CTE the table alias points to.
// Returns null if we hit an unsupported pattern; the caller surfaces this per-output-column.
function resolveColumnRef(ref: ColumnRefAst, ctx: TraceContext): ColumnSource[] | null {
  if (ctx.depth > MAX_DEPTH) return null;

  const tableAlias = ref.table;
  const name = colName(ref);
  if (name === '*') return null;

  // Unqualified column: only safe when exactly one FROM source exists.
  let resolvedTable: AliasEntry | null = null;
  if (tableAlias) {
    resolvedTable = ctx.aliases[tableAlias] ?? null;
    if (!resolvedTable) {
      // Qualified reference to something not in the FROM clause — likely a correlated
      // subquery or a parsing quirk. Don't guess.
      return null;
    }
  } else {
    const sources = Object.values(ctx.aliases);
    if (sources.length === 1) resolvedTable = sources[0]!;
    else return null; // ambiguous in v1 (would need column catalog)
  }

  if (!resolvedTable.isCte) {
    // Terminal: a real table reference (dbt source or a ref()'d model after compilation).
    return [{ table: resolvedTable.name, column: name }];
  }

  // CTE: walk into its SELECT and find the column. Handles both named columns and the
  // common dbt `select * from <inner_cte>` pattern.
  const cteAst = ctx.ctes[resolvedTable.name];
  if (!cteAst) return null;
  const resolved = resolveCteColumn(cteAst, name, ctx.ctes, ctx.depth + 1);
  if (!resolved) return null;
  return traceExpr(resolved.expr, resolved.ctx);
}

// Walks a CTE's SELECT list to find the expression backing a given output column name.
// Handles the dbt-idiomatic `select * from <inner_cte>` by recursing through inner CTEs
// until it reaches a select list with explicit names, then synthesizing the column_ref.
function resolveCteColumn(
  cteAst: SelectAst,
  name: string,
  ctes: Record<string, SelectAst>,
  depth: number,
): { expr: ExprAst; ctx: TraceContext } | null {
  if (depth > MAX_DEPTH) return null;
  const cols = cteAst.columns;
  if (!Array.isArray(cols)) return null;

  const aliases = buildAliasMap(cteAst.from, ctes);
  const innerCtx: TraceContext = { ctes, aliases, depth };

  const isStarOnly = cols.length === 1
    && cols[0]!.expr.type === 'column_ref'
    && colName(cols[0]!.expr as ColumnRefAst) === '*'
    && cols[0]!.as === null;

  if (isStarOnly) {
    const fromList = cteAst.from ?? [];
    if (fromList.length !== 1) return null;
    const from = fromList[0]!;
    if (!from.table) return null;
    if (from.table in ctes) {
      // Star over another CTE — recurse.
      return resolveCteColumn(ctes[from.table]!, name, ctes, depth + 1);
    }
    // Star over a real table — synthesize a column_ref to that table.
    return {
      expr: {
        type: 'column_ref',
        table: from.as ?? from.table,
        column: { expr: { type: 'default', value: name } },
      } as ExprAst,
      ctx: innerCtx,
    };
  }

  for (const sel of cols) {
    const outName = sel.as ?? extractColumnName(sel.expr);
    if (outName === name) return { expr: sel.expr, ctx: innerCtx };
  }
  return null;
}

function extractColumnName(expr: ExprAst): string | null {
  if (expr.type === 'column_ref') return colName(expr as ColumnRefAst);
  return null;
}

function traceExpr(expr: ExprAst, ctx: TraceContext): ColumnSource[] | null {
  if (expr.type === 'column_ref') return resolveColumnRef(expr as ColumnRefAst, ctx);

  // cast(expr as type) — node-sql-parser uses type 'cast' with .expr.
  if (expr.type === 'cast' && expr['expr']) return traceExpr(expr['expr'] as ExprAst, ctx);

  // Function calls: trace each argument and union the sources. Only passthrough funcs;
  // unknown functions could change semantics (e.g. row_number) so we bail.
  if (expr.type === 'function' || expr.type === 'aggr_func') {
    const name = ((expr as { name?: { name?: { value?: string }[] } | string }).name ?? '');
    let fname: string | null = null;
    if (typeof name === 'string') fname = name.toLowerCase();
    else if (Array.isArray((name as { name?: unknown[] }).name)) {
      fname = ((name as { name: { value?: string }[] }).name[0]?.value ?? '').toLowerCase();
    }
    if (expr.type === 'aggr_func') return null; // sum/avg/count — v1 doesn't attribute these
    if (!fname || !PASSTHROUGH_FUNCS.has(fname)) return null;
    const args = (expr as { args?: { type?: string; value?: ExprAst[] } | { expr?: ExprAst } }).args;
    let argExprs: ExprAst[] = [];
    if (args && 'value' in args && Array.isArray(args.value)) argExprs = args.value as ExprAst[];
    else if (args && 'expr' in args && args.expr) argExprs = [args.expr as ExprAst];
    const sources: ColumnSource[] = [];
    for (const a of argExprs) {
      const sub = traceExpr(a, ctx);
      if (sub === null) continue; // skip literals / unsupported sub-exprs
      sources.push(...sub);
    }
    return sources.length > 0 ? dedupSources(sources) : null;
  }

  // Literals — no source contribution. Returning [] (not null) means "successfully traced,
  // no upstream columns" so the caller can distinguish from unsupported.
  if (['number', 'single_quote_string', 'null', 'bool', 'string'].includes(expr.type)) return [];

  // Everything else (binary_expr, case, window, subquery in select, etc.) — unsupported in v1.
  return null;
}

function dedupSources(sources: ColumnSource[]): ColumnSource[] {
  const seen = new Set<string>();
  const out: ColumnSource[] = [];
  for (const s of sources) {
    const k = `${s.table}.${s.column}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function classifyUnsupported(expr: ExprAst): string {
  if (expr.type === 'column_ref' && colName(expr as ColumnRefAst) === '*') return 'select * — column list not expanded in v1';
  if (expr.type === 'aggr_func') return 'aggregation — source attribution not derived in v1';
  if (expr.type === 'case') return 'case expression — multi-branch attribution not derived in v1';
  if (expr.type === 'window_func') return 'window function not supported in v1';
  if (expr.type === 'binary_expr') return 'expression over multiple columns not supported in v1';
  if (expr.type === 'function') return 'function not in v1 passthrough list';
  return `unsupported expression: ${expr.type}`;
}

export function traceColumns(compiledSql: string, dialect: Dialect = 'postgresql'): ColumnLineage {
  let ast: unknown;
  try {
    ast = parser.astify(compiledSql, { database: dialect });
  } catch (e) {
    return { columns: {}, unsupported: {}, fatal: `parse failed: ${(e as Error).message}` };
  }
  const stmt = pickStatement(ast);
  if (!stmt) return { columns: {}, unsupported: {}, fatal: 'no SELECT statement found' };

  // UNION ALL handling: when both branches name the same columns, attribute by name and
  // union the sources. Different shapes → fall through to single-side trace.
  const unionBranches: SelectAst[] = [];
  let cur: SelectAst | undefined = stmt;
  while (cur) {
    unionBranches.push(cur);
    if (cur.set_op && cur._next) cur = cur._next; else break;
  }

  if (unionBranches.length > 1) {
    // Only UNION ALL — UNION (dedupe) changes semantics but for lineage it's equivalent.
    const perBranchLineage = unionBranches.map(b => traceSingleSelect(b));
    return mergeUnion(perBranchLineage);
  }

  return traceSingleSelect(stmt);
}

function traceSingleSelect(stmt: SelectAst): ColumnLineage {
  const out: ColumnLineage = { columns: {}, unsupported: {} };
  const ctes = buildCteMap(stmt.with);

  // Expand the dbt-idiomatic `select * from final` pattern. When the top SELECT is a
  // single star over a single CTE, synthesize an explicit column list from the CTE's output.
  // Without this, the most common dbt model shape would always report fatal.
  const cols = stmt.columns;
  let effectiveCols: SelectColumnAst[];
  if (!Array.isArray(cols)) {
    out.fatal = 'unexpected columns shape';
    return out;
  }
  const isStarOnly = cols.length === 1
    && cols[0]!.expr.type === 'column_ref'
    && colName(cols[0]!.expr as ColumnRefAst) === '*'
    && cols[0]!.as === null;

  if (isStarOnly) {
    const fromList = stmt.from ?? [];
    if (fromList.length !== 1) {
      out.fatal = 'select * across multiple FROM sources — column list unavailable in v1';
      return out;
    }
    const from = fromList[0]!;
    if (!from.table || !(from.table in ctes)) {
      out.fatal = 'select * from non-CTE source — column list unavailable in v1';
      return out;
    }
    const cteAst = ctes[from.table]!;
    const names = expandableCteColumnNames(cteAst, ctes, 0);
    if (!names) {
      out.fatal = 'select * from CTE whose own column list could not be expanded';
      return out;
    }
    const cteAlias = from.as ?? from.table;
    effectiveCols = names.map(n => ({
      type: 'expr' as const,
      expr: {
        type: 'column_ref',
        table: cteAlias,
        column: { expr: { type: 'default', value: n } },
      } as ExprAst,
      as: null,
    }));
  } else {
    effectiveCols = cols;
  }

  const aliases = buildAliasMap(stmt.from, ctes);
  const ctx: TraceContext = { ctes, aliases, depth: 0 };

  for (const sel of effectiveCols) {
    const outName = sel.as ?? extractColumnName(sel.expr);
    if (!outName) continue; // unnameable expression; nothing for a downstream user to reference
    if (sel.expr.type === 'column_ref' && colName(sel.expr as ColumnRefAst) === '*') {
      out.columns[outName] = null;
      out.unsupported[outName] = 'select * — column list not expanded in v1';
      continue;
    }
    const sources = traceExpr(sel.expr, ctx);
    if (sources === null) {
      out.columns[outName] = null;
      out.unsupported[outName] = classifyUnsupported(sel.expr);
    } else {
      out.columns[outName] = sources;
    }
  }
  return out;
}

// Returns the explicit output column names of a SELECT, walking through any nested
// `select * from <cte>` indirections. Returns null if expansion is not possible.
function expandableCteColumnNames(
  stmt: SelectAst,
  ctes: Record<string, SelectAst>,
  depth: number,
): string[] | null {
  if (depth > MAX_DEPTH) return null;
  const cols = stmt.columns;
  if (!Array.isArray(cols)) return null;

  const isStarOnly = cols.length === 1
    && cols[0]!.expr.type === 'column_ref'
    && colName(cols[0]!.expr as ColumnRefAst) === '*'
    && cols[0]!.as === null;

  if (isStarOnly) {
    const fromList = stmt.from ?? [];
    if (fromList.length !== 1) return null;
    const from = fromList[0]!;
    if (!from.table || !(from.table in ctes)) return null;
    return expandableCteColumnNames(ctes[from.table]!, ctes, depth + 1);
  }

  const names: string[] = [];
  for (const c of cols) {
    if (c.expr.type === 'column_ref' && colName(c.expr as ColumnRefAst) === '*') return null;
    const n = c.as ?? extractColumnName(c.expr);
    if (!n) return null;
    names.push(n);
  }
  return names;
}

function mergeUnion(branches: ColumnLineage[]): ColumnLineage {
  // Use the first branch's column names as the canonical set; require every branch to
  // produce the same output names. If they diverge, fall back to "unsupported union".
  const first = branches[0]!;
  const merged: ColumnLineage = { columns: {}, unsupported: {} };
  const names = Object.keys(first.columns);
  for (const n of names) {
    let combined: ColumnSource[] = [];
    let unsupportedReason: string | null = null;
    for (const b of branches) {
      if (!(n in b.columns)) { unsupportedReason = 'union branches have differing columns'; break; }
      const s = b.columns[n];
      if (s === null) { unsupportedReason = b.unsupported[n] ?? 'untraced branch'; break; }
      combined.push(...s);
    }
    if (unsupportedReason) {
      merged.columns[n] = null;
      merged.unsupported[n] = unsupportedReason;
    } else {
      merged.columns[n] = dedupSources(combined);
    }
  }
  return merged;
}

// ─── Same-model column diff ──────────────────────────────────────────────────────
//
// "Which output columns changed between two versions of a model?" Used by write_file
// to detect, the instant an edit lands, whether a column was removed/renamed (the case
// that silently breaks downstream ref('model').col), added, or redefined to derive from
// different upstream columns. Runs on raw (uncompiled) SQL: added/removed are pure
// SELECT-list-name comparisons that don't need ref() resolution, so they're reliable
// pre-compile; redefined is only reported when BOTH sides trace cleanly (sources != null),
// otherwise the ambiguity is left for the post-compile cross-model trace to resolve.

export interface ColumnDiff {
  added: string[];
  removed: string[];
  // Columns present in both with a different resolved source set. Each entry names the
  // column; the accurate "what derives from it" answer comes from propagateColumnTaint
  // after compile.
  redefined: string[];
}

function sourceKey(sources: ColumnSource[]): string {
  return dedupSources(sources).map(s => `${s.table}.${s.column}`).sort().join('|');
}

export function diffColumns(oldSql: string, newSql: string, dialect: Dialect = 'postgresql'): ColumnDiff {
  const before = traceColumns(oldSql, dialect);
  const after = traceColumns(newSql, dialect);

  // If either side failed to parse at all, we can't say anything about column names safely.
  if (before.fatal || after.fatal) return { added: [], removed: [], redefined: [] };

  const beforeCols = new Set(Object.keys(before.columns));
  const afterCols = new Set(Object.keys(after.columns));

  const added = [...afterCols].filter(c => !beforeCols.has(c)).sort();
  const removed = [...beforeCols].filter(c => !afterCols.has(c)).sort();

  const redefined: string[] = [];
  for (const col of afterCols) {
    if (!beforeCols.has(col)) continue;
    const b = before.columns[col];
    const a = after.columns[col];
    // Only claim "redefined" when both sides traced to concrete sources and they differ.
    // null on either side = untraced; don't guess a change that might be a tracer gap.
    if (b === null || a === null) continue;
    if (sourceKey(b) !== sourceKey(a)) redefined.push(col);
  }
  redefined.sort();

  return { added, removed, redefined };
}

// ─── Cross-model taint propagation ─────────────────────────────────────────────────
//
// Given a target (model, column) and a topological order of downstream models with their
// compiled SQL, propagate which downstream columns are derived from the target.
// The graph caller is responsible for ordering (BFS from target; this function only
// needs to see ancestors before descendants).

export interface PropagationInput {
  targetModel: string;
  targetColumn: string;
  modelsInOrder: { name: string; compiledSql: string | null }[];
  dialect?: Dialect;
}
export interface PropagationOutput {
  taint: Record<string, string[]>;            // model → list of tainted output column names
  perModelStatus: Record<string, ModelTraceStatus>;
}
export interface ModelTraceStatus {
  status: 'traced' | 'sql_missing' | 'parse_failed' | 'partial';
  reason?: string;
  partialReasons?: Record<string, string>;    // per-column unsupported reasons (when status='partial')
}

export function propagateColumnTaint(input: PropagationInput): PropagationOutput {
  const dialect = input.dialect ?? 'postgresql';
  const taint: Record<string, string[]> = {
    [input.targetModel]: [input.targetColumn],
  };
  const status: Record<string, ModelTraceStatus> = {};

  for (const m of input.modelsInOrder) {
    if (!m.compiledSql) {
      status[m.name] = { status: 'sql_missing', reason: 'compiled SQL unavailable — run dbt compile' };
      continue;
    }
    const lineage = traceColumns(m.compiledSql, dialect);
    if (lineage.fatal) {
      status[m.name] = { status: 'parse_failed', reason: lineage.fatal };
      continue;
    }
    const tainted: string[] = [];
    for (const [outCol, sources] of Object.entries(lineage.columns)) {
      if (sources === null) continue;
      for (const src of sources) {
        const upstreamTaints = taint[src.table];
        if (upstreamTaints && upstreamTaints.includes(src.column)) {
          tainted.push(outCol);
          break;
        }
      }
    }
    if (tainted.length > 0) taint[m.name] = tainted;
    const hasUnsupported = Object.keys(lineage.unsupported).length > 0;
    status[m.name] = hasUnsupported
      ? { status: 'partial', partialReasons: lineage.unsupported }
      : { status: 'traced' };
  }

  return { taint, perModelStatus: status };
}
