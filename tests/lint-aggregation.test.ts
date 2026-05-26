import { describe, expect, test } from 'bun:test';
import { aggregateViolations, type LintOutput, type LintViolation } from '../src/state';

function v(code: string, severity: string, file: string): LintViolation {
  return { code, rule: 'rule text', severity, file, evidence: 'ev', fix: 'fix' };
}

const fixture: LintOutput = {
  project_name: 'test',
  summary: { total: 5, by_severity: { major: 1, minor: 4 }, by_rule: {} },
  violations: [
    v('mart_naming',         'major', 'models/marts/common/lkp_appt_preferences.sql'),
    v('staging_cast',        'minor', 'models/staging/stg_a.sql'),
    v('staging_cast',        'minor', 'models/staging/stg_b.sql'),
    v('scd_type',            'minor', 'models/marts/core/finance/dim/dim_x.yml'),
    v('int_materialization', 'minor', 'models/intermediate/int_y.sql'),
  ],
  semantic_review_queue: [
    'models/marts/core/finance/dim/dim_x.yml',
    'models/staging/stg_a.yml',
  ],
};

describe('aggregateViolations', () => {
  // The original bug: a single major violation on a model whose lint_status was 'violations'
  // (and therefore excluded from the batch) disappeared from the displayed summary table.
  // project_by_rule must always reflect the full project, irrespective of batch membership.
  test('project_by_rule contains every code regardless of batch membership', () => {
    const result = aggregateViolations(fixture, new Set(['models/staging/stg_a.sql']));
    const codes = result.projectByRule.map(r => r.code);
    expect(codes).toContain('mart_naming');
    expect(codes).toContain('staging_cast');
    expect(codes).toContain('scd_type');
    expect(codes).toContain('int_materialization');
  });

  test('project_by_rule sorts major before minor', () => {
    const result = aggregateViolations(fixture, new Set());
    expect(result.projectByRule[0]!.severity).toBe('major');
    expect(result.projectByRule[0]!.code).toBe('mart_naming');
  });

  test('within a severity, higher counts come first', () => {
    const result = aggregateViolations(fixture, new Set());
    const minors = result.projectByRule.filter(r => r.severity === 'minor');
    expect(minors.map(m => m.code)).toEqual(['staging_cast', 'scd_type', 'int_materialization']);
    expect(minors[0]!.count).toBe(2);
  });

  test('batch_by_rule includes only violations whose file is in the batch set', () => {
    const result = aggregateViolations(
      fixture,
      new Set(['models/staging/stg_a.sql', 'models/staging/stg_b.sql']),
    );
    expect(result.batchByRule.map(r => r.code)).toEqual(['staging_cast']);
    expect(result.batchByRule[0]!.count).toBe(2);
  });

  test('batchViolations contains only violations from the batch set', () => {
    const result = aggregateViolations(
      fixture,
      new Set(['models/intermediate/int_y.sql']),
    );
    expect(result.batchViolations).toHaveLength(1);
    expect(result.batchViolations[0]!.code).toBe('int_materialization');
  });

  test('semanticQueue is intersected with the batch set', () => {
    const result = aggregateViolations(
      fixture,
      new Set(['models/staging/stg_a.sql', 'models/staging/stg_a.yml']),
    );
    expect(result.semanticQueue).toEqual(['models/staging/stg_a.yml']);
  });

  test('empty input produces empty aggregates', () => {
    const empty: LintOutput = { ...fixture, violations: [], semantic_review_queue: [] };
    const result = aggregateViolations(empty, new Set(['models/anything.sql']));
    expect(result.projectByRule).toEqual([]);
    expect(result.batchByRule).toEqual([]);
    expect(result.batchViolations).toEqual([]);
    expect(result.semanticQueue).toEqual([]);
  });

  test('blocker severity sorts before major', () => {
    const withBlocker: LintOutput = {
      ...fixture,
      violations: [
        v('staging_cast', 'minor',   'a.sql'),
        v('mart_naming',  'major',   'b.sql'),
        v('boom',         'blocker', 'c.sql'),
      ],
    };
    const result = aggregateViolations(withBlocker, new Set());
    expect(result.projectByRule.map(r => r.severity)).toEqual(['blocker', 'major', 'minor']);
  });
});
