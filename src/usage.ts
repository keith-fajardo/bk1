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

// ─── Organization-level usage (Admin API) ────────────────────────────────────

// Shape of the Admin Messages Usage Report response. Each time bucket in
// `data` carries a `results[]` array; when group_by[]=model is set, there's
// one entry per distinct model used in that bucket. Token counts live INSIDE
// each result, not on the bucket itself. Cache-creation tokens are split
// between 1h and 5m ephemeral entries — sum both for the total.
interface OrgUsageResult {
  model?: string | null;
  uncached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  output_tokens?: number;
}

interface OrgUsageBucket {
  starting_at?: string;
  ending_at?: string;
  results?: OrgUsageResult[];
}

interface OrgUsageResponse {
  data: OrgUsageBucket[];
}

interface OrgModelRate {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const ORG_RATES: Record<string, OrgModelRate> = {
  haiku:  { input: 1.00, cacheRead: 0.10, cacheWrite: 1.25, output: 5.00  },
  sonnet: { input: 3.00, cacheRead: 0.30, cacheWrite: 3.75, output: 15.00 },
  opus:   { input: 5.00, cacheRead: 0.50, cacheWrite: 6.25, output: 25.00 },
};

function classifyFamily(model: string): string {
  if (/haiku/i.test(model))  return 'haiku';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/opus/i.test(model))   return 'opus';
  return 'other';
}

function friendlyModelName(family: string): string {
  if (family === 'haiku')  return 'Haiku 4.5';
  if (family === 'sonnet') return 'Sonnet 4.6';
  if (family === 'opus')   return 'Opus 4.6/4.7';
  return family;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function costForFamily(
  family: string,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
): number {
  const rate = ORG_RATES[family];
  if (!rate) return 0;
  const m = 1_000_000;
  return (
    (input      / m) * rate.input +
    (cacheRead  / m) * rate.cacheRead +
    (cacheWrite / m) * rate.cacheWrite +
    (output     / m) * rate.output
  );
}

export async function fetchOrgUsage(adminKey: string): Promise<string> {
  const now = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day   = now.getUTCDate();
  const pad   = (n: number) => String(n).padStart(2, '0');
  const firstOfMonth = `${year}-${pad(month)}-01`;
  const today        = `${year}-${pad(month)}-${pad(day)}`;

  // limit=31 because bucket_width=1d defaults to 7 days (max 31). Without
  // this, requesting May 1–28 silently truncates to the last 7 days, so any
  // usage from the first three weeks of the month is invisible in the report.
  const url =
    `https://api.anthropic.com/v1/organizations/usage_report/messages` +
    `?starting_at=${firstOfMonth}T00:00:00Z` +
    `&ending_at=${today}T00:00:00Z` +
    `&bucket_width=1d` +
    `&limit=31` +
    `&group_by[]=model`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': adminKey,
      },
    });
  } catch (err) {
    return `Network error: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (resp.status === 401 || resp.status === 403) {
      return `Authentication failed (${resp.status}). Your Admin API key may be invalid or lack the required scope.\n${body}`;
    }
    return `API error (${resp.status}): ${body}`;
  }

  const json = await resp.json() as OrgUsageResponse;
  const buckets = json.data ?? [];
  if (buckets.length === 0) {
    return `No usage data returned for ${firstOfMonth} to ${today}. The organization may have no API calls this month.`;
  }

  // Aggregate per model family
  interface FamilyAgg {
    input: number; cacheRead: number; cacheWrite: number; output: number;
  }
  const byFamily = new Map<string, FamilyAgg>();
  const uniqueDays = new Set<string>();

  for (const b of buckets) {
    if (b.starting_at) uniqueDays.add(b.starting_at.slice(0, 10));
    for (const r of (b.results ?? [])) {
      const family = classifyFamily(r.model ?? '');
      const agg = byFamily.get(family) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      agg.input      += r.uncached_input_tokens ?? 0;
      agg.cacheRead  += r.cache_read_input_tokens ?? 0;
      agg.cacheWrite += (r.cache_creation?.ephemeral_1h_input_tokens ?? 0)
                     + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0);
      agg.output     += r.output_tokens ?? 0;
      byFamily.set(family, agg);
    }
  }

  // Compute costs
  let totalCost = 0;
  const familyRows: { name: string; agg: FamilyAgg; cost: number }[] = [];
  for (const [family, agg] of byFamily) {
    const cost = costForFamily(family, agg.input, agg.cacheRead, agg.cacheWrite, agg.output);
    totalCost += cost;
    familyRows.push({ name: friendlyModelName(family), agg, cost });
  }
  familyRows.sort((a, b) => b.cost - a.cost);

  // Buckets came back but every results[] was empty. Most common cause: the
  // Admin API key belongs to a different organization than the workspace
  // running the actual API calls, so the key sees zero usage even though the
  // user IS spending. Surfaces a hint instead of a silently-zero report.
  if (familyRows.length === 0) {
    return `No usage found for ${firstOfMonth} to ${today}.\n\n` +
      `If you're actively using the API, the most likely cause is that this ` +
      `Admin API key belongs to a different organization than the workspace ` +
      `your calls are billed to. Run /logout, paste an Admin key from the ` +
      `correct org at console.anthropic.com/settings/admin-keys, then /usage again.`;
  }

  const daysElapsed = Math.max(1, uniqueDays.size > 0 ? uniqueDays.size : day - 1);
  const totalDaysInMonth = daysInMonth(year, month);
  const dailyAvg = totalCost / daysElapsed;
  const projected = dailyAvg * totalDaysInMonth;

  // Cache efficiency
  let totalInput = 0, totalCacheRead = 0;
  for (const [, agg] of byFamily) {
    totalInput     += agg.input + agg.cacheRead + agg.cacheWrite;
    totalCacheRead += agg.cacheRead;
  }
  const cacheEfficiency = totalInput > 0 ? (totalCacheRead / totalInput) * 100 : 0;

  // Dominant cost driver — only meaningful when there's real spend and the
  // dominant row is a known family. Skipping the line when everything is
  // either zero or "other" avoids the nonsense "other accounts for 0% of
  // total spend" footnote.
  const dominant = familyRows[0];
  let observation = '';
  if (dominant && totalCost > 0) {
    const pct = ((dominant.cost / totalCost) * 100).toFixed(0);
    if (dominant.name.includes('Opus')) {
      observation = `${dominant.name} accounts for ${pct}% of total spend — output tokens on Opus are the primary cost lever.`;
    } else if (dominant.name.includes('Sonnet')) {
      observation = `${dominant.name} accounts for ${pct}% of total spend — Sonnet output is the primary cost driver; consider routing simpler tasks to Haiku.`;
    } else if (dominant.name.includes('Haiku')) {
      observation = `${dominant.name} accounts for ${pct}% of total spend — volume on Haiku is driving cost despite its low per-token rate.`;
    }
  }

  // Format report
  const lines: string[] = [];
  lines.push(`Organization Usage — ${firstOfMonth} to ${today}`);
  lines.push('');
  lines.push('Per-model breakdown:');
  lines.push('');

  for (const row of familyRows) {
    const a = row.agg;
    lines.push(`  ${row.name}`);
    lines.push(`    Input:        ${fmtTokens(a.input).padStart(10)}    Cache reads:  ${fmtTokens(a.cacheRead).padStart(10)}`);
    lines.push(`    Cache writes: ${fmtTokens(a.cacheWrite).padStart(10)}    Output:       ${fmtTokens(a.output).padStart(10)}`);
    lines.push(`    Cost: ${formatUsd(row.cost)}`);
    lines.push('');
  }

  lines.push(`Total estimated cost:       ${formatUsd(totalCost)}`);
  lines.push(`Daily average:              ${formatUsd(dailyAvg)}  (${daysElapsed} day${daysElapsed === 1 ? '' : 's'} of data)`);
  lines.push(`Projected end-of-month:     ${formatUsd(projected)}  (${totalDaysInMonth} days in ${year}-${pad(month)})`);
  lines.push(`Cache efficiency:           ${cacheEfficiency.toFixed(1)}%  (cache reads / total input tokens)`);
  lines.push('');
  if (observation) lines.push(observation);

  return lines.join('\n');
}

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
