// Per-model pricing for the session-spend estimate shown in the banner.
//
// Anthropic does NOT expose remaining credit via the public API, so the banner shows an
// estimated spend computed locally from observed token usage × these rates. Treat it as
// a ~5-10% approximation: the SDK reports tokens reliably, but our rate table can drift
// if Anthropic adjusts pricing without us updating this file.
//
// Rates are USD per million tokens. Cache reads are charged at 10% of input. Cache writes
// (5-min ephemeral) are charged at 1.25× input. Source: anthropic.com/api → Pricing page;
// last reviewed against published rates as of the most recent edit to this file.

export interface ModelRate {
  // USD per million tokens.
  input: number;
  output: number;
  // Multipliers applied to `input` to derive cache pricing. Documented separately so a
  // future change to "cache reads are 10%" doesn't require touching every model row.
  cacheReadMul: number;
  cacheWriteMul: number;
}

const SONNET_TIER: ModelRate = {
  input: 3, output: 15, cacheReadMul: 0.10, cacheWriteMul: 1.25,
};
const HAIKU_TIER: ModelRate = {
  input: 1, output: 5, cacheReadMul: 0.10, cacheWriteMul: 1.25,
};
const OPUS_TIER: ModelRate = {
  input: 15, output: 75, cacheReadMul: 0.10, cacheWriteMul: 1.25,
};

// Concrete model IDs → rate tier. Aliases and version suffixes are normalized below so
// "claude-sonnet-4-6" and "claude-sonnet-4-6-20250101" both resolve to SONNET_TIER.
export const MODEL_RATES: Record<string, ModelRate> = {
  'claude-sonnet-4-6':           SONNET_TIER,
  'claude-sonnet-4-5':           SONNET_TIER,
  'claude-haiku-4-5':            HAIKU_TIER,
  'claude-haiku-4-5-20251001':   HAIKU_TIER,
  'claude-opus-4-7':             OPUS_TIER,
  'claude-opus-4-6':             OPUS_TIER,
  'claude-opus-4-5':             OPUS_TIER,
};

// Resolves a model ID (possibly with date suffix or unknown version) to its rate by
// stripping trailing -YYYYMMDD-ish segments and falling back through known prefixes.
export function rateFor(model: string): ModelRate | null {
  if (MODEL_RATES[model]) return MODEL_RATES[model]!;
  // Strip date suffix (e.g. "claude-sonnet-4-6-20250101" → "claude-sonnet-4-6").
  const dateStripped = model.replace(/-\d{8}$/, '');
  if (MODEL_RATES[dateStripped]) return MODEL_RATES[dateStripped]!;
  // Last-resort tier classification by family name.
  if (/opus/.test(model))   return OPUS_TIER;
  if (/sonnet/.test(model)) return SONNET_TIER;
  if (/haiku/.test(model))  return HAIKU_TIER;
  return null;
}

export interface TokenSplit {
  input: number;       // billed at rate.input
  output: number;      // billed at rate.output
  cacheRead: number;   // billed at rate.input × rate.cacheReadMul
  cacheWrite: number;  // billed at rate.input × rate.cacheWriteMul
}

// Computes USD cost from a token split + model. Returns 0 (not NaN) when the model
// is unknown — failing soft so the UI never displays "NaN" or "$undefined" to users.
export function estimateCostUsd(tokens: TokenSplit, model: string): number {
  const rate = rateFor(model);
  if (!rate) return 0;
  const perTokenInput  = rate.input  / 1_000_000;
  const perTokenOutput = rate.output / 1_000_000;
  return (
    tokens.input      * perTokenInput +
    tokens.output     * perTokenOutput +
    tokens.cacheRead  * perTokenInput * rate.cacheReadMul +
    tokens.cacheWrite * perTokenInput * rate.cacheWriteMul
  );
}

// Formats USD for terminal display. Sub-cent amounts show "<$0.01" rather than rounding
// to $0.00 — important during light usage when the user wants confirmation that tracking is on.
export function formatUsd(amount: number): string {
  if (amount <= 0) return '$0.00';
  if (amount < 0.01) return '<$0.01';
  if (amount < 1)    return `$${amount.toFixed(3)}`;
  if (amount < 100)  return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(0)}`;
}
