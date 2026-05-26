import { describe, expect, test } from 'bun:test';
import { rateFor, estimateCostUsd, formatUsd, MODEL_RATES } from '../src/pricing';

describe('rateFor', () => {
  test('resolves exact model IDs', () => {
    expect(rateFor('claude-sonnet-4-6')).toEqual(MODEL_RATES['claude-sonnet-4-6']!);
    expect(rateFor('claude-haiku-4-5-20251001')).toEqual(MODEL_RATES['claude-haiku-4-5-20251001']!);
    expect(rateFor('claude-opus-4-7')).toEqual(MODEL_RATES['claude-opus-4-7']!);
  });

  test('strips date suffix and resolves the base ID', () => {
    // Anthropic appends -YYYYMMDD to specific snapshots. If a user pins
    // claude-sonnet-4-6-20260101, we still want Sonnet pricing — not "unknown → 0".
    const r = rateFor('claude-sonnet-4-6-20260101');
    expect(r).not.toBeNull();
    expect(r!.input).toBe(3);
    expect(r!.output).toBe(15);
  });

  test('falls back to tier classification by family name', () => {
    // Future-proofing: if Anthropic ships "claude-sonnet-5-0" before we update the table,
    // we should still bill it at Sonnet rates rather than silently returning 0 cost.
    expect(rateFor('claude-sonnet-5-0')?.input).toBe(3);
    expect(rateFor('claude-opus-5-0')?.input).toBe(15);
    expect(rateFor('claude-haiku-5-0')?.input).toBe(1);
  });

  test('returns null for completely unknown models so the caller can fail soft', () => {
    expect(rateFor('gpt-4')).toBeNull();
    expect(rateFor('unknown-model')).toBeNull();
  });
});

describe('estimateCostUsd', () => {
  test('input + output billed at published rates', () => {
    // 1M input + 1M output on Sonnet = $3 + $15 = $18.
    const cost = estimateCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(18, 6);
  });

  test('cache reads are billed at 10% of input rate (load-bearing pricing contract)', () => {
    // 1M cache-read tokens on Sonnet = $3 × 10% = $0.30. If this regresses to full-rate,
    // the banner UNDER-reports savings (or worse, claims caching costs as much as input).
    const cost = estimateCostUsd(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.30, 6);
  });

  test('cache writes are billed at 1.25× input rate', () => {
    // 1M cache-write tokens on Sonnet = $3 × 1.25 = $3.75.
    const cost = estimateCostUsd(
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(3.75, 6);
  });

  test('Haiku sub-agent calls cost ~3× less than Sonnet on the same input volume', () => {
    // Important sanity check: the whole reason for routing sub-agents to Haiku is cost.
    // If this ratio breaks, sub-agents are charged at Sonnet rates and the savings vanish.
    const sonnet = estimateCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-sonnet-4-6');
    const haiku  = estimateCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-4-5-20251001');
    expect(sonnet / haiku).toBeCloseTo(3, 1);
  });

  test('returns 0 for unknown model (fails soft, never NaN)', () => {
    // Critical UX contract: a missing model in MODEL_RATES must NOT produce NaN in the
    // banner. NaN propagates through React rendering as "$NaN" which looks broken.
    const cost = estimateCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      'totally-not-a-real-model',
    );
    expect(cost).toBe(0);
    expect(Number.isNaN(cost)).toBe(false);
  });

  test('handles realistic small token counts without floating-point drift', () => {
    // A typical short turn might be ~500 input + ~100 output tokens. Make sure we don't
    // produce wild values from sub-cent arithmetic.
    const cost = estimateCostUsd(
      { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
      'claude-sonnet-4-6',
    );
    // 500 × (3/1M) + 100 × (15/1M) = 0.0015 + 0.0015 = 0.003
    expect(cost).toBeCloseTo(0.003, 6);
  });
});

describe('formatUsd', () => {
  test('zero shows $0.00 (not "<$0.01") — distinguishes "no usage" from "tiny usage"', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-1)).toBe('$0.00');
  });

  test('sub-cent amounts show <$0.01 instead of rounding to $0.00', () => {
    // Important during light usage — if the banner showed "$0.00" indefinitely, users
    // would assume cost tracking was broken.
    expect(formatUsd(0.003)).toBe('<$0.01');
    expect(formatUsd(0.009)).toBe('<$0.01');
  });

  test('cents-range amounts use 3 decimals for resolution', () => {
    expect(formatUsd(0.123)).toBe('$0.123');
    expect(formatUsd(0.999)).toBe('$0.999');
  });

  test('dollar-range amounts use 2 decimals', () => {
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(42.5)).toBe('$42.50');
  });

  test('large amounts drop decimals (signal-to-noise)', () => {
    expect(formatUsd(1234)).toBe('$1234');
  });
});
