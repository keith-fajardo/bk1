import type Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { syncManifestState, getLintQueue, getModelStatus, markModelLinted, fetchContent, resetModelState, lintRun, type Projection } from './state';
import { propagateColumnTaint, pickDialect, type ModelTraceStatus } from './lineage';
import { kimballQuery, type KimballQueryInput } from './kimball';
import { homedir } from 'os';

interface ManifestNode {
  resource_type: string;
  name: string;
  unique_id: string;
  original_file_path: string;
  schema: string;
  config?: { materialized?: string; schema?: string };
  tags?: string[];
}

interface ManifestSource {
  source_name: string;
  name: string;
  identifier?: string;
  schema: string;
  unique_id: string;
}

export const PROJECT_DIR = resolve(process.env.DBT_PROJECT_DIR ?? process.cwd());

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'run_dbt_command',
    description: 'Run a dbt CLI command in the project directory. Examples: "dbt compile --select stg_orders", "dbt test --select marts.fct_orders+".',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The full dbt command to run.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the dbt project. Use before editing to avoid overwriting content.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root, e.g. "models/staging/stg_orders.sql".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the project. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root.',
        },
        content: {
          type: 'string',
          description: 'Full file content to write.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files matching a glob pattern in the project. Useful for exploring model structure.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern relative to project root. Examples: "models/**/*.sql", "models/staging/*.yml".',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Run any shell command in the project directory. Use for grep, find, git log, etc. Do NOT use to read manifest.json — use query_manifest instead.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'query_run_results',
    description: 'Query target/run_results.json for failed/skipped models or a run summary. Filters server-side — use this instead of read_file on run_results.json (which can be 50K+ tokens on a clean run).',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          enum: ['summary', 'failures', 'skipped', 'model'],
          description: '"summary" = generated_at, elapsed_time, counts by status, and ids of any failures/skipped — call this first. "failures" = full diagnostic info (message, adapter_response, etc.) for error/fail rows only. "skipped" = unique_ids of skipped models. "model" = full result for one model (requires model param).',
        },
        model: {
          type: 'string',
          description: 'Model name for the "model" query, e.g. "stg_orders". Required when query is "model".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'query_manifest',
    description: 'Query target/manifest.json for model inventory, source definitions, lineage, single model profile, or full impact analysis. Always use this instead of read_file on manifest.json (which is megabytes).',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          enum: ['models', 'sources', 'lineage', 'model', 'refs', 'impact'],
          description: '"models" = all model names, paths, materialization, schema (5K+ tokens on large projects — avoid unless you genuinely need the inventory). "sources" = all source/table definitions with schema/identifier (large). "lineage" = parents and children for one model. "model" = one model\'s full profile (path, materialization, schema, parents, children) — use this for /explain, /docs, /refactor. "refs" = just model names + source/table tuples — the minimum needed for reference rewiring in /refactor; 5–10× smaller than "models" + "sources". "impact" = full descendant (or ancestor) subgraph from one model with depth, materialization, layer, and tests-at-risk per node — use this for /impact. Pass column= to additionally trace column-level lineage through descendants. Requires model param for "lineage", "model", and "impact".',
        },
        model: {
          type: 'string',
          description: 'Model name, e.g. "stg_orders". Required for "lineage", "model", and "impact" queries.',
        },
        direction: {
          type: 'string',
          enum: ['downstream', 'upstream', 'both'],
          description: 'Optional for "impact". Direction to walk the graph. Default "downstream" — what breaks if I change this model. "upstream" walks parents. "both" walks both directions.',
        },
        column: {
          type: 'string',
          description: 'Optional for "impact". Name of the source-model column whose downstream lineage to trace. When set, the response includes a column_taint map showing which descendant columns derive from this column. v1 lineage scope: named columns, CTE aliases, JOINs with explicit qualification, cast/coalesce/single-arg functions, UNION ALL. Unsupported patterns are surfaced per-model in the trace_status field.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'model_state',
    description: 'Persistent SQLite state that tracks lint status per model. Use before /lint to sync hashes and get the queue; use after checking each model to record results.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['sync', 'queue', 'status', 'mark_linted', 'fetch_content', 'reset', 'lint_run'],
          description: '"sync" = incremental sync (mtime-based). "queue" = batch of models needing lint. "status" = summary + violations. "mark_linted" = record result. "fetch_content" = return cached file contents. "reset" = force full re-lint. "lint_run" = sync + queue + run binary + filter violations in one call — use this instead of separate sync/queue/bash/read_file steps.',
        },
        batch_size:      { type: 'number', description: 'Max models to return for the queue action. Default 100. Keep ≤100 on large projects to stay within token budget.' },
        model_name:      { type: 'string', description: 'Model name. Required for mark_linted.' },
        lint_status:     { type: 'string', enum: ['clean', 'violations'], description: 'Lint result. Required for mark_linted.' },
        violation_count: { type: 'number', description: 'Number of violations found. Required for mark_linted.' },
        violations_json: { type: 'string', description: 'JSON array of violation objects. Required for mark_linted.' },
        paths:           { type: 'array', items: { type: 'string' }, description: 'File paths to retrieve content for. Required for fetch_content.' },
        projection:      {
          type: 'string',
          enum: ['descriptions', 'columns', 'identifiers', 'model_description', 'sql_compact'],
          description: 'Optional for fetch_content. Returns a slim per-rule view instead of raw content — cuts tokens 60-90%. "descriptions" = model + column descriptions (rule A). "columns" = column name + data_type in declared order (rule B). "identifiers" = model + column names (rule D). "model_description" = top-level model description only (rule E). "sql_compact" = SQL with comments and blank lines stripped (rule C). Files where the projection does not apply (e.g. .sql with a YAML projection) are silently skipped.',
        },
        binary_path:     { type: 'string', description: 'Full path to the bk1-lint binary. Required for lint_run.' },
        force:           { type: 'boolean', description: 'Pass --no-cache to the binary. Optional for lint_run.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'kimball_query',
    description: 'Query the bundled Kimball Data Warehouse Toolkit (3rd ed.) knowledge base. Use this for /kimball — it replaces bash grep/cat over INDEX.md and summary.md files with structured lookups (3-5× fewer tokens). Four modes: "concept" (lookup a Kimball term, returns definition + defining chapters + section hints), "search" (FTS5 over section content, returns ranked excerpts), "section" (retrieve a specific chapter section by chapter+heading), "chapter" (chapter table of contents, lightweight). The DB ships with bk1 — no external skill installation required.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['concept', 'search', 'section', 'chapter'],
          description: '"concept" = lookup a term (returns definition + defining chapters + section hints — like the old INDEX.md grep but structured). "search" = FTS5 over section content (returns ranked excerpts; ~1-2KB total). "section" = retrieve one chapter section by chapter+heading match (returns full content). "chapter" = chapter table of contents (just the heading list, no content — cheapest call).',
        },
        q: {
          type: 'string',
          description: 'Search term. Required for "concept" and "search" modes. Natural language is fine — the tokenizer handles stemming.',
        },
        chapter: {
          type: 'number',
          description: 'Chapter number (1-21). Required for "section" and "chapter" modes.',
        },
        section: {
          type: 'string',
          description: 'Optional for "section" mode. Substring match against heading or heading_path. Omit to return all sections in the chapter.',
        },
        limit: {
          type: 'number',
          description: 'Optional for "search" mode. Number of section hits to return. Default 5, max 15.',
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'agent',
    description: 'Spawn a focused sub-agent to handle a self-contained task. Use when you want to delegate work that can run in parallel — e.g. checking different semantic rules on different file sets. Multiple agent calls in one turn run concurrently. Returns the sub-agent\'s final text response.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Complete, self-contained task for the sub-agent. Include all context it needs — file paths, rule text, expected output format. The sub-agent has no memory of the current conversation.',
        },
        description: {
          type: 'string',
          description: 'Short label (≤40 chars) shown in the UI while this sub-agent runs, e.g. "Semantic: description quality".',
        },
      },
      required: ['prompt'],
    },
  },
];

function safeResolvePath(relativePath: string): string {
  const full = resolve(PROJECT_DIR, relativePath);
  if (!full.startsWith(PROJECT_DIR + '/') && full !== PROJECT_DIR) {
    throw new Error(`Path outside project directory: ${relativePath}`);
  }
  return full;
}

async function runDbtCommand(command: string): Promise<string> {
  const parts = command.trim().split(/\s+/);
  const proc = Bun.spawn(parts, {
    cwd: PROJECT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return (out + err).trim();
}

// Large-file guard: stops the agent from accidentally slurping multi-megabyte JSON
// (manifest.json, run_results.json, catalog.json) into the conversation, which used
// to be the single biggest cost spike. Each known-huge file is mapped to the right
// query tool the agent should call instead. Adjustable via BK1_READ_FILE_MAX_BYTES.
const READ_FILE_MAX_BYTES = Number(process.env.BK1_READ_FILE_MAX_BYTES ?? 100_000);
const HUGE_FILE_REDIRECTS: Record<string, string> = {
  'target/manifest.json':    'Use query_manifest (query="model" / "lineage" / "models" / "sources") instead.',
  'target/run_results.json': 'Use query_run_results (query="summary" / "failures" / "skipped" / "model") instead.',
  'target/catalog.json':     'Catalog is not exposed yet — grep for the specific table via bash if you need columns.',
};

function readFile(path: string): string {
  const full = safeResolvePath(path);
  if (!existsSync(full)) return `File not found: ${path}`;

  const redirect = HUGE_FILE_REDIRECTS[path];
  if (redirect) return `read_file refused: ${path} is a generated artifact. ${redirect}`;

  const size = statSync(full).size;
  if (size > READ_FILE_MAX_BYTES) {
    return `read_file refused: ${path} is ${size} bytes (cap ${READ_FILE_MAX_BYTES}). ` +
           `Use bash with sed/awk to extract the specific region you need, or raise BK1_READ_FILE_MAX_BYTES if intentional.`;
  }

  return readFileSync(full, 'utf-8');
}

function writeFile(path: string, content: string): string {
  const full = safeResolvePath(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return `Wrote ${path}`;
}

async function listFiles(pattern: string): Promise<string> {
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: PROJECT_DIR, onlyFiles: true })) {
    files.push(file);
    if (files.length >= 100) break;
  }
  if (files.length === 0) return 'No files found.';
  return files.sort().join('\n');
}

async function runBash(command: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', command], {
    cwd: PROJECT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const combined = (out + err).trim();
  return combined.length > 8000 ? combined.substring(0, 8000) + '\n...(truncated)' : combined;
}

// ─── query_run_results ──────────────────────────────────────────────────────
// dbt run_results.json status values:
//   run/build:  success, error, skipped, partial success
//   test:       pass, fail, error, warn, skipped
// "failures" treats error + fail; "skipped" treats skipped.

export interface RunResultEntry {
  status: string;
  unique_id: string;
  execution_time?: number;
  message?: string | null;
  failures?: number | null;
  adapter_response?: Record<string, unknown>;
  compiled?: boolean;
  compiled_code?: string;
  relation_name?: string | null;
}
export interface RunResults {
  metadata: { generated_at?: string; invocation_id?: string };
  results: RunResultEntry[];
  elapsed_time?: number;
}

const shortName = (uid: string) => uid.split('.').slice(-1)[0]!;
const isFailure = (s: string) => s === 'error' || s === 'fail';
const isSkipped = (s: string) => s === 'skipped';

// Pure transform — exported for unit testing without touching the filesystem.
export function queryRunResultsData(
  data: RunResults,
  query: string,
  model?: string,
): string {
  const generated_at = data.metadata?.generated_at ?? null;
  const elapsed_time = data.elapsed_time ?? null;
  const results = data.results ?? [];

  if (query === 'summary') {
    const counts: Record<string, number> = {};
    const failures: string[] = [];
    const skipped: string[] = [];
    for (const r of results) {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      if (isFailure(r.status)) failures.push(shortName(r.unique_id));
      if (isSkipped(r.status)) skipped.push(shortName(r.unique_id));
    }
    return JSON.stringify(
      { generated_at, elapsed_time, total: results.length, counts, failures, skipped },
      null, 2,
    );
  }

  if (query === 'failures') {
    const failed = results.filter(r => isFailure(r.status)).map(r => ({
      name: shortName(r.unique_id),
      unique_id: r.unique_id,
      status: r.status,
      message: r.message ?? null,
      failures: r.failures ?? null,
      execution_time: r.execution_time ?? null,
      adapter_response: r.adapter_response ?? null,
      relation_name: r.relation_name ?? null,
      compiled: r.compiled ?? false,
    }));
    return JSON.stringify({ generated_at, count: failed.length, failures: failed }, null, 2);
  }

  if (query === 'skipped') {
    const skips = results.filter(r => isSkipped(r.status)).map(r => ({
      name: shortName(r.unique_id),
      unique_id: r.unique_id,
    }));
    return JSON.stringify({ generated_at, count: skips.length, skipped: skips }, null, 2);
  }

  if (query === 'model') {
    if (!model) return 'Provide a model name for the "model" query.';
    const r = results.find(x => shortName(x.unique_id) === model);
    if (!r) return `Model "${model}" not found in run_results.`;
    return JSON.stringify(r, null, 2);
  }

  return `Unknown query type: ${query}`;
}

function queryRunResults(query: string, model?: string): string {
  const path = resolve(PROJECT_DIR, 'target/run_results.json');
  if (!existsSync(path)) {
    return 'target/run_results.json not found. Run dbt build, dbt test, or dbt run first.';
  }
  const data = JSON.parse(readFileSync(path, 'utf-8')) as RunResults;
  return queryRunResultsData(data, query, model);
}

export interface ManifestShape {
  nodes:      Record<string, ManifestNode>;
  sources:    Record<string, ManifestSource>;
  parent_map: Record<string, string[]>;
  child_map:  Record<string, string[]>;
}

// Pure transform — exported for unit testing without touching the filesystem.
export function queryManifestData(manifest: ManifestShape, query: string, model?: string): string {
  if (query === 'models') {
    const models = Object.values(manifest.nodes)
      .filter(n => n.resource_type === 'model')
      .map(n => ({
        name: n.name,
        path: n.original_file_path,
        materialized: n.config?.materialized,
        schema: n.config?.schema ?? n.schema,
        unique_id: n.unique_id,
        tags: n.tags ?? [],
      }));
    return JSON.stringify(models, null, 2);
  }

  if (query === 'sources') {
    const sources = Object.values(manifest.sources).map(s => ({
      source_name: s.source_name,
      name: s.name,
      identifier: s.identifier ?? s.name,
      schema: s.schema,
      unique_id: s.unique_id,
    }));
    return JSON.stringify(sources, null, 2);
  }

  // Names-only inventory: the minimum needed for reference rewiring in /refactor.
  // Roughly 5-10× smaller than "models" + "sources" combined, since it drops paths,
  // materialization, schema, tags, identifiers, and unique_ids.
  if (query === 'refs') {
    const models = Object.values(manifest.nodes)
      .filter(n => n.resource_type === 'model')
      .map(n => n.name)
      .sort();
    const sources = Object.values(manifest.sources)
      .map(s => ({ source: s.source_name, table: s.name }))
      .sort((a, b) =>
        a.source.localeCompare(b.source) || a.table.localeCompare(b.table),
      );
    return JSON.stringify({ models, sources }, null, 2);
  }

  // Shared by 'lineage' and 'model' — resolves unique_ids to readable labels and
  // drops resource types that are noise for lineage views (tests, seeds, analyses).
  // What we keep: model, source, snapshot. Test nodes alone can 5x the response size.
  const LINEAGE_KINDS = new Set(['model', 'source', 'snapshot']);
  const resolveId = (id: string): string | null => {
    const parts = id.split('.');
    if (!LINEAGE_KINDS.has(parts[0]!)) return null;
    if (parts[0] === 'model')    return parts.slice(2).join('.');
    if (parts[0] === 'source')   return `source:${parts.slice(2).join('.')}`;
    if (parts[0] === 'snapshot') return `snapshot:${parts.slice(2).join('.')}`;
    return id;
  };
  const lineageFor = (uid: string, side: 'parents' | 'children') => {
    const ids = (side === 'parents' ? manifest.parent_map[uid] : manifest.child_map[uid]) ?? [];
    return ids.map(resolveId).filter((x): x is string => x !== null);
  };

  const findModelUid = (name: string) => Object.keys(manifest.nodes).find(
    k => manifest.nodes[k]!.name === name && manifest.nodes[k]!.resource_type === 'model',
  );

  if (query === 'lineage') {
    if (!model) return 'Provide a model name for the lineage query.';
    const uid = findModelUid(model);
    if (!uid) return `Model "${model}" not found in manifest.`;
    return JSON.stringify({
      model,
      parents:  lineageFor(uid, 'parents'),
      children: lineageFor(uid, 'children'),
    }, null, 2);
  }

  // Single-model profile: everything /explain, /docs, /refactor need in one ~500-token response.
  // Replaces a list_files + dbt ls + read_file chain that used to fan out across many turns.
  if (query === 'model') {
    if (!model) return 'Provide a model name for the model query.';
    const uid = findModelUid(model);
    if (!uid) return `Model "${model}" not found in manifest.`;
    const node = manifest.nodes[uid]!;
    return JSON.stringify({
      name:         node.name,
      unique_id:    node.unique_id,
      path:         node.original_file_path,
      yaml_path:    node.original_file_path.replace(/\.sql$/, '.yml'),
      compiled_path: `target/compiled/${manifest.nodes[uid]!.unique_id.split('.')[1]}/${node.original_file_path}`,
      materialized: node.config?.materialized,
      schema:       node.config?.schema ?? node.schema,
      tags:         node.tags ?? [],
      parents:      lineageFor(uid, 'parents'),
      children:     lineageFor(uid, 'children'),
    }, null, 2);
  }

  return `Unknown query type: ${query}`;
}

// ─── Impact analysis ─────────────────────────────────────────────────────────────
//
// "If I change this model, what breaks?" — BFS over child_map (downstream) or
// parent_map (upstream) returning each affected node with its layer, depth,
// and the tests that exercise it. Column-level lineage is added optionally
// when the caller supplies compiled SQL per descendant.

export type ImpactDirection = 'downstream' | 'upstream' | 'both';

export interface ImpactNode {
  name: string;
  path: string;
  materialized: string | undefined;
  layer: string;          // staging | intermediate | marts | presentation | other
  depth: number;          // 1 = direct dependent
  tests: string[];        // test names that target this model
  compiled_path: string;  // for the caller to read if column-level lineage is requested
}

export interface ImpactResult {
  model: { name: string; path: string; materialized: string | undefined; layer: string; tests: string[] };
  direction: ImpactDirection;
  downstream?: ImpactNode[];
  upstream?: ImpactNode[];
  by_layer: Record<string, number>;
  max_depth: number;
  column?: {
    name: string;
    taint: Record<string, string[]>;             // model name → tainted column names
    trace_status: Record<string, ModelTraceStatus>; // per-descendant trace status
  };
}

// Layer classification by path conventions. Used for grouping in the report.
function classifyLayer(path: string): string {
  if (path.startsWith('models/staging/')) return 'staging';
  if (path.startsWith('models/intermediate/')) return 'intermediate';
  if (path.startsWith('models/marts/presentation/')) return 'presentation';
  if (path.startsWith('models/marts/')) return 'marts';
  if (path.startsWith('models/sources/')) return 'sources';
  return 'other';
}

// Builds a test-by-model index from manifest.nodes. Test nodes have
// resource_type === 'test' and depends_on.nodes pointing to the models they exercise.
interface TestNode { name: string; depends_on?: { nodes?: string[] }; }
function buildTestsByModel(nodes: Record<string, ManifestNode>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of Object.values(nodes)) {
    if (n.resource_type !== 'test') continue;
    const t = n as ManifestNode & TestNode;
    const targets = t.depends_on?.nodes ?? [];
    for (const target of targets) {
      if (!target.startsWith('model.')) continue; // only model tests; ignore source tests for now
      (out[target] ??= []).push(n.name);
    }
  }
  return out;
}

// BFS over child_map / parent_map. Only follows model nodes — tests/seeds/analyses
// are noise for impact analysis and would 5× the response size.
function walkGraph(
  manifest: ManifestShape,
  startUid: string,
  direction: 'downstream' | 'upstream',
  testsByModel: Record<string, string[]>,
): ImpactNode[] {
  const map = direction === 'downstream' ? manifest.child_map : manifest.parent_map;
  const visited = new Set<string>([startUid]);
  const queue: { uid: string; depth: number }[] = [{ uid: startUid, depth: 0 }];
  const out: ImpactNode[] = [];

  while (queue.length > 0) {
    const { uid, depth } = queue.shift()!;
    const neighbors = map[uid] ?? [];
    for (const n of neighbors) {
      if (!n.startsWith('model.')) continue;
      if (visited.has(n)) continue;
      visited.add(n);
      const node = manifest.nodes[n];
      if (!node) continue;
      out.push({
        name: node.name,
        path: node.original_file_path,
        materialized: node.config?.materialized,
        layer: classifyLayer(node.original_file_path),
        depth: depth + 1,
        tests: testsByModel[n] ?? [],
        compiled_path: `target/compiled/${n.split('.')[1]}/${node.original_file_path}`,
      });
      queue.push({ uid: n, depth: depth + 1 });
    }
  }
  return out;
}

// Pure transform — exported for unit testing without touching the filesystem.
export function queryImpactData(
  manifest: ManifestShape,
  model: string,
  direction: ImpactDirection = 'downstream',
): ImpactResult | string {
  const findModelUid = (name: string) => Object.keys(manifest.nodes).find(
    k => manifest.nodes[k]!.name === name && manifest.nodes[k]!.resource_type === 'model',
  );
  const uid = findModelUid(model);
  if (!uid) return `Model "${model}" not found in manifest.`;

  const node = manifest.nodes[uid]!;
  const testsByModel = buildTestsByModel(manifest.nodes);

  const result: ImpactResult = {
    model: {
      name: node.name,
      path: node.original_file_path,
      materialized: node.config?.materialized,
      layer: classifyLayer(node.original_file_path),
      tests: testsByModel[uid] ?? [],
    },
    direction,
    by_layer: {},
    max_depth: 0,
  };

  const collect = (nodes: ImpactNode[]) => {
    for (const n of nodes) {
      result.by_layer[n.layer] = (result.by_layer[n.layer] ?? 0) + 1;
      if (n.depth > result.max_depth) result.max_depth = n.depth;
    }
  };

  if (direction === 'downstream' || direction === 'both') {
    result.downstream = walkGraph(manifest, uid, 'downstream', testsByModel);
    collect(result.downstream);
  }
  if (direction === 'upstream' || direction === 'both') {
    result.upstream = walkGraph(manifest, uid, 'upstream', testsByModel);
    collect(result.upstream);
  }

  return result;
}

function extractWarehouseType(profilesYml: string): string | null {
  for (const line of profilesYml.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('type:')) return trimmed.slice('type:'.length).trim();
  }
  return null;
}

function detectDialect(): string | null {
  const candidates = [
    resolve(PROJECT_DIR, 'profiles.yml'),
    resolve(homedir(), '.dbt', 'profiles.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return extractWarehouseType(readFileSync(p, 'utf-8'));
  }
  return null;
}

// Filesystem wrapper for the impact query. Optionally augments the graph with
// column-level lineage by reading each descendant's compiled SQL and running the tracer.
function queryImpact(
  manifest: ManifestShape,
  model: string,
  direction: ImpactDirection,
  column: string | undefined,
): string {
  const result = queryImpactData(manifest, model, direction);
  if (typeof result === 'string') return result;

  if (column && result.downstream && result.downstream.length > 0) {
    const dialect = pickDialect(detectDialect());
    const modelsInOrder = result.downstream.map(n => {
      const compiledFull = resolve(PROJECT_DIR, n.compiled_path);
      const sql = existsSync(compiledFull) ? readFileSync(compiledFull, 'utf-8') : null;
      return { name: n.name, compiledSql: sql };
    });
    const { taint, perModelStatus } = propagateColumnTaint({
      targetModel: result.model.name,
      targetColumn: column,
      modelsInOrder,
      dialect,
    });
    result.column = { name: column, taint, trace_status: perModelStatus };
  }

  return JSON.stringify(result, null, 2);
}

function queryManifest(query: string, model?: string, direction?: ImpactDirection, column?: string): string {
  const manifestPath = resolve(PROJECT_DIR, 'target/manifest.json');
  if (!existsSync(manifestPath)) {
    return 'target/manifest.json not found. Run dbt compile or dbt parse first.';
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestShape;
  if (query === 'impact') {
    if (!model) return 'Provide a model name for the "impact" query.';
    return queryImpact(manifest, model, direction ?? 'downstream', column);
  }
  return queryManifestData(manifest, query, model);
}

async function executeModelState(input: Record<string, unknown>): Promise<string> {
  const action = input.action as string;
  if (action === 'reset')        return resetModelState();
  if (action === 'sync')         return await syncManifestState();
  if (action === 'queue')        return getLintQueue((input.batch_size as number | undefined) ?? 100);
  if (action === 'status')       return getModelStatus();
  if (action === 'fetch_content') return fetchContent((input.paths as string[]) ?? [], input.projection as Projection | undefined);
  if (action === 'lint_run')     return await lintRun(input.binary_path as string, !!(input.force as boolean | undefined));
  if (action === 'mark_linted') {
    return markModelLinted(
      input.model_name      as string,
      input.lint_status     as 'clean' | 'violations',
      (input.violation_count as number) ?? 0,
      (input.violations_json as string)  ?? '[]',
    );
  }
  return `Unknown action: ${action}`;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case 'run_dbt_command':    return await runDbtCommand(input.command as string);
      case 'read_file':          return readFile(input.path as string);
      case 'write_file':         return writeFile(input.path as string, input.content as string);
      case 'query_run_results':  return queryRunResults(input.query as string, input.model as string | undefined);
      case 'list_files':       return await listFiles(input.pattern as string);
      case 'bash':             return await runBash(input.command as string);
      case 'query_manifest':   return queryManifest(
        input.query as string,
        input.model as string | undefined,
        input.direction as ImpactDirection | undefined,
        input.column as string | undefined,
      );
      case 'model_state':      return await executeModelState(input);
      case 'kimball_query':    return kimballQuery(input as unknown as KimballQueryInput);
      default:                 return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
