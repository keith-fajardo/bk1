import { describe, expect, test } from 'bun:test';
import { queryManifestData, queryImpactData, type ManifestShape } from '../src/tools';

const manifest: ManifestShape = {
  nodes: {
    'model.proj.stg_orders': {
      resource_type: 'model',
      name: 'stg_orders',
      unique_id: 'model.proj.stg_orders',
      original_file_path: 'models/staging/stg_orders.sql',
      schema: 'staging',
      config: { materialized: 'view' },
      tags: ['daily'],
    },
    'model.proj.dim_account': {
      resource_type: 'model',
      name: 'dim_account',
      unique_id: 'model.proj.dim_account',
      original_file_path: 'models/marts/core/finance/dim/dim_account.sql',
      schema: 'marts',
      config: { materialized: 'table', schema: 'finance_marts' },
      tags: [],
    },
  },
  sources: {
    'source.proj.raw.orders': {
      source_name: 'raw',
      name: 'orders',
      identifier: 'orders_raw',
      schema: 'raw',
      unique_id: 'source.proj.raw.orders',
    },
  },
  parent_map: {
    'model.proj.dim_account': ['model.proj.stg_orders', 'source.proj.raw.orders'],
    'model.proj.stg_orders':  ['source.proj.raw.orders'],
  },
  child_map: {
    'model.proj.stg_orders':  ['model.proj.dim_account'],
    'model.proj.dim_account': [],
  },
};

describe('queryManifestData', () => {
  describe('model query (single-model profile)', () => {
    test('returns path + materialization + parents + children in one response', () => {
      const result = JSON.parse(queryManifestData(manifest, 'model', 'dim_account'));
      expect(result.name).toBe('dim_account');
      expect(result.path).toBe('models/marts/core/finance/dim/dim_account.sql');
      expect(result.yaml_path).toBe('models/marts/core/finance/dim/dim_account.yml');
      expect(result.materialized).toBe('table');
      expect(result.schema).toBe('finance_marts');
      expect(result.parents).toEqual(['stg_orders', 'source:raw.orders']);
      expect(result.children).toEqual([]);
    });

    test('compiled_path includes the project name from unique_id', () => {
      const result = JSON.parse(queryManifestData(manifest, 'model', 'dim_account'));
      expect(result.compiled_path).toBe(
        'target/compiled/proj/models/marts/core/finance/dim/dim_account.sql',
      );
    });

    test('response is small enough to be cheap (under 1KB)', () => {
      // Token-economy guard. The whole point of this query is to be a small,
      // one-shot replacement for the list_files + dbt ls + read_file chain.
      const result = queryManifestData(manifest, 'model', 'dim_account');
      expect(result.length).toBeLessThan(1000);
    });

    test('returns helpful error when model is missing', () => {
      const result = queryManifestData(manifest, 'model', 'nonexistent');
      expect(result).toContain('not found');
    });

    test('returns helpful error when model name is omitted', () => {
      const result = queryManifestData(manifest, 'model');
      expect(result).toContain('Provide a model name');
    });
  });

  describe('lineage query (regression coverage)', () => {
    test('resolves model and source ids to readable labels', () => {
      const result = JSON.parse(queryManifestData(manifest, 'lineage', 'dim_account'));
      expect(result.parents).toEqual(['stg_orders', 'source:raw.orders']);
      expect(result.children).toEqual([]);
    });

    test('filters out dbt test/seed/analysis nodes from lineage', () => {
      // Test nodes attached as children of a model can be 5x more numerous than real
      // downstream models. They are noise for /explain and would balloon the response.
      const withTests: ManifestShape = {
        ...manifest,
        child_map: {
          ...manifest.child_map,
          'model.proj.dim_account': [
            'model.proj.fct_orders',
            'test.proj.not_null_dim_account_id.abc123',
            'test.proj.unique_dim_account_id.def456',
            'seed.proj.country_codes',
            'snapshot.proj.dim_account_snapshot',
          ],
        },
      };
      const result = JSON.parse(queryManifestData(withTests, 'model', 'dim_account'));
      expect(result.children).toEqual(['fct_orders', 'snapshot:dim_account_snapshot']);
      expect(result.children).not.toContain(
        expect.stringContaining('test.proj.not_null_dim_account_id'),
      );
    });
  });

  describe('models query (inventory)', () => {
    test('returns every model and respects config.schema override', () => {
      const result = JSON.parse(queryManifestData(manifest, 'models'));
      expect(result).toHaveLength(2);
      const dim = result.find((m: { name: string }) => m.name === 'dim_account');
      expect(dim.schema).toBe('finance_marts');
      expect(dim.materialized).toBe('table');
    });
  });

  describe('refs query (name-only inventory)', () => {
    test('returns model names + source/table pairs', () => {
      const result = JSON.parse(queryManifestData(manifest, 'refs'));
      expect(result.models).toEqual(['dim_account', 'stg_orders']); // sorted
      expect(result.sources).toEqual([{ source: 'raw', table: 'orders' }]);
    });

    test('omits paths, materialization, schema, identifier, unique_id — keeps the response tiny', () => {
      // This is the explicit token-economy contract: refs strips everything except names.
      // If a new field sneaks in here, /refactor's cost grows linearly with project size.
      const result = JSON.parse(queryManifestData(manifest, 'refs'));
      const firstModel = result.models[0];
      expect(typeof firstModel).toBe('string');
      const firstSource = result.sources[0];
      expect(Object.keys(firstSource).sort()).toEqual(['source', 'table']);
    });

    test('response is materially smaller than "models" + "sources" combined', () => {
      const refs    = queryManifestData(manifest, 'refs');
      const models  = queryManifestData(manifest, 'models');
      const sources = queryManifestData(manifest, 'sources');
      // refs should be at least 3× smaller; the win grows with project size.
      expect(refs.length * 3).toBeLessThan(models.length + sources.length);
    });
  });

  test('unknown query type returns explicit error', () => {
    const result = queryManifestData(manifest, 'bogus');
    expect(result).toContain('Unknown query type');
  });
});

// ─── Impact analysis ─────────────────────────────────────────────────────────────
// A 4-deep chain with tests on multiple layers, exercising BFS depth, layer classification,
// test attachment, and direction switching.

const impactManifest: ManifestShape = {
  nodes: {
    'model.proj.stg_orders': {
      resource_type: 'model', name: 'stg_orders', unique_id: 'model.proj.stg_orders',
      original_file_path: 'models/staging/stg_orders.sql',
      schema: 'staging', config: { materialized: 'view' },
    },
    'model.proj.int_acc': {
      resource_type: 'model', name: 'int_acc', unique_id: 'model.proj.int_acc',
      original_file_path: 'models/intermediate/int_acc.sql',
      schema: 'intermediate', config: { materialized: 'table' },
    },
    'model.proj.fct_rev': {
      resource_type: 'model', name: 'fct_rev', unique_id: 'model.proj.fct_rev',
      original_file_path: 'models/marts/core/finance/fact/fct_rev.sql',
      schema: 'marts', config: { materialized: 'incremental' },
    },
    'model.proj.rpt_kpi': {
      resource_type: 'model', name: 'rpt_kpi', unique_id: 'model.proj.rpt_kpi',
      original_file_path: 'models/marts/presentation/rpt_kpi.sql',
      schema: 'marts', config: { materialized: 'table' },
    },
    // A test on the target and a test on an intermediate descendant — must surface in the
    // tests-at-risk section of the response.
    'test.proj.unique_stg_orders_id.x': {
      resource_type: 'test', name: 'unique_stg_orders_id', unique_id: 'test.proj.unique_stg_orders_id.x',
      original_file_path: '', schema: '',
      // @ts-expect-error — depends_on is on test nodes but ManifestNode doesn't declare it
      depends_on: { nodes: ['model.proj.stg_orders'] },
    },
    'test.proj.not_null_int_acc_id.y': {
      resource_type: 'test', name: 'not_null_int_acc_id', unique_id: 'test.proj.not_null_int_acc_id.y',
      original_file_path: '', schema: '',
      // @ts-expect-error — depends_on on test nodes
      depends_on: { nodes: ['model.proj.int_acc'] },
    },
  },
  sources: {},
  parent_map: {
    'model.proj.int_acc': ['model.proj.stg_orders'],
    'model.proj.fct_rev': ['model.proj.int_acc'],
    'model.proj.rpt_kpi': ['model.proj.fct_rev'],
  },
  child_map: {
    'model.proj.stg_orders': ['model.proj.int_acc'],
    'model.proj.int_acc':    ['model.proj.fct_rev'],
    'model.proj.fct_rev':    ['model.proj.rpt_kpi'],
    'model.proj.rpt_kpi':    [],
  },
};

describe('queryImpactData', () => {
  test('downstream BFS walks the full chain with correct depths', () => {
    const r = queryImpactData(impactManifest, 'stg_orders', 'downstream');
    expect(typeof r).not.toBe('string');
    if (typeof r === 'string') return;
    expect(r.downstream).toHaveLength(3);
    expect(r.downstream![0]).toMatchObject({ name: 'int_acc', depth: 1, layer: 'intermediate' });
    expect(r.downstream![1]).toMatchObject({ name: 'fct_rev', depth: 2, layer: 'marts' });
    expect(r.downstream![2]).toMatchObject({ name: 'rpt_kpi', depth: 3, layer: 'presentation' });
    expect(r.max_depth).toBe(3);
  });

  test('upstream walks parents — leaf has empty downstream', () => {
    const r = queryImpactData(impactManifest, 'rpt_kpi', 'upstream');
    expect(typeof r).not.toBe('string');
    if (typeof r === 'string') return;
    expect(r.upstream?.map(n => n.name)).toEqual(['fct_rev', 'int_acc', 'stg_orders']);
    expect(r.downstream).toBeUndefined();
  });

  test('both direction returns separate downstream and upstream arrays', () => {
    const r = queryImpactData(impactManifest, 'int_acc', 'both');
    expect(typeof r).not.toBe('string');
    if (typeof r === 'string') return;
    expect(r.downstream?.map(n => n.name)).toEqual(['fct_rev', 'rpt_kpi']);
    expect(r.upstream?.map(n => n.name)).toEqual(['stg_orders']);
  });

  test('by_layer tallies count each descendant in its classified layer', () => {
    const r = queryImpactData(impactManifest, 'stg_orders', 'downstream');
    if (typeof r === 'string') throw new Error(r);
    expect(r.by_layer).toEqual({ intermediate: 1, marts: 1, presentation: 1 });
  });

  test('tests on the target are surfaced on the model object, not in descendants', () => {
    // Regression target: test names came back as the uid hash suffix (e.g. "x") instead
    // of the readable node.name. If this fails, the report says "tests: ['x', 'y']".
    const r = queryImpactData(impactManifest, 'stg_orders', 'downstream');
    if (typeof r === 'string') throw new Error(r);
    expect(r.model.tests).toEqual(['unique_stg_orders_id']);
    const intAcc = r.downstream!.find(n => n.name === 'int_acc')!;
    expect(intAcc.tests).toEqual(['not_null_int_acc_id']);
  });

  test('descendant ImpactNode includes compiled_path so column-lineage caller can read it', () => {
    const r = queryImpactData(impactManifest, 'stg_orders', 'downstream');
    if (typeof r === 'string') throw new Error(r);
    expect(r.downstream![0]!.compiled_path).toBe(
      'target/compiled/proj/models/intermediate/int_acc.sql',
    );
  });

  test('non-existent model returns an explicit error string', () => {
    const r = queryImpactData(impactManifest, 'nonexistent', 'downstream');
    expect(typeof r).toBe('string');
    expect(r as string).toContain('not found');
  });

  test('graph walk filters out test/seed/snapshot nodes — only model edges are followed', () => {
    // The child_map can contain test/seed/snapshot edges. If we don't filter, the response
    // balloons 5×. Explicit guard.
    const polluted: ManifestShape = {
      ...impactManifest,
      child_map: {
        ...impactManifest.child_map,
        'model.proj.stg_orders': [
          'model.proj.int_acc',
          'test.proj.unique_stg_orders_id.x',
          'seed.proj.country_codes',
        ],
      },
    };
    const r = queryImpactData(polluted, 'stg_orders', 'downstream');
    if (typeof r === 'string') throw new Error(r);
    expect(r.downstream!.map(n => n.name)).toEqual(['int_acc', 'fct_rev', 'rpt_kpi']);
  });
});

