// Colibri column-lineage graph adapter.
//
// dbt-colibri (bundled sidecar bk1-colibri) emits a column-to-column edge list at
// target/colibri/colibri-manifest.json. It's a higher-accuracy, catalog-aware
// alternative to the built-in node-sql-parser tracer in lineage.ts: SQLGlot expands
// SELECT *, handles window functions / aggregations / CASE / joins, and covers the
// warehouse dialects bk1's tracer falls back on. We consume the edge graph to power
// the same column-taint blast radius propagateColumnTaint produces.
//
// AUGMENT, not replace: colibri needs catalog.json (a warehouse round-trip via
// `dbt docs generate`), so its graph can't refresh on every write_file. The built-in
// tracer stays as the always-available per-edit fallback. We only prefer the colibri
// graph when it exists AND is at least as new as target/manifest.json — a stale graph
// loses to the live tracer (which reads fresh compiled SQL).

import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { getProjectDir } from './project-dir';
import { bk1AssetsDir } from './bk1-home';
import type { PropagationOutput, ModelTraceStatus } from './lineage';

// ─── Colibri output shape (the subset we consume) ───────────────────────────────────
// Full schema is colibri's generate_report() output; we only read nodes (for the
// node_id ↔ bare-name map) and lineage.edges (the column graph).

interface ColibriColumn {
  columnName: string;
  lineageType?: string;   // "passthrough" | "transformation" | "unknown"
  hasLineage?: boolean;
}
interface ColibriNode {
  id: string;
  name: string;           // bare model name / alias (matches dbt manifest node.name)
  fullName: string;       // == node_id, e.g. "model.project.stg_orders"
  nodeType: string;       // "model" | "source" | "seed" | "snapshot" | ...
  columns?: Record<string, ColibriColumn>;
}
interface ColibriEdge {
  source: string;         // source node_id
  target: string;         // target node_id
  sourceColumn: string;
  targetColumn: string;
  edgeType?: string;      // "filter" | "join" — structural, empty targetColumn
}
export interface ColibriManifest {
  metadata?: Record<string, unknown>;
  nodes?: Record<string, ColibriNode>;
  lineage?: { edges?: ColibriEdge[] };
}

// ─── In-memory graph ─────────────────────────────────────────────────────────────────

export interface ColibriGraph {
  // `${sourceNodeId}.${sourceCol}` → downstream column coordinates (data edges only).
  forward: Map<string, { node: string; column: string }[]>;
  nameToId: Map<string, string>;   // bare model name → node_id (model nodes win on collision)
  idToName: Map<string, string>;   // node_id → bare name
}

export function buildColibriGraph(manifest: ColibriManifest): ColibriGraph {
  const forward = new Map<string, { node: string; column: string }[]>();
  const nameToId = new Map<string, string>();
  const idToName = new Map<string, string>();

  const nodes = manifest.nodes ?? {};
  for (const [id, node] of Object.entries(nodes)) {
    idToName.set(id, node.name);
    const existing = nameToId.get(node.name);
    // A model node always wins the bare-name slot — mirrors queryImpactData, which
    // resolves a model name only against resource_type === 'model'.
    if (!existing || (node.nodeType === 'model' && nodes[existing]?.nodeType !== 'model')) {
      nameToId.set(node.name, id);
    }
  }

  for (const e of manifest.lineage?.edges ?? []) {
    if (e.edgeType) continue;  // structural join/filter edge — no targetColumn to taint
    const key = `${e.source}.${e.sourceColumn}`;
    const arr = forward.get(key);
    if (arr) arr.push({ node: e.target, column: e.targetColumn });
    else forward.set(key, [{ node: e.target, column: e.targetColumn }]);
  }

  return { forward, nameToId, idToName };
}

// BFS the column graph from (targetModel, targetColumn), collecting every downstream
// column that derives from it. Returns the SAME shape as propagateColumnTaint so the
// call sites are drop-in. Returns null when the model isn't in the graph, so the caller
// falls back to the built-in tracer.
export function propagateColumnTaintViaColibri(
  graph: ColibriGraph,
  targetModel: string,
  targetColumn: string,
): PropagationOutput | null {
  const startId = graph.nameToId.get(targetModel);
  if (!startId) return null;

  const taint: Record<string, string[]> = { [targetModel]: [targetColumn] };
  const status: Record<string, ModelTraceStatus> = {};

  const seen = new Set<string>([`${startId}.${targetColumn}`]);
  const queue: { node: string; column: string }[] = [{ node: startId, column: targetColumn }];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of graph.forward.get(`${cur.node}.${cur.column}`) ?? []) {
      const k = `${next.node}.${next.column}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const name = graph.idToName.get(next.node) ?? next.node;
      const cols = taint[name] ?? (taint[name] = []);
      if (!cols.includes(next.column)) cols.push(next.column);
      status[name] = { status: 'traced' };
      queue.push(next);
    }
  }

  return { taint, perModelStatus: status };
}

// ─── Filesystem layer ────────────────────────────────────────────────────────────────

export function colibriManifestPath(): string {
  return resolve(getProjectDir(), 'target/colibri/colibri-manifest.json');
}

function loadColibriGraph(): ColibriGraph | null {
  const p = colibriManifestPath();
  if (!existsSync(p)) return null;
  try {
    const manifest = JSON.parse(readFileSync(p, 'utf-8')) as ColibriManifest;
    if (!manifest.lineage?.edges) return null;
    return buildColibriGraph(manifest);
  } catch {
    return null;
  }
}

// Returns the parsed graph only when colibri output exists and is no older than the dbt
// manifest. A graph older than target/manifest.json predates the latest compile, so the
// live tracer (fresh compiled SQL) is the safer source — return null to fall back. Used by
// the consume-only path (postCompileColumnTaint); /impact uses ensureColibriGraph instead.
export function colibriGraphIfFresh(): ColibriGraph | null {
  const p = colibriManifestPath();
  if (!existsSync(p)) return null;
  const manifestPath = resolve(getProjectDir(), 'target/manifest.json');
  if (existsSync(manifestPath) && statSync(manifestPath).mtimeMs > statSync(p).mtimeMs) return null;
  return loadColibriGraph();
}

// ─── On-demand generation (Phase 2) ──────────────────────────────────────────────────
//
// /impact <model>.<column> generates the colibri manifest on the spot when it's missing
// or stale, then parses it. colibri is resolved in priority order: the bundled
// bk1-colibri sidecar (shipped next to the binary), an explicit BK1_COLIBRI_BIN, a
// `colibri` on PATH (`pip install dbt-colibri`), or `uvx --from dbt-colibri colibri`
// (ephemeral, no global install). None available → caller falls back to the built-in
// tracer. Generation never throws; failures degrade to the tracer with a note.

function isStale(target: string, ...inputs: string[]): boolean {
  if (!existsSync(target)) return true;
  const t = statSync(target).mtimeMs;
  return inputs.some(i => existsSync(i) && statSync(i).mtimeMs > t);
}

// Returns the argv PREFIX that runs colibri (before its `generate ...` args), or null.
export function resolveColibriCommand(): string[] | null {
  const sidecar = resolve(bk1AssetsDir(), 'bk1-colibri');
  if (existsSync(sidecar)) return [sidecar];

  const envBin = process.env.BK1_COLIBRI_BIN;
  if (envBin && existsSync(envBin)) return [envBin];

  if (Bun.which('colibri')) return ['colibri'];
  if (Bun.which('uvx')) return ['uvx', '--from', 'dbt-colibri', 'colibri'];
  return null;
}

export interface ColibriGenResult {
  graph: ColibriGraph | null;
  note: string | null;   // why we fell back, or what we did — for the agent to narrate
}

// Ensure a fresh colibri manifest exists (generating it if missing/stale), then load it.
// Always resolves: graph=null means "use the built-in tracer", and note says why.
export async function ensureColibriGraph(): Promise<ColibriGenResult> {
  const projectDir = getProjectDir();
  const manifestJson = resolve(projectDir, 'target/manifest.json');
  const catalogJson = resolve(projectDir, 'target/catalog.json');

  if (!existsSync(manifestJson)) {
    return { graph: null, note: 'no target/manifest.json — run dbt compile/parse first' };
  }

  // Reuse a still-fresh manifest; only spawn colibri when it's missing or out of date.
  if (!isStale(colibriManifestPath(), manifestJson, catalogJson)) {
    const graph = loadColibriGraph();
    return { graph, note: graph ? null : 'colibri manifest present but unreadable' };
  }

  if (!existsSync(catalogJson)) {
    return { graph: null, note: 'colibri needs target/catalog.json — run `dbt docs generate`' };
  }

  const cmd = resolveColibriCommand();
  if (!cmd) {
    return { graph: null, note: 'colibri not available — bundled sidecar pending; `pip install dbt-colibri` or install uv to enable now' };
  }

  // --disable-telemetry + DO_NOT_TRACK: colibri otherwise sends anonymous usage stats
  // (adapter type, node count) on every run. bk1 is local-first — never phone home on
  // the user's behalf without consent. Flag kills the HTML-embedded beacon; the env vars
  // kill the CLI's own collection (which prints a notice we'd be swallowing anyway).
  const argv = [
    ...cmd, 'generate',
    '--manifest', 'target/manifest.json',
    '--catalog', 'target/catalog.json',
    '--output-dir', 'target/colibri',
    '--disable-telemetry',
  ];
  try {
    const proc = Bun.spawn(argv, {
      cwd: projectDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, DO_NOT_TRACK: '1', DISABLE_COLIBRI_TELEMETRY: '1' },
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      const lastLine = stderr.trim().split('\n').pop() ?? '';
      return { graph: null, note: `colibri generate failed (exit ${code}): ${lastLine}` };
    }
  } catch (e) {
    return { graph: null, note: `colibri generate could not run: ${(e as Error).message}` };
  }

  const graph = loadColibriGraph();
  return {
    graph,
    note: graph ? 'generated colibri column lineage' : 'colibri ran but produced no readable manifest',
  };
}
