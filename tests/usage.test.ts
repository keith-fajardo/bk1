import { describe, expect, test } from 'bun:test';
import {
  classifyTurnLabel,
  createUsageState,
  recordUsage,
  buildReport,
  renderReport,
} from '../src/usage';

const SONNET = 'claude-sonnet-4-6';
const HAIKU  = 'claude-haiku-4-5-20251001';

describe('classifyTurnLabel', () => {
  test('extracts the slash-command from a leading /command', () => {
    expect(classifyTurnLabel('/lint-deep')).toBe('/lint-deep');
    expect(classifyTurnLabel('/kimball review fct_invoices')).toBe('/kimball');
    expect(classifyTurnLabel('  /impact stg_orders.customer_id+  ')).toBe('/impact');
  });

  test('lowercases the command (so /Lint and /lint bucket together)', () => {
    expect(classifyTurnLabel('/LINT-DEEP')).toBe('/lint-deep');
  });

  test('free-form messages collapse to "chat"', () => {
    expect(classifyTurnLabel('explain this code')).toBe('chat');
    expect(classifyTurnLabel('')).toBe('chat');
    expect(classifyTurnLabel('   ')).toBe('chat');
  });

  test('lone "/" (no command) is treated as chat, not a phantom empty command', () => {
    // Edge case: if classifyTurnLabel returned "/" the bucket key would be ambiguous
    // and the report row would look broken. Force it to "chat" so the report stays readable.
    expect(classifyTurnLabel('/')).toBe('chat');
    expect(classifyTurnLabel('/   ')).toBe('chat');
  });
});

describe('recordUsage + buildReport', () => {
  test('groups buckets by (turn, sub-agent, model) and tallies calls', () => {
    const state = createUsageState();
    // Two main-agent calls for the same turn — should fold into one bucket with calls=2.
    recordUsage(state, { turnLabel: '/lint-deep', model: SONNET, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 });
    recordUsage(state, { turnLabel: '/lint-deep', model: SONNET, input: 500,  output: 100, cacheRead: 0, cacheWrite: 0 });
    const report = buildReport(state);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.turnLabel).toBe('/lint-deep');
    expect(report.rows[0]!.calls).toBe(2);
    expect(report.rows[0]!.input).toBe(1500);
    expect(report.rows[0]!.output).toBe(300);
  });

  test('sub-agents are nested under their parent turn, not top-level rows', () => {
    // The whole point of the nested view: /lint-deep with two sub-agents should
    // appear as one top-level row with two child rows, not three peers.
    const state = createUsageState();
    recordUsage(state, { turnLabel: '/lint-deep', model: SONNET, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 });
    recordUsage(state, { turnLabel: '/lint-deep', subAgentLabel: 'Semantic: description quality', model: HAIKU, input: 500, output: 100, cacheRead: 0, cacheWrite: 0 });
    recordUsage(state, { turnLabel: '/lint-deep', subAgentLabel: 'Semantic: staging joins',       model: HAIKU, input: 800, output: 150, cacheRead: 0, cacheWrite: 0 });
    const report = buildReport(state);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.subAgents).toHaveLength(2);
    expect(report.rows[0]!.subAgents.map(s => s.subAgentLabel).sort()).toEqual([
      'Semantic: description quality',
      'Semantic: staging joins',
    ]);
  });

  test('rows are sorted by total cost descending (answers "most expensive first")', () => {
    const state = createUsageState();
    // /kimball: small Sonnet call
    recordUsage(state, { turnLabel: '/kimball', model: SONNET, input: 500, output: 100, cacheRead: 0, cacheWrite: 0 });
    // /lint-deep: bigger Sonnet call + Haiku sub-agents
    recordUsage(state, { turnLabel: '/lint-deep', model: SONNET, input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0 });
    recordUsage(state, { turnLabel: '/lint-deep', subAgentLabel: 'rule A', model: HAIKU, input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 });
    // chat: small
    recordUsage(state, { turnLabel: 'chat', model: SONNET, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
    const report = buildReport(state);
    expect(report.rows.map(r => r.turnLabel)).toEqual(['/lint-deep', '/kimball', 'chat']);
    // Sanity: top row really is more expensive.
    expect(report.rows[0]!.usd).toBeGreaterThan(report.rows[1]!.usd);
  });

  test('turn USD includes sub-agent costs (so the sort key reflects total spend)', () => {
    // If a turn's USD only counted the main agent's spend, a /lint-deep that fires
    // dozens of Haiku sub-agents would rank lower than a single /kimball call —
    // which would mislead the user about where their tokens actually went.
    const state = createUsageState();
    recordUsage(state, { turnLabel: '/lint-deep', model: SONNET, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
    recordUsage(state, { turnLabel: '/lint-deep', subAgentLabel: 'big sub', model: HAIKU, input: 10000, output: 2000, cacheRead: 0, cacheWrite: 0 });
    const report = buildReport(state);
    const turn = report.rows[0]!;
    const mainOnly = 100 * (3 / 1_000_000) + 20 * (15 / 1_000_000);
    expect(turn.usd).toBeGreaterThan(mainOnly);
  });

  test('totals sum every call across rows AND nested sub-agents', () => {
    // Regression target: an earlier draft accidentally double-counted (or skipped)
    // sub-agent tokens in the totals row. Pin the arithmetic.
    const state = createUsageState();
    recordUsage(state, { turnLabel: '/lint-deep', model: SONNET, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
    recordUsage(state, { turnLabel: '/lint-deep', subAgentLabel: 'A', model: HAIKU, input: 200, output: 30, cacheRead: 0, cacheWrite: 0 });
    recordUsage(state, { turnLabel: '/lint-deep', subAgentLabel: 'B', model: HAIKU, input: 300, output: 40, cacheRead: 0, cacheWrite: 0 });
    const r = buildReport(state);
    expect(r.totals.input).toBe(600);
    expect(r.totals.output).toBe(90);
    expect(r.totals.calls).toBe(3);
  });

  test('a turn that used both Sonnet and Haiku in the main agent is billed correctly per portion', () => {
    // This can happen if /model is switched mid-turn (rare but real). The main-agent bucket
    // would split into two — one per model — and we sum cost per bucket at the bucket's
    // own model rate, not a blended rate.
    const state = createUsageState();
    recordUsage(state, { turnLabel: 'chat', model: SONNET, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }); // $3
    recordUsage(state, { turnLabel: 'chat', model: HAIKU,  input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }); // $1
    const r = buildReport(state);
    expect(r.rows[0]!.usd).toBeCloseTo(4, 2);
  });
});

describe('renderReport', () => {
  test('empty state produces a friendly "no usage yet" message', () => {
    const out = renderReport(buildReport(createUsageState()));
    expect(out).toContain('No usage recorded');
  });

  test('rendered report includes the turn label, totals row, and the billing URL', () => {
    // The billing URL line is the user's fallback for actual remaining credit (since
    // our numbers are local estimates). It must always appear at the bottom of /usage.
    const state = createUsageState();
    recordUsage(state, { turnLabel: '/lint-deep', model: SONNET, input: 500, output: 100, cacheRead: 0, cacheWrite: 0 });
    const out = renderReport(buildReport(state));
    expect(out).toContain('/lint-deep');
    expect(out).toContain('TOTAL');
    expect(out).toContain('console.anthropic.com/settings/billing');
  });

  test('sub-agent rows are indented under their parent turn (visual nesting contract)', () => {
    const state = createUsageState();
    recordUsage(state, { turnLabel: '/lint-deep', model: SONNET, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
    recordUsage(state, { turnLabel: '/lint-deep', subAgentLabel: 'rule A', model: HAIKU, input: 500, output: 100, cacheRead: 0, cacheWrite: 0 });
    const out = renderReport(buildReport(state));
    // The sub-agent row uses the "└" connector. If that regresses, nesting becomes invisible.
    expect(out).toContain('└');
    expect(out).toContain('rule A');
  });
});
