import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { bk1AssetsDir } from '../src/bk1-home';
import { buildColibriGraph, propagateColumnTaintViaColibri, resolveColibriCommand, type ColibriManifest } from '../src/colibri';

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'colibri-manifest.json'), 'utf-8'),
) as ColibriManifest;
const graph = buildColibriGraph(manifest);

describe('buildColibriGraph', () => {
  test('maps bare model names to node ids and back', () => {
    expect(graph.nameToId.get('stg_orders')).toBe('model.proj.stg_orders');
    expect(graph.nameToId.get('dim_orders')).toBe('model.proj.dim_orders');
    expect(graph.idToName.get('model.proj.int_orders')).toBe('int_orders');
  });

  test('indexes the source node by its bare name too', () => {
    expect(graph.nameToId.get('orders')).toBe('source.proj.raw.orders');
  });

  test('drops structural (filter/join) edges from the data graph', () => {
    // edge 7 is a filter edge stg_orders.status → int_orders with an empty targetColumn.
    expect(graph.forward.has('model.proj.stg_orders.status')).toBe(false);
  });
});

describe('propagateColumnTaintViaColibri', () => {
  test('traces a transformed column through the whole descendant chain', () => {
    const out = propagateColumnTaintViaColibri(graph, 'stg_orders', 'amount')!;
    expect(out.taint['stg_orders']).toEqual(['amount']);
    expect(out.taint['int_orders']).toEqual(['amount', 'amount_usd']);
    expect(out.taint['dim_orders']).toEqual(['revenue']);
  });

  test('keeps independent columns separate', () => {
    const out = propagateColumnTaintViaColibri(graph, 'stg_orders', 'order_id')!;
    expect(out.taint['int_orders']).toEqual(['order_id']);
    expect(out.taint['dim_orders']).toEqual(['order_id']);
    // amount-derived columns must NOT show up when tracing order_id.
    expect(out.taint['int_orders']).not.toContain('amount');
  });

  test('traces from a source node', () => {
    const out = propagateColumnTaintViaColibri(graph, 'orders', 'amount')!;
    expect(out.taint['orders']).toEqual(['amount']);
    expect(out.taint['stg_orders']).toEqual(['amount']);
    expect(out.taint['dim_orders']).toEqual(['revenue']);
  });

  test('a column whose only downstream edge is structural has no descendants', () => {
    const out = propagateColumnTaintViaColibri(graph, 'stg_orders', 'status')!;
    expect(out.taint['stg_orders']).toEqual(['status']);
    expect(out.taint['int_orders']).toBeUndefined();
  });

  test('dedupes a column reached via two converging paths', () => {
    // dim_orders.revenue derives from both int_orders.amount_usd and int_orders.amount.
    const out = propagateColumnTaintViaColibri(graph, 'stg_orders', 'amount')!;
    expect(out.taint['dim_orders']).toEqual(['revenue']);
  });

  test('returns null for a model absent from the graph (fallback signal)', () => {
    expect(propagateColumnTaintViaColibri(graph, 'does_not_exist', 'x')).toBeNull();
  });
});

describe('resolveColibriCommand', () => {
  test('BK1_COLIBRI_BIN (an existing path) outranks a PATH colibri', () => {
    const prev = process.env.BK1_COLIBRI_BIN;
    process.env.BK1_COLIBRI_BIN = import.meta.path;  // a file that exists
    try {
      // The bundled sidecar (if a dev ran build:colibri) is higher priority than the env
      // override by design; assert env beats PATH, accounting for that.
      const sidecar = resolve(bk1AssetsDir(), 'bk1-colibri');
      const expected = existsSync(sidecar) ? [sidecar] : [import.meta.path];
      expect(resolveColibriCommand()).toEqual(expected);
    } finally {
      if (prev === undefined) delete process.env.BK1_COLIBRI_BIN;
      else process.env.BK1_COLIBRI_BIN = prev;
    }
  });
});
