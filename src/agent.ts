import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SYSTEM_PROMPT } from './system-prompt';
import { TOOLS, executeTool } from './tools';
import { getProjectDir } from './project-dir';

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

// Retries on 429 rate-limit errors with linear back-off: 15s → 30s → 60s.
// 429s from Anthropic are always pre-generation (no tokens emitted yet), so retrying is safe.
// User-abort errors are surfaced immediately as AgentAbortedError so the UI can react cleanly.
async function retryOn429<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [15_000, 30_000, 60_000];
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) throw new AgentAbortedError();
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('429') || i === delays.length) throw err;
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
    const response = await retryOn429(() => getClient().messages.create({
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
    const response = await retryOn429(() => getClient().messages.create({
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
    const { text, usage } = await throttleSubAgents(() =>
      runSubAgent(input.prompt as string, signal),
    );
    callbacks.onUsage?.(usage, SUB_AGENT_MODEL, subAgentLabel);
    result = text;
  } else {
    result = await executeTool(block.name, input);
  }

  callbacks.onToolEnd(label, result);
  return { type: 'tool_result', tool_use_id: block.id, content: result };
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

  // Adaptive thinking is only supported on Claude 4 Sonnet and Opus models — not Haiku.
  // When enabled, adaptive mode automatically interleaves thinking between tool calls so
  // the model can reason about each result before deciding the next step (matching how
  // Claude Code behaves internally). The model decides when and how much to think.
  const useThinking = supportsThinking(effectiveModel);

  while (true) {
    if (signal?.aborted) throw new AgentAbortedError();

    const response = await retryOn429(async () => {
      const stream = getClient().messages.stream({
        model: effectiveModel,
        max_tokens: 8192,
        system: cachedSystem(effectiveSystem),
        messages: withMessageCache(messages),
        tools: CACHED_TOOLS,
        ...(useThinking ? { thinking: { type: 'adaptive' as const } } : {}),
      }, { signal });
      stream.on('text', callbacks.onText);
      return stream.finalMessage();
    });

    callbacks.onUsage?.(extractUsage(response.usage), effectiveModel);

    // Surface thinking blocks before tools execute so the UI can show the model's
    // reasoning alongside the tool it's about to run. Fires once per thinking block;
    // adaptive mode may produce zero, one, or several thinking blocks per turn.
    if (callbacks.onThinking) {
      for (const block of response.content) {
        if (block.type === 'thinking') {
          callbacks.onThinking(block.thinking);
        }
      }
    }

    // Preserve ALL content blocks — including thinking blocks with their signatures —
    // so the model can continue its reasoning chain across turns. Stripping thinking
    // blocks here would break interleaved reasoning continuity.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') break;
    if (signal?.aborted) throw new AgentAbortedError();

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

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
      // Concurrent execution — original behaviour, unchanged.
      // All tool calls in a single turn run in parallel; agent calls are throttled
      // by the semaphore to stay within the 30K input-tokens/minute rate limit.
      toolResults = await Promise.all(
        toolBlocks.map(block => executeToolBlock(block, callbacks, signal)),
      );
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return messages;
}