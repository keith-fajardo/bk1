import { describe, expect, test } from 'bun:test';
import { queryImpactData, formatBlastRadius, type ManifestShape } from '../src/tools';

// Minimal synthetic manifest: stg_orders → int_orders → fct_orders, with one test on each
// downstream model. Exercises the same pure path write_file uses to build the blast report.
function node(uid: string, name: string, path: string) {
  return { resource_type: 'model', name, unique_id: uid, original_file_path: path, schema: 'analytics', config: { materialized: 'view' } };
}
function testNode(uid: string, name: string, target: string) {
  return { resource_type: 'test', name, unique_id: uid, original_file_path: 'x', schema: 'analytics', depends_on: { nodes: [target] } };
}

const manifest: ManifestShape = {
  nodes: {
    'model.shop.stg_orders': node('model.shop.stg_orders', 'stg_orders', 'models/staging/stg_orders.sql'),
    'model.shop.int_orders': node('model.shop.int_orders', 'int_orders', 'models/intermediate/int_orders.sql'),
    'model.shop.fct_orders': node('model.shop.fct_orders', 'fct_orders', 'models/marts/core/sales/fact/fct_orders.sql'),
    'test.shop.not_null_int':  testNode('test.shop.not_null_int', 'not_null_int_orders_id', 'model.shop.int_orders'),
    'test.shop.unique_fct':    testNode('test.shop.unique_fct', 'unique_fct_orders_id', 'model.shop.fct_orders'),
  } as ManifestShape['nodes'],
  sources: {},
  parent_map: {
    'model.shop.int_orders': ['model.shop.stg_orders'],
    'model.shop.fct_orders': ['model.shop.int_orders'],
  },
  child_map: {
    'model.shop.stg_orders': ['model.shop.int_orders'],
    'model.shop.int_orders': ['model.shop.fct_orders', 'test.shop.not_null_int'],
    'model.shop.fct_orders': ['test.shop.unique_fct'],
  },
};

describe('formatBlastRadius', () => {
  test('summarizes downstream models, layers, and tests for an edited model', () => {
    const result = queryImpactData(manifest, 'stg_orders', 'downstream');
    expect(typeof result).not.toBe('string');
    const report = formatBlastRadius(result as Exclude<typeof result, string>);
    expect(report).not.toBeNull();
    // 2 downstream models (int + fct), grouped by layer, with both tests counted.
    expect(report).toContain('2 models');
    expect(report).toContain('1 intermediate');
    expect(report).toContain('1 marts');
    expect(report).toContain('2 tests at risk');
    // Only the direct dependent is named; the transitive one is not in the "directly depends" line.
    expect(report).toContain('Directly depends on it: int_orders');
    expect(report).toContain('dbt build --select stg_orders+');
  });

  test('returns null for a leaf model with no descendants', () => {
    const result = queryImpactData(manifest, 'fct_orders', 'downstream');
    expect(formatBlastRadius(result as Exclude<typeof result, string>)).toBeNull();
  });
});
