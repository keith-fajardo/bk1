import type Anthropic from '@anthropic-ai/sdk';

// Pure helpers for the agent loop (src/agent.ts). Kept in a dependency-free leaf module so
// the scheduling, error-classification, and compaction logic is unit-testable without the
// Anthropic client or network — and so deps:check stays clean (fan-out 0).

// ─── Tool concurrency policy ──────────────────────────────────────────────────
// Read-only tools may run concurrently. `agent` keeps its existing intended parallelism
// (sub-agents are independently bounded by the throttle semaphore, and /lint relies on
// running several at once). Everything else mutates the project files or the state DB
// (write_file, run_dbt_command, bash, model_state) and must run with exclusive access so two
// mutations in one turn cannot race.
const CONCURRENCY_SAFE_TOOLS = new Set([
  'read_file',
  'list_files',
  'query_run_results',
  'query_manifest',
  'kimball_query',
  'agent',
]);

export function isConcurrencySafe(name: string): boolean {
  return CONCURRENCY_SAFE_TOOLS.has(name);
}

// The `agent` tool's prompt comes straight from model output, which can be truncated or
// malformed — e.g. when a response spawns several large sub-agent calls and the last one is
// cut off at the output-token cap mid-JSON, its `prompt` arrives undefined. Validate before
// spawning a sub-agent: an undefined prompt used to crash the whole turn (undefined.content
// .map deep in the cache layer).
export function validSubAgentPrompt(prompt: unknown): prompt is string {
  return typeof prompt === 'string' && prompt.trim() !== '';
}

// Groups tool blocks for execution while preserving order: a maximal run of consecutive
// concurrency-safe blocks becomes one group (run together); each unsafe block is its own
// group (runs alone). Generic over { name } so it is testable with plain objects.
export function planToolBatches<T extends { name: string }>(blocks: T[]): T[][] {
  const groups: T[][] = [];
  let i = 0;
  while (i < blocks.length) {
    if (isConcurrencySafe(blocks[i]!.name)) {
      const group: T[] = [];
      while (i < blocks.length && isConcurrencySafe(blocks[i]!.name)) group.push(blocks[i++]!);
      groups.push(group);
    } else {
      groups.push([blocks[i++]!]);
    }
  }
  return groups;
}

// ─── Error classification ─────────────────────────────────────────────────────
function errStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null | undefined)?.status;
}
function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).toLowerCase();
}

// Context-window overflow — the prompt itself is too large. Anthropic returns a 400
// invalid_request_error whose message contains "prompt is too long"; some proxies use 413.
// This needs compaction, not a blind retry, so it is classified separately.
export function isContextOverflow(err: unknown): boolean {
  if (errStatus(err) === 413) return true;
  const msg = errText(err);
  return msg.includes('prompt is too long')
    || msg.includes('context window')
    || msg.includes('too many tokens')
    || msg.includes('maximum context length');
}

// Transient = safe to retry (pre-generation or network-level): rate limits, overload, 5xx,
// timeouts, dropped connections. Context-overflow is excluded — retrying it unchanged just
// fails again.
export function isRetriableError(err: unknown): boolean {
  if (isContextOverflow(err)) return false;
  const status = errStatus(err);
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
  return /(429|529|overloaded|rate.?limit|timeout|timed out|etimedout|econnreset|socket hang up|connection error|fetch failed|network error)/.test(errText(err));
}

// ─── Compaction ───────────────────────────────────────────────────────────────
// A real user prompt starts a new turn; a user message that is only tool_result blocks is a
// continuation of the current turn. Segmenting on real prompts keeps every assistant tool_use
// paired with its tool_result inside one segment, so whole segments can be summarized away
// without orphaning a tool call (which the API would reject).
export function isRealUserPrompt(m: Anthropic.MessageParam): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return m.content.some(b => b.type === 'text');
}

export function segmentTurns(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[][] {
  const turns: Anthropic.MessageParam[][] = [];
  for (const m of messages) {
    if (turns.length === 0 || isRealUserPrompt(m)) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

export interface CompactionPlan {
  head: Anthropic.MessageParam[];
  middle: Anthropic.MessageParam[];
  tail: Anthropic.MessageParam[];
}

// Decide which turns to keep verbatim (first `keepHead`, last `keepTail`) and which to
// summarize (everything between). Returns null when there isn't enough middle to be worth it.
export function planCompaction(
  messages: Anthropic.MessageParam[],
  keepHead = 1,
  keepTail = 3,
): CompactionPlan | null {
  const turns = segmentTurns(messages);
  if (turns.length <= keepHead + keepTail + 1) return null;
  const head = turns.slice(0, keepHead).flat();
  const tail = turns.slice(turns.length - keepTail).flat();
  const middle = turns.slice(keepHead, turns.length - keepTail).flat();
  if (middle.length === 0) return null;
  return { head, middle, tail };
}

// Flatten message blocks into plain text for the summarizer. Thinking blocks are dropped;
// tool calls/results are truncated so the summary request itself stays bounded.
export function renderForSummary(messages: Anthropic.MessageParam[], maxChars = 60_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'ASSISTANT' : 'USER';
    if (typeof m.content === 'string') {
      lines.push(`${role}: ${m.content}`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') {
        lines.push(`${role}: ${b.text}`);
      } else if (b.type === 'tool_use') {
        lines.push(`${role} called ${b.name}(${JSON.stringify(b.input).slice(0, 400)})`);
      } else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map(x => (x.type === 'text' ? x.text : `[${x.type}]`)).join(' ')
            : JSON.stringify(b.content);
        lines.push(`TOOL RESULT: ${String(c).slice(0, 800)}`);
      }
    }
  }
  return lines.join('\n').slice(0, maxChars);
}
