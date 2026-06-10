import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SYSTEM_PROMPT } from './system-prompt';
import { TOOLS, executeTool } from './tools';
import { getProjectDir } from './project-dir';
import {
  planToolBatches,
  isRetriableError,
  isContextOverflow,
  planCompaction,
  renderForSummary,
  validSubAgentPrompt,
} from './agent-loop';

// Sub-agents don't get the agent tool — prevents accidental recursion
const SUB_AGENT_TOOLS = TOOLS.filter(t => t.name !== 'agent');

// Mark the last tool with cache_control so the entire tools array is cached up to that point.
// Anthropic caches everything up to and including the marked block.
function withToolCache(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
  );
}

// Wrap a plain system string as a cached text block.
function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

// Mark only the most recent user message with cache_control. Anthropic auto-finds the
// longest cached prefix on each request, so moving the breakpoint forward each turn caches
// the entire conversation state up to (and including) the latest user/tool-result message.
// Skill prompts especially benefit — /lint-deep's ~1.5K-token template gets cached after
// the first turn it's referenced in.
function withMessageCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return messages;

  const msg = messages[lastUserIdx]!;
  const content = msg.content;
  // Defense in depth: never crash on a malformed message. Null/undefined/non-array content
  // would throw on content.map below; leave such a message untouched. The real fix is
  // upstream (executeToolBlock validates agent prompts before a sub-agent is spawned).
  if (typeof content !== 'string' && !Array.isArray(content)) return messages;
  let newContent: Anthropic.MessageParam['content'];
  if (typeof content === 'string') {
    newContent = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
  } else {
    newContent = content.map((b, i) =>
      i === content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b,
    );
  }
  return [
    ...messages.slice(0, lastUserIdx),
    { ...msg, content: newContent },
    ...messages.slice(lastUserIdx + 1),
  ];
}

const CACHED_TOOLS           = withToolCache(TOOLS);
const CACHED_SUB_AGENT_TOOLS = withToolCache(SUB_AGENT_TOOLS);

// Models that support adaptive/interleaved thinking.
// Haiku (used by sub-agents and the router) does not — exclude it.
const THINKING_CAPABLE_MODELS = new Set([
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
]);

function supportsThinking(model: string): boolean {
  return THINKING_CAPABLE_MODELS.has(model);
}

const SUB_AGENT_SYSTEM = `\
You are a focused dbt sub-agent. Execute the task using the available tools, then return your \
findings exactly as instructed. Be precise and concise.

dbt conventions for semantic checks:
- snake_case field names; column order: ids, strings, numerics, booleans, dates, timestamps.
- stg_<source>__<table>: views, no joins, explicit columns, all columns cast to a type.
- int_<name>: owns joins and business logic; materialized as tables.
- dim_ (singular): must state SCD type in YAML. fct_ (plural): state fact table type if non-default.
- Every .sql has a paired .yml with exactly one model; describe all models and columns.
- "select * from final" and "select * from renamed" are NEVER violations — columns are explicit in the CTE above.
- No select * inside transformation CTEs or as a bare whole-model select.`;

function extractWarehouseType(profilesYml: string): string | null {
  for (const line of profilesYml.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('type:')) {
      return trimmed.slice('type:'.length).trim();
    }
  }
  return null;
}

// Reading project config for the prompt must never crash the app: a file can
// exist yet be unreadable (EPERM under macOS TCC for ~/Desktop, ~/Documents,
// ~/Downloads). A raw readFileSync throw here would propagate through
// rebuildSystemPrompt() and take down the whole TUI on a /project switch (and at
// launch). Skip what we can't read; changeProject surfaces the permission error.
function readIfReadable(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); }
  catch { return null; }
}

function buildSystemPrompt(): string {
  const parts: string[] = [SYSTEM_PROMPT];

  const dbtProject = readIfReadable(join(getProjectDir(), 'dbt_project.yml'));
  if (dbtProject) {
    parts.push(`## dbt_project.yml (project config — use this for project name, profile, and schema/materialization defaults)\n\n${dbtProject}`);
  }

  // Check project-local profiles.yml first, then the default ~/.dbt/profiles.yml
  const profilesCandidates = [
    join(getProjectDir(), 'profiles.yml'),
    join(homedir(), '.dbt', 'profiles.yml'),
  ];
  for (const p of profilesCandidates) {
    const yml = readIfReadable(p);
    if (yml) {
      const warehouseType = extractWarehouseType(yml);
      if (warehouseType) {
        parts.push(`## Warehouse Adapter\n\n${warehouseType}`);
      }
      break;
    }
  }

  const claudeMd = readIfReadable(join(getProjectDir(), 'CLAUDE.md'));
  if (claudeMd) {
    parts.push(`## Project Instructions (CLAUDE.md)\n\n${claudeMd}`);
  }

  return parts.join('\n\n');
}

// Resolved once at import, and rebuilt by rebuildSystemPrompt() when the user
// switches projects mid-session — otherwise the agent would keep injecting the
// previous project's dbt_project.yml + CLAUDE.md for the rest of the session.
// Read live inside runAgent so a rebuild takes effect on the very next turn.
let RESOLVED_SYSTEM_PROMPT = buildSystemPrompt();

export function rebuildSystemPrompt(): void {
  RESOLVED_SYSTEM_PROMPT = buildSystemPrompt();
}

const PLAN_MODE_SUFFIX = `

## Plan Mode — active
Before calling any tools or editing any files, write a complete plan:
- What you intend to do, step by step
- Which files you will read or modify
- Any risks or ambiguities worth flagging

End your plan with: "Shall I proceed? (yes / no)"
Stop and wait. Do not call any tools until the user explicitly says yes.`;

const AUTO_MODE_SUFFIX = `

## Auto Mode — active
The model for this turn was auto-selected to match the task's complexity. Before calling
any tools or editing any files, write a complete plan:
- What you intend to do, step by step
- Which files you will read or modify
- Any risks or ambiguities worth flagging

End your plan with: "Shall I proceed? (yes / no)"
Stop and wait. Do not call any tools until the user explicitly says yes.`;

let client: Anthropic | null = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// Invalidates the cached SDK client so the next call rebuilds it from the current env.
// Called on logout so a re-login with a different key takes effect without restart.
export function resetAnthropicClient(): void {
  client = null;
}

// One-sentence Haiku summary of a user prompt — used to populate turn_costs.summary.
// Best-effort: returns '' on any error so a failure never blocks the main flow.
export async function summarizePrompt(text: string): Promise<string> {
  try {
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `Summarize the following user prompt in one sentence of 15 words or fewer. Reply with only the sentence, no preamble.\n\n${text}`,
      }],
    });
    const block = msg.content[0];
    return block?.type === 'text' ? block.text.trim() : '';
  } catch {
    return '';
  }
}
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
// Sub-agents do simple rule-checking — Haiku is fast, cheap, and sufficient.
// Override with ANTHROPIC_SUB_AGENT_MODEL if needed.
const SUB_AGENT_MODEL = process.env.ANTHROPIC_SUB_AGENT_MODEL ?? 'claude-haiku-4-5-20251001';

// Auto mode picks the turn's model from a one-shot Haiku complexity classification.
const ROUTER_MODEL = 'claude-haiku-4-5-20251001';
const ROUTER_FALLBACK_MODEL = 'claude-sonnet-4-6';
const COMPLEXITY_MODEL: Record<string, string> = {
  simple:  'claude-haiku-4-5-20251001',
  medium:  'claude-sonnet-4-6',
  hard:    'claude-opus-4-7',
  complex: 'claude-opus-4-8',
};

// Loop-hardening knobs. The model the loop drops to when the primary keeps failing transient
// errors; a turn backstop against a runaway tool loop; how many times we resume a response
// cut off at the output-token cap; and the context-token threshold that triggers proactive
// compaction (with a BK1_COMPACT=0 escape hatch, mirroring BK1_ALT_SCREEN=0).
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = Number(process.env.BK1_MAX_TURNS ?? 200);
const MAX_TRUNCATION_RETRIES = 3;
const COMPACT_THRESHOLD = Number(process.env.BK1_COMPACT_THRESHOLD ?? 140_000);
const COMPACT_ENABLED = process.env.BK1_COMPACT !== '0';

const COMPACTION_SYSTEM = `You compress the running history of a dbt coding agent. Summarize the conversation excerpt into a dense factual brief that lets the agent continue WITHOUT re-reading it: what the user asked for, which files/models were read or edited, decisions and findings, the current state, and any pending next step. Preserve identifiers — model names, file paths, column names, error text — verbatim. Reply with only the summary, no preamble.`;

// Limits concurrent sub-agent API calls to avoid 30K input tokens/minute rate limit.
// Regular tool calls (read_file, bash, etc.) are unaffected — only `agent` tool is throttled.
function makeSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>(resolve => queue.push(resolve));
    active++;
    try { return await fn(); }
    finally { active--; queue.shift()?.(); }
  };
}
const throttleSubAgents = makeSemaphore(2);

// Retries transient API failures (rate limits, overload, 5xx, request timeouts, dropped
// connections — see isRetriableError) with linear back-off: 15s → 30s → 60s. These are all
// pre-generation or network-level, so retrying is safe — no tokens were emitted. Context
// overflow is NOT retried here (it needs compaction); user aborts surface immediately as
// AgentAbortedError so the UI can react cleanly.
async function retryTransient<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [15_000, 30_000, 60_000];
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) throw new AgentAbortedError();
      if (!isRetriableError(err) || i === delays.length) throw err;
      await new Promise(r => setTimeout(r, delays[i]!));
    }
  }
  throw new Error('unreachable');
}

export type AgentMode = 'plan' | 'build' | 'auto';

export interface RunAgentOptions {
  model?: string;
  mode?: AgentMode;
  signal?: AbortSignal;
  // Backstop against a runaway tool loop. Defaults to DEFAULT_MAX_TURNS.
  maxTurns?: number;
  // Optional cumulative input+output token budget for a single request. Opt-in (no default).
  maxTokens?: number;
}

// Sentinel error thrown when the user interrupts a run via ESC. The UI catches
// this specifically so it can show a friendly message rather than a stack trace.
export class AgentAbortedError extends Error {
  constructor() {
    super('Agent interrupted by user');
    this.name = 'AgentAbortedError';
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentCallbacks {
  onText: (chunk: string) => void;
  // Fired with each thinking block's text after a response arrives, before tools run.
  // Only fires when the model actually chose to think (adaptive mode may skip it on
  // simple turns). The text may be a summary when display:"summarized" is in effect.
  onThinking?: (text: string) => void;
  onToolStart: (name: string, input: Record<string, unknown>) => void;
  onToolEnd: (name: string, result: string) => void;
  // Step confirmation gate. When provided, tools run sequentially and each call is
  // gated behind this callback. Return true to execute, false to skip with a
  // "user declined" result so the model can handle it gracefully.
  onToolConfirm?: (name: string, input: Record<string, unknown>) => Promise<boolean>;
  // model is the actual Anthropic model that produced these tokens. subAgentLabel is
  // set only when the usage came from a sub-agent (the `agent` tool); it carries the
  // sub-agent's `description` so /usage can attribute Haiku spend to specific rules.
  onUsage?: (usage: TokenUsage, model: string, subAgentLabel?: string) => void;
  // Fired in auto mode once the router has picked the turn's model.
  onModelRoute?: (model: string, classification: string) => void;
}

function extractUsage(u: Anthropic.Message['usage']): TokenUsage {
  const raw = u as unknown as Record<string, number>;
  return {
    inputTokens:      u.input_tokens,
    outputTokens:     u.output_tokens,
    cacheReadTokens:  raw['cache_read_input_tokens']      ?? 0,
    cacheWriteTokens: raw['cache_creation_input_tokens']  ?? 0,
  };
}

interface SubAgentResult { text: string; usage: TokenUsage; }

// Sub-agents use Haiku, which does not support extended thinking — no thinking param here.
async function runSubAgent(prompt: string, signal?: AbortSignal): Promise<SubAgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  while (true) {
    if (signal?.aborted) throw new AgentAbortedError();
    const response = await retryTransient(() => getClient().messages.create({
      model: SUB_AGENT_MODEL,
      max_tokens: 4096,
      system: cachedSystem(SUB_AGENT_SYSTEM),
      messages: withMessageCache(messages),
      tools: CACHED_SUB_AGENT_TOOLS,
    }, { signal }));

    const turn = extractUsage(response.usage);
    usage.inputTokens      += turn.inputTokens;
    usage.outputTokens     += turn.outputTokens;
    usage.cacheReadTokens  += turn.cacheReadTokens;
    usage.cacheWriteTokens += turn.cacheWriteTokens;

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      return { text, usage };
    }

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const toolResults = await Promise.all(
      toolBlocks.map(async (block) => {
        const result = await executeTool(block.name, block.input as Record<string, unknown>);
        return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
      }),
    );
    messages.push({ role: 'user', content: toolResults });
  }
}

const ROUTER_SYSTEM = `You are a routing classifier for a dbt coding agent. Read the user's request and rate how much work it needs. Reply with EXACTLY one lowercase word and nothing else:
- simple: a trivial one-shot edit or lookup (fix a typo, rename a column description, read one file)
- medium: a normal single-model change (write/adjust one model's SQL, add a test, explain a model)
- hard: multi-file work or non-obvious logic (refactor a model and its dependents, debug a failing build, tricky SQL)
- complex: architectural or large multi-step work (redesign a layer, build many models, project-wide migration)`;

// Extracts the plain text of the most recent user turn, ignoring tool_result blocks.
function lastUserText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const text = m.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    if (text.trim()) return text;
  }
  return '';
}

// One-shot Haiku classification → model. Never throws: any failure falls back to Sonnet
// so a turn is never blocked by the router.
async function routeModel(
  messages: Anthropic.MessageParam[],
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<{ model: string; classification: string }> {
  const task = lastUserText(messages);
  if (!task.trim()) return { model: ROUTER_FALLBACK_MODEL, classification: 'medium' };

  try {
    const response = await retryTransient(() => getClient().messages.create({
      model: ROUTER_MODEL,
      max_tokens: 8,
      system: ROUTER_SYSTEM,
      messages: [{ role: 'user', content: task }],
    }, { signal }));

    callbacks.onUsage?.(extractUsage(response.usage), ROUTER_MODEL, 'router');

    const word = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    const model = COMPLEXITY_MODEL[word];
    if (model) return { model, classification: word };
  } catch (err) {
    if (err instanceof AgentAbortedError) throw err;
  }
  return { model: ROUTER_FALLBACK_MODEL, classification: 'medium' };
}

// Shared helper: execute a single tool block, firing onToolStart / onToolEnd.
// Keeps the sequential and concurrent paths DRY.
async function executeToolBlock(
  block: Anthropic.ToolUseBlock,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<{ type: 'tool_result'; tool_use_id: string; content: string }> {
  const input = block.input as Record<string, unknown>;
  const label = block.name === 'agent'
    ? ((input.description as string | undefined) ?? 'sub-agent')
    : block.name;

  callbacks.onToolStart(label, input);

  let result: string;
  if (block.name === 'agent') {
    const subAgentLabel = (input.description as string | undefined) ?? 'sub-agent';
    const prompt = input.prompt;
    if (!validSubAgentPrompt(prompt)) {
      // Truncated/malformed agent call (no prompt) — hand back a recoverable result instead
      // of crashing the turn. The model can re-issue the call or do the work inline.
      result = '[agent tool was called without a "prompt" string — likely a truncated tool call. Re-issue it with a complete prompt, or do the work directly.]';
    } else {
      const { text, usage } = await throttleSubAgents(() => runSubAgent(prompt, signal));
      callbacks.onUsage?.(usage, SUB_AGENT_MODEL, subAgentLabel);
      result = text;
    }
  } else {
    result = await executeTool(block.name, input);
  }

  callbacks.onToolEnd(label, result);
  return { type: 'tool_result', tool_use_id: block.id, content: result };
}

// Runs a turn's tool blocks under the concurrency-safety policy (planToolBatches): a run of
// consecutive read-only tools (and sub-agents) executes together; a mutating tool executes
// alone so two mutations in one turn can't race. Input order is preserved in the results.
async function runToolBatch(
  blocks: Anthropic.ToolUseBlock[],
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<Array<{ type: 'tool_result'; tool_use_id: string; content: string }>> {
  const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
  for (const group of planToolBatches(blocks)) {
    if (signal?.aborted) throw new AgentAbortedError();
    const groupResults = await Promise.all(
      group.map(block => executeToolBlock(block, callbacks, signal)),
    );
    results.push(...groupResults);
  }
  return results;
}

// Best-effort context compaction: summarize the middle of the conversation via Haiku and
// rebuild messages as head + a synthetic summary exchange + tail. Returns null (caller keeps
// the original messages) when there isn't enough to compact or the summary call fails —
// compaction must never block a turn.
async function compactMessages(
  messages: Anthropic.MessageParam[],
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<Anthropic.MessageParam[] | null> {
  const plan = planCompaction(messages);
  if (!plan) return null;

  let summary = '';
  try {
    const msg = await retryTransient(() => getClient().messages.create({
      model: SUB_AGENT_MODEL,
      max_tokens: 2048,
      system: COMPACTION_SYSTEM,
      messages: [{ role: 'user', content: renderForSummary(plan.middle) }],
    }, { signal }));
    callbacks.onUsage?.(extractUsage(msg.usage), SUB_AGENT_MODEL, 'compaction');
    const block = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    summary = block?.text.trim() ?? '';
  } catch (err) {
    if (err instanceof AgentAbortedError) throw err;
    return null;
  }
  if (!summary) return null;

  return [
    ...plan.head,
    { role: 'user', content: `[Earlier conversation was compacted to save context. Summary of the omitted portion follows.]\n\n${summary}` },
    { role: 'assistant', content: 'Understood — I will continue from the summary above.' },
    ...plan.tail,
  ];
}

export async function runAgent(
  history: Anthropic.MessageParam[],
  callbacks: AgentCallbacks,
  options?: RunAgentOptions,
): Promise<Anthropic.MessageParam[]> {
  const messages = [...history];
  const mode: AgentMode = options?.mode ?? 'build';
  const signal = options?.signal;

  let effectiveModel: string;
  if (mode === 'plan') {
    effectiveModel = 'claude-opus-4-8';
  } else if (mode === 'auto') {
    const routed = await routeModel(messages, callbacks, signal);
    effectiveModel = routed.model;
    callbacks.onModelRoute?.(routed.model, routed.classification);
  } else {
    effectiveModel = options?.model ?? MODEL;
  }
  const effectiveSystem =
    mode === 'plan' ? RESOLVED_SYSTEM_PROMPT + PLAN_MODE_SUFFIX :
    mode === 'auto' ? RESOLVED_SYSTEM_PROMPT + AUTO_MODE_SUFFIX :
    RESOLVED_SYSTEM_PROMPT;

  // Adaptive thinking (interleaved reasoning between tool calls) is only supported on Claude 4
  // Sonnet and Opus — not Haiku — so it's decided per-call from the active model below.
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxTokens = options?.maxTokens;
  let turnCount = 0;
  let totalTokens = 0;
  let lastContextTokens = 0;
  let truncationRetries = 0;

  // One streamed model call, wrapped in transient-error retry. Pulled out so the fallback
  // and post-compaction paths can re-issue it without duplicating the request shape.
  const streamOnce = (model: string) => retryTransient(async () => {
    const stream = getClient().messages.stream({
      model,
      max_tokens: 8192,
      system: cachedSystem(effectiveSystem),
      messages: withMessageCache(messages),
      tools: CACHED_TOOLS,
      ...(supportsThinking(model) ? { thinking: { type: 'adaptive' as const } } : {}),
    }, { signal });
    stream.on('text', callbacks.onText);
    return stream.finalMessage();
  });

  const stopNote = (text: string) => {
    callbacks.onText(`\n${text}`);
    messages.push({ role: 'assistant', content: text });
  };

  while (true) {
    if (signal?.aborted) throw new AgentAbortedError();

    // Governors: stop cleanly (never throw) when a single request runs away. The turn cap is
    // a backstop against a tool loop; maxTokens is opt-in cost protection. Both are checked
    // here — between completed turns — so the conversation never ends on a dangling tool_use.
    if (maxTokens && totalTokens >= maxTokens) {
      stopNote(`[Stopped: reached the ${maxTokens.toLocaleString()}-token budget for this request. Ask me to continue if that was expected.]`);
      break;
    }
    if (turnCount >= maxTurns) {
      stopNote(`[Stopped: reached the ${maxTurns}-turn limit for this request. Ask me to continue if that was expected.]`);
      break;
    }
    turnCount++;

    // Proactive compaction: if the last prompt was large, summarize the middle of the
    // conversation before the next call so we stay clear of the context window.
    if (COMPACT_ENABLED && lastContextTokens > COMPACT_THRESHOLD) {
      const compacted = await compactMessages(messages, callbacks, signal);
      if (compacted) {
        messages.length = 0;
        messages.push(...compacted);
        lastContextTokens = 0;
      }
    }

    let response: Anthropic.Message;
    try {
      response = await streamOnce(effectiveModel);
    } catch (err) {
      if (err instanceof AgentAbortedError) throw err;
      if (COMPACT_ENABLED && isContextOverflow(err)) {
        // Reactive compaction: the prompt overflowed the window — compact and retry once.
        const compacted = await compactMessages(messages, callbacks, signal);
        if (!compacted) throw err;
        messages.length = 0;
        messages.push(...compacted);
        lastContextTokens = 0;
        response = await streamOnce(effectiveModel);
      } else if (isRetriableError(err) && effectiveModel !== FALLBACK_MODEL) {
        // Primary model exhausted its retries — drop to the fallback for the rest of the run.
        effectiveModel = FALLBACK_MODEL;
        callbacks.onModelRoute?.(effectiveModel, 'fallback');
        response = await streamOnce(effectiveModel);
      } else {
        throw err;
      }
    }

    const turnUsage = extractUsage(response.usage);
    callbacks.onUsage?.(turnUsage, effectiveModel);
    totalTokens += turnUsage.inputTokens + turnUsage.outputTokens;
    // Size of the prompt we just sent ≈ current context size — the trigger for the next
    // proactive compaction check.
    lastContextTokens = turnUsage.inputTokens + turnUsage.cacheReadTokens + turnUsage.cacheWriteTokens;

    // Surface thinking blocks before tools execute so the UI can show the model's reasoning
    // alongside the tool it's about to run. Adaptive mode may emit zero, one, or several.
    if (callbacks.onThinking) {
      for (const block of response.content) {
        if (block.type === 'thinking') {
          callbacks.onThinking(block.thinking);
        }
      }
    }

    // Preserve ALL content blocks — including thinking blocks with their signatures — so the
    // model can continue its reasoning chain across turns.
    messages.push({ role: 'assistant', content: response.content });

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolBlocks.length === 0) {
      // No tool calls. A max_tokens stop means the text answer was cut off at the 8192 cap —
      // nudge the model to resume rather than returning a half-written response. Capped so a
      // pathological turn can't loop forever. Any other stop reason ends the run normally.
      if (response.stop_reason === 'max_tokens' && truncationRetries < MAX_TRUNCATION_RETRIES) {
        truncationRetries++;
        messages.push({
          role: 'user',
          content: 'Your previous response was cut off at the output token limit. Continue exactly where you left off; do not repeat what you already wrote.',
        });
        continue;
      }
      break;
    }

    if (signal?.aborted) throw new AgentAbortedError();

    let toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;

    if (callbacks.onToolConfirm) {
      // Sequential execution with per-step confirmation. Each tool call waits for the
      // user to approve before running. Declined calls get a graceful "user declined"
      // result so the model can acknowledge and ask how to proceed rather than looping.
      toolResults = [];
      for (const block of toolBlocks) {
        if (signal?.aborted) throw new AgentAbortedError();

        const input = block.input as Record<string, unknown>;
        const label = block.name === 'agent'
          ? ((input.description as string | undefined) ?? 'sub-agent')
          : block.name;

        const confirmed = await callbacks.onToolConfirm(label, input);
        if (!confirmed) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: '[User declined this tool call. Acknowledge and ask how to proceed.]',
          });
          continue;
        }

        toolResults.push(await executeToolBlock(block, callbacks, signal));
      }
    } else {
      // Concurrent execution under the concurrency-safety policy: read-only tools (and
      // sub-agents) overlap; mutating tools (write_file, run_dbt_command, bash, model_state)
      // get exclusive access so two mutations in one turn can't race. Order is preserved.
      toolResults = await runToolBatch(toolBlocks, callbacks, signal);
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return messages;
}