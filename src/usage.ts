// Session-scoped token-usage attribution for the /usage command.
//
// Each LLM call gets attributed to two labels:
//   - turn:    the slash-command that initiated the user turn (e.g. "/lint-deep"), or
//              "chat" for free-form messages.
//   - subAgent: optional — the `description` field of the sub-agent invocation if the
//              call came from one. Lets us break /lint-deep's cost down into
//              "Semantic: description quality" vs "Semantic: staging joins" rows.
//
// The aggregator is pure: it consumes recorded events and produces a renderable report.
// State lives in app.tsx (a ref) — this module just defines the shape + transforms.

import { estimateCostUsd, formatUsd } from './pricing';

export interface UsageEvent {
  turnLabel: string;            // "/lint-deep" | "/kimball" | "chat" | ...
  subAgentLabel?: string;       // present only when the call came from a sub-agent
  model: string;                // actual model used (Sonnet, Haiku, Opus)
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Buckets accumulate at two granularities so the report can show nested rows. We key
// turn buckets by turnLabel alone (main-agent calls for that turn) and sub-agent buckets
// by `${turnLabel}::${subAgentLabel}::${model}` so multiple sub-agents under the same
// turn are tracked separately.
export interface UsageBucket {
  turnLabel: string;
  subAgentLabel: string | null;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;                // number of API calls aggregated into this bucket
}

export interface UsageState {
  buckets: Map<string, UsageBucket>;
}

export function createUsageState(): UsageState {
  return { buckets: new Map() };
}

// Bucket key derives from (turnLabel, subAgentLabel|null, model). Including model
// means a /lint-deep turn that fires both Sonnet (main) and Haiku (sub-agents) gets
// separate rows for each — important because cost differs 3×.
function keyFor(turnLabel: string, subAgentLabel: string | null, model: string): string {
  return `${turnLabel}${subAgentLabel ?? ''}${model}`;
}

export function recordUsage(state: UsageState, evt: UsageEvent): void {
  const subAgentLabel = evt.subAgentLabel ?? null;
  const k = keyFor(evt.turnLabel, subAgentLabel, evt.model);
  const existing = state.buckets.get(k);
  if (existing) {
    existing.input      += evt.input;
    existing.output     += evt.output;
    existing.cacheRead  += evt.cacheRead;
    existing.cacheWrite += evt.cacheWrite;
    existing.calls      += 1;
    return;
  }
  state.buckets.set(k, {
    turnLabel: evt.turnLabel,
    subAgentLabel,
    model: evt.model,
    input: evt.input,
    output: evt.output,
    cacheRead: evt.cacheRead,
    cacheWrite: evt.cacheWrite,
    calls: 1,
  });
}

// Renderable rows: one per turn (main-agent calls aggregated across all models used),
// plus child rows for each sub-agent label under that turn.
export interface TurnRow {
  turnLabel: string;
  calls: number;                // main-agent calls for this turn (sum across models)
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
  subAgents: SubAgentRow[];     // empty when the turn fired no sub-agents
}

export interface SubAgentRow {
  subAgentLabel: string;
  model: string;                // sub-agents are typically Haiku, but record it explicitly
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

export interface UsageReport {
  rows: TurnRow[];              // sorted by usd descending (most expensive first)
  totals: {
    turns: number;              // distinct turn labels
    calls: number;              // total API calls (main + sub-agent)
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    usd: number;
  };
}

export function buildReport(state: UsageState): UsageReport {
  // First pass: group buckets by turnLabel; separate main-agent buckets from sub-agent ones.
  const byTurn = new Map<string, { mains: UsageBucket[]; subs: UsageBucket[] }>();
  for (const b of state.buckets.values()) {
    const entry = byTurn.get(b.turnLabel) ?? { mains: [], subs: [] };
    if (b.subAgentLabel === null) entry.mains.push(b);
    else                          entry.subs.push(b);
    byTurn.set(b.turnLabel, entry);
  }

  const rows: TurnRow[] = [];
  for (const [turnLabel, { mains, subs }] of byTurn) {
    // Roll up main-agent buckets across models. Cost summed per bucket (each bucket has
    // its own model) so a turn that used both Sonnet and Haiku for the main agent gets
    // correctly billed at the right rate per portion.
    let mainCalls = 0, mainIn = 0, mainOut = 0, mainCR = 0, mainCW = 0, mainUsd = 0;
    for (const b of mains) {
      mainCalls += b.calls;
      mainIn    += b.input;
      mainOut   += b.output;
      mainCR    += b.cacheRead;
      mainCW    += b.cacheWrite;
      mainUsd   += estimateCostUsd({ input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite }, b.model);
    }

    const subRows: SubAgentRow[] = subs.map(b => ({
      subAgentLabel: b.subAgentLabel!,
      model: b.model,
      calls: b.calls,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      usd: estimateCostUsd({ input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite }, b.model),
    }));
    subRows.sort((a, b) => b.usd - a.usd);
    const subUsdTotal = subRows.reduce((s, r) => s + r.usd, 0);

    rows.push({
      turnLabel,
      calls: mainCalls,
      input: mainIn,
      output: mainOut,
      cacheRead: mainCR,
      cacheWrite: mainCW,
      usd: mainUsd + subUsdTotal,
      subAgents: subRows,
    });
  }

  // Most expensive first — that's the answer to "which command burns the most tokens."
  rows.sort((a, b) => b.usd - a.usd);

  let totalCalls = 0, totalIn = 0, totalOut = 0, totalCR = 0, totalCW = 0, totalUsd = 0;
  for (const r of rows) {
    totalCalls += r.calls;
    totalIn    += r.input;
    totalOut   += r.output;
    totalCR    += r.cacheRead;
    totalCW    += r.cacheWrite;
    totalUsd   += r.usd;
    for (const s of r.subAgents) {
      totalCalls += s.calls;
      totalIn    += s.input;
      totalOut   += s.output;
      totalCR    += s.cacheRead;
      totalCW    += s.cacheWrite;
    }
  }

  return {
    rows,
    totals: {
      turns: rows.length,
      calls: totalCalls,
      input: totalIn,
      output: totalOut,
      cacheRead: totalCR,
      cacheWrite: totalCW,
      usd: totalUsd,
    },
  };
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Plain-text rendering — injected as an assistant message into the bk1 chat history.
// We render plain text (not markdown table) so it stays readable in narrow terminals
// and across the existing message renderer.
export function renderReport(report: UsageReport): string {
  if (report.rows.length === 0) {
    return 'No usage recorded this session yet. Send a message or run a slash command first.';
  }

  const lines: string[] = ['Session token usage (most expensive first):', ''];

  for (const row of report.rows) {
    const parts = [
      `↑${fmtTokens(row.input)}`,
      `↓${fmtTokens(row.output)}`,
    ];
    if (row.cacheRead > 0)  parts.push(`${fmtTokens(row.cacheRead)} cached`);
    if (row.cacheWrite > 0) parts.push(`${fmtTokens(row.cacheWrite)} cw`);
    parts.push(`${row.calls} call${row.calls === 1 ? '' : 's'}`);
    parts.push(`~${formatUsd(row.usd)}`);
    lines.push(`  ${row.turnLabel.padEnd(20)} ${parts.join('  ·  ')}`);

    for (const sub of row.subAgents) {
      const subParts = [
        `↑${fmtTokens(sub.input)}`,
        `↓${fmtTokens(sub.output)}`,
      ];
      if (sub.cacheRead > 0)  subParts.push(`${fmtTokens(sub.cacheRead)} cached`);
      subParts.push(`${sub.calls} call${sub.calls === 1 ? '' : 's'}`);
      subParts.push(`~${formatUsd(sub.usd)}`);
      lines.push(`    └ ${sub.subAgentLabel.padEnd(18)} ${subParts.join('  ·  ')}`);
    }
  }

  lines.push('');
  const t = report.totals;
  const totalParts = [
    `↑${fmtTokens(t.input)}`,
    `↓${fmtTokens(t.output)}`,
  ];
  if (t.cacheRead > 0)  totalParts.push(`${fmtTokens(t.cacheRead)} cached`);
  if (t.cacheWrite > 0) totalParts.push(`${fmtTokens(t.cacheWrite)} cw`);
  totalParts.push(`${t.calls} calls`);
  totalParts.push(`~${formatUsd(t.usd)}`);
  lines.push(`  ${'TOTAL'.padEnd(20)} ${totalParts.join('  ·  ')}`);
  lines.push('');
  lines.push('Estimates are bk1-local (tokens × per-model rates). For actual remaining credit:');
  lines.push('  https://console.anthropic.com/settings/billing');
  return lines.join('\n');
}

// Classifies a raw user message into a turn label. Slash commands map to their command
// name; everything else collapses to "chat". Doing this here (rather than at submit time)
// keeps the rule in one place and testable.
export function classifyTurnLabel(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (trimmed.startsWith('/')) {
    const cmd = trimmed.slice(1).split(/\s+/)[0];
    if (cmd && cmd.length > 0) return `/${cmd.toLowerCase()}`;
  }
  return 'chat';
}
