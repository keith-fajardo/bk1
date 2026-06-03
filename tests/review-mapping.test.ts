import { describe, expect, test } from 'bun:test';
import {
  parseUnifiedDiff,
  matchFindingToLine,
  extractFindingsArray,
  parseLintRun,
  computeHealthScore,
  buildReviewPayload,
  severityRank,
  type Finding,
  type Findings,
} from '../src/review-mapping';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'models/staging/stg_orders.sql',
    severity: 'major',
    evidence: 'select * from raw.orders',
    suggested_fix: 'enumerate columns',
    check_type: 'semantic',
    rule: 'select_star',
    ...over,
  };
}

describe('parseUnifiedDiff', () => {
  test('records added lines with correct new-file line numbers', () => {
    const diff = [
      'diff --git a/models/a.sql b/models/a.sql',
      '--- a/models/a.sql',
      '+++ b/models/a.sql',
      '@@ -1,2 +1,3 @@',
      ' with renamed as (',
      '+  select id, name',
      '   from {{ ref("x") }}',
      '+)',
    ].join('\n');
    const map = parseUnifiedDiff(diff);
    const lines = map.get('models/a.sql')!;
    expect(lines).toEqual([
      { newLine: 2, text: '  select id, name' },
      { newLine: 4, text: ')' },
    ]);
  });

  test('handles multiple files and multiple hunks', () => {
    const diff = [
      '+++ b/models/a.sql',
      '@@ -1 +1,1 @@',
      '+line a1',
      '+++ b/models/b.sql',
      '@@ -10,0 +10,2 @@',
      '+line b10',
      '+line b11',
    ].join('\n');
    const map = parseUnifiedDiff(diff);
    expect(map.get('models/a.sql')).toEqual([{ newLine: 1, text: 'line a1' }]);
    expect(map.get('models/b.sql')).toEqual([
      { newLine: 10, text: 'line b10' },
      { newLine: 11, text: 'line b11' },
    ]);
  });

  test('removed lines do not advance the new-file counter', () => {
    const diff = [
      '+++ b/models/a.sql',
      '@@ -1,3 +1,2 @@',
      ' ctx1',
      '-removed',
      '+added',
    ].join('\n');
    const map = parseUnifiedDiff(diff);
    expect(map.get('models/a.sql')).toEqual([{ newLine: 2, text: 'added' }]);
  });

  test('pure deletion (+++ /dev/null) contributes no added lines', () => {
    const diff = ['--- a/models/gone.sql', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n');
    const map = parseUnifiedDiff(diff);
    expect([...map.keys()]).not.toContain('models/gone.sql');
  });

  test('a file with only context/removed lines has an empty added-line list', () => {
    const diff = ['+++ b/models/a.sql', '@@ -1,2 +1,2 @@', ' a', '-b', '+a', ' c'].join('\n');
    // line: +a maps to new line 2 here
    const map = parseUnifiedDiff(diff);
    expect(map.get('models/a.sql')).toEqual([{ newLine: 2, text: 'a' }]);
  });
});

describe('matchFindingToLine', () => {
  const diff = parseUnifiedDiff(
    ['+++ b/models/staging/stg_orders.sql', '@@ -1,0 +1,3 @@', '+  select *', '+  from raw.orders', '+  where 1=1'].join('\n'),
  );

  test('exact (normalized) line match', () => {
    expect(matchFindingToLine(finding({ evidence: 'from raw.orders' }), diff)).toBe(2);
  });

  test('substring match (evidence is a fragment of the line)', () => {
    expect(matchFindingToLine(finding({ evidence: 'raw.orders' }), diff)).toBe(2);
  });

  test('whitespace-insensitive match', () => {
    expect(matchFindingToLine(finding({ evidence: 'select   *' }), diff)).toBe(1);
  });

  test('descriptive evidence that is not in any line returns null', () => {
    expect(matchFindingToLine(finding({ evidence: 'filename: BadName.sql' }), diff)).toBeNull();
  });

  test('a file absent from the diff returns null', () => {
    expect(matchFindingToLine(finding({ file: 'models/marts/dim_x.sql', evidence: 'select *' }), diff)).toBeNull();
  });

  test('project-dir prefix bridges project-relative findings to repo-relative diff', () => {
    const subdirDiff = parseUnifiedDiff(
      ['+++ b/analytics/models/staging/stg_orders.sql', '@@ -1,0 +1,1 @@', '+  select * from raw.orders'].join('\n'),
    );
    // Without the prefix the path won't match; with it, it resolves.
    expect(matchFindingToLine(finding({ evidence: 'raw.orders' }), subdirDiff)).toBeNull();
    expect(matchFindingToLine(finding({ evidence: 'raw.orders' }), subdirDiff, 'analytics')).toBe(1);
  });
});

describe('parseLintRun', () => {
  const full = JSON.stringify({
    project_name: 'demoproj',
    violations: {
      details: [
        { code: 'staging_cast', rule: 'cast rule', severity: 'minor', file: 'models/staging/stg_a.sql', evidence: 'No cast', suggested_fix: 'add cast', check_type: 'mechanical' },
      ],
    },
    semantic_review_queue: ['models/staging/stg_a.sql', 'models/staging/stg_a.yml'],
  });

  test('extracts mechanical findings (code → rule), queue, and project name', () => {
    const { mechanical, semanticQueue, projectName } = parseLintRun(full);
    expect(projectName).toBe('demoproj');
    expect(semanticQueue).toEqual(['models/staging/stg_a.sql', 'models/staging/stg_a.yml']);
    expect(mechanical).toHaveLength(1);
    expect(mechanical[0]).toMatchObject({ rule: 'staging_cast', check_type: 'mechanical', severity: 'minor' });
  });

  test('nothing_to_lint yields no findings and an empty queue', () => {
    const { mechanical, semanticQueue } = parseLintRun(JSON.stringify({ nothing_to_lint: true, project_name: 'p' }));
    expect(mechanical).toEqual([]);
    expect(semanticQueue).toEqual([]);
  });

  test('an error response throws', () => {
    expect(() => parseLintRun(JSON.stringify({ error: 'binary_not_found', message: 'no binary' }))).toThrow(/lint_run failed/i);
  });
});

describe('computeHealthScore', () => {
  test('0 rule checks → 100', () => {
    expect(computeHealthScore([], 0)).toBe(100);
  });

  test('one minor over one check → round(100·(1−1/3)) = 67', () => {
    expect(computeHealthScore([{ severity: 'minor' } as Finding], 1)).toBe(67);
  });

  test('clamps to 0 (penalty exceeds max)', () => {
    const blockers = [{ severity: 'blocker' }, { severity: 'blocker' }] as Finding[];
    expect(computeHealthScore(blockers, 1)).toBe(0);
  });
});

describe('extractFindingsArray', () => {
  test('parses a fenced json array and forces check_type=semantic', () => {
    const text = 'sub-agent merge\n```json\n[{"file":"a.sql","severity":"major","evidence":"join x","suggested_fix":"move","rule":"staging_transformation"}]\n```';
    const arr = extractFindingsArray(text);
    expect(arr).toHaveLength(1);
    expect(arr[0]!.check_type).toBe('semantic');
  });

  test('empty array is valid', () => {
    expect(extractFindingsArray('```json\n[]\n```')).toEqual([]);
  });

  test('throws when the json is an object, not an array', () => {
    expect(() => extractFindingsArray('```json\n{"findings":[]}\n```')).toThrow(/not an array/i);
  });

  test('throws when no fence is present', () => {
    expect(() => extractFindingsArray('no fence')).toThrow(/no .*json block/i);
  });
});

describe('severityRank', () => {
  test('ranks blocker > major > minor, unknown = 0', () => {
    expect(severityRank('blocker')).toBeGreaterThan(severityRank('major'));
    expect(severityRank('major')).toBeGreaterThan(severityRank('minor'));
    expect(severityRank('minor')).toBeGreaterThan(severityRank('nonsense'));
    expect(severityRank('nonsense')).toBe(0);
  });
});

describe('buildReviewPayload', () => {
  const diff = parseUnifiedDiff(
    ['+++ b/models/staging/stg_orders.sql', '@@ -1,0 +1,1 @@', '+  select * from raw.orders'].join('\n'),
  );

  function findings(list: Finding[]): Findings {
    return { project_name: 'demo', health_score: 70, generated_at: 't', findings: list };
  }

  test('mapped findings become inline comments, unmapped go to the summary body', () => {
    const payload = buildReviewPayload(
      findings([
        finding({ evidence: 'raw.orders' }),                       // maps to line 1
        finding({ file: 'models/marts/dim_x.sql', evidence: 'filename: dim_x.sql', rule: 'naming' }), // unmapped
      ]),
      diff,
    );
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({ path: 'models/staging/stg_orders.sql', line: 1, side: 'RIGHT' });
    expect(payload.body).toContain('Findings not on changed lines');
    expect(payload.body).toContain('models/marts/dim_x.sql');
  });

  test('inline comments are prefixed with the repo-relative path under a prefix', () => {
    const subdirDiff = parseUnifiedDiff(
      ['+++ b/analytics/models/staging/stg_orders.sql', '@@ -1,0 +1,1 @@', '+  select * from raw.orders'].join('\n'),
    );
    const payload = buildReviewPayload(findings([finding({ evidence: 'raw.orders' })]), subdirDiff, 'analytics');
    expect(payload.comments[0]!.path).toBe('analytics/models/staging/stg_orders.sql');
  });

  test('all-mapped findings produce an "attached inline" body', () => {
    const payload = buildReviewPayload(findings([finding({ evidence: 'raw.orders' })]), diff);
    expect(payload.body).toContain('attached inline');
    expect(payload.comments).toHaveLength(1);
  });

  test('comments are emitted in severity order (blocker first)', () => {
    const twoLineDiff = parseUnifiedDiff(
      ['+++ b/models/staging/stg_orders.sql', '@@ -1,0 +1,2 @@', '+  minor line', '+  blocker line'].join('\n'),
    );
    const payload = buildReviewPayload(
      findings([
        finding({ evidence: 'minor line', severity: 'minor' }),
        finding({ evidence: 'blocker line', severity: 'blocker' }),
      ]),
      twoLineDiff,
    );
    expect(payload.comments[0]!.body).toContain('blocker');
    expect(payload.comments[1]!.body).toContain('minor');
  });
});
