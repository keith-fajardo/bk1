import { describe, expect, test } from 'bun:test';
import { queryRunResultsData, type RunResults, type RunResultEntry } from '../src/tools';

function r(status: string, name: string, extra: Partial<RunResultEntry> = {}): RunResultEntry {
  return {
    status,
    unique_id: `model.test_project.${name}`,
    execution_time: 0.1,
    ...extra,
  };
}

const cleanRun: RunResults = {
  metadata: { generated_at: '2026-05-25T08:32:49Z', invocation_id: 'abc' },
  results: [
    r('success', 'stg_a'),
    r('success', 'stg_b'),
    r('pass',    'dim_x'),
  ],
  elapsed_time: 12.5,
};

const failingRun: RunResults = {
  metadata: { generated_at: '2026-05-25T09:00:00Z' },
  results: [
    r('success', 'stg_a'),
    r('error',   'fct_orders', {
      message: 'relation "raw.orders" does not exist',
      adapter_response: { _message: 'permission denied', code: '42P01' },
      compiled: true,
      compiled_code: 'select * from raw.orders',
      relation_name: 'analytics.fct_orders',
    }),
    r('fail',    'dim_users', { message: 'unique constraint violated', failures: 3 }),
    r('skipped', 'rpt_revenue'),
    r('skipped', 'rpt_churn'),
  ],
  elapsed_time: 45.2,
};

describe('queryRunResultsData', () => {
  describe('summary', () => {
    test('returns zero failures and zero skipped for a clean run', () => {
      const result = JSON.parse(queryRunResultsData(cleanRun, 'summary'));
      expect(result.total).toBe(3);
      expect(result.failures).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.counts).toEqual({ success: 2, pass: 1 });
      expect(result.generated_at).toBe('2026-05-25T08:32:49Z');
      expect(result.elapsed_time).toBe(12.5);
    });

    test('returns failure and skipped ids for a failing run', () => {
      const result = JSON.parse(queryRunResultsData(failingRun, 'summary'));
      expect(result.total).toBe(5);
      expect(result.counts).toEqual({ success: 1, error: 1, fail: 1, skipped: 2 });
      expect(result.failures).toEqual(['fct_orders', 'dim_users']);
      expect(result.skipped).toEqual(['rpt_revenue', 'rpt_churn']);
    });
  });

  describe('failures', () => {
    test('returns empty list for a clean run', () => {
      const result = JSON.parse(queryRunResultsData(cleanRun, 'failures'));
      expect(result.count).toBe(0);
      expect(result.failures).toEqual([]);
    });

    test('returns full diagnostics for failed/error rows only', () => {
      const result = JSON.parse(queryRunResultsData(failingRun, 'failures'));
      expect(result.count).toBe(2);
      const names = result.failures.map((f: { name: string }) => f.name);
      expect(names).toEqual(['fct_orders', 'dim_users']);
      const fctOrders = result.failures[0];
      expect(fctOrders.message).toContain('does not exist');
      expect(fctOrders.adapter_response.code).toBe('42P01');
      expect(fctOrders.compiled).toBe(true);
    });

    test('does not include skipped models in failures', () => {
      const result = JSON.parse(queryRunResultsData(failingRun, 'failures'));
      const names = result.failures.map((f: { name: string }) => f.name);
      expect(names).not.toContain('rpt_revenue');
      expect(names).not.toContain('rpt_churn');
    });
  });

  describe('skipped', () => {
    test('returns only skipped models, not failures', () => {
      const result = JSON.parse(queryRunResultsData(failingRun, 'skipped'));
      expect(result.count).toBe(2);
      const names = result.skipped.map((s: { name: string }) => s.name);
      expect(names).toEqual(['rpt_revenue', 'rpt_churn']);
    });
  });

  describe('model', () => {
    test('returns the full entry for a single model', () => {
      const result = JSON.parse(queryRunResultsData(failingRun, 'model', 'fct_orders'));
      expect(result.status).toBe('error');
      expect(result.compiled_code).toBe('select * from raw.orders');
    });

    test('reports a helpful error when the model is missing', () => {
      const result = queryRunResultsData(failingRun, 'model', 'nonexistent');
      expect(result).toContain('not found');
    });

    test('reports a helpful error when no model name is given', () => {
      const result = queryRunResultsData(failingRun, 'model');
      expect(result).toContain('Provide a model name');
    });
  });

  test('unknown query type returns an explicit error', () => {
    const result = queryRunResultsData(failingRun, 'bogus');
    expect(result).toContain('Unknown query type');
  });

  // Token-economy guard: this is the whole point of the tool. A clean-run summary
  // must be small enough that /investigate's first call costs almost nothing.
  test('summary output for a clean 200-result run is under 2KB', () => {
    const bigClean: RunResults = {
      metadata: { generated_at: '2026-05-25T08:32:49Z' },
      results: Array.from({ length: 200 }, (_, i) => r('success', `model_${i}`)),
      elapsed_time: 60,
    };
    const result = queryRunResultsData(bigClean, 'summary');
    expect(result.length).toBeLessThan(2000);
  });
});
