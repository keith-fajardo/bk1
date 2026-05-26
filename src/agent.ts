import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SYSTEM_PROMPT } from './system-prompt';
import { TOOLS, executeTool, PROJECT_DIR } from './tools';

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

function buildSystemPrompt(): string {
  const parts: string[] = [SYSTEM_PROMPT];

  const dbtProjectPath = join(PROJECT_DIR, 'dbt_project.yml');
  if (existsSync(dbtProjectPath)) {
    const dbtProject = readFileSync(dbtProjectPath, 'utf-8');
    parts.push(`## dbt_project.yml (project config — use this for project name, profile, and schema/materialization defaults)\n\n${dbtProject}`);
  }

  // Check project-local profiles.yml first, then the default ~/.dbt/profiles.yml
  const profilesCandidates = [
    join(PROJECT_DIR, 'profiles.yml'),
    join(homedir(), '.dbt', 'profiles.yml'),
  ];
  for (const p of profilesCandidates) {
    if (existsSync(p)) {
      const warehouseType = extractWarehouseType(readFileSync(p, 'utf-8'));
      if (warehouseType) {
        parts.push(`## Warehouse Adapter\n\n${warehouseType}`);
      }
      break;
    }
  }

  const claudeMdPath = join(PROJECT_DIR, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const claudeMd = readFileSync(claudeMdPath, 'utf-8');
    parts.push(`## Project Instructions (CLAUDE.md)\n\n${claudeMd}`);
  }

  return parts.join('\n\n');
}

const RESOLVED_SYSTEM_PROMPT = buildSystemPrompt();

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
The user wants to grind through work without confirmation prompts:
- Skip mid-flow "Shall I proceed? (yes / no)" pauses on lint-fix and refactor workflows.
- Apply proposed edits directly when you have a clear, mechanical fix in hand
  (e.g. lint violations with a documented suggested_fix).
- Still pause for genuinely ambiguous work — schema redesigns, destructive dbt commands
  (run/build/seed/snapshot/test on prod targets), or anything that could lose data.
- Surface a concise summary of what you changed at the end of each turn.`;

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
  onToolStart: (name: string, input: Record<string, unknown>) => void;
  onToolEnd: (name: string, result: string) => void;
  // model is the actual Anthropic model that produced these tokens. subAgentLabel is
  // set only when the usage came from a sub-agent (the `agent` tool); it carries the
  // sub-agent's `description` so /usage can attribute Haiku spend to specific rules.
  onUsage?: (usage: TokenUsage, model: string, subAgentLabel?: string) => void;
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

export async function runAgent(
  history: Anthropic.MessageParam[],
  callbacks: AgentCallbacks,
  options?: RunAgentOptions,
): Promise<Anthropic.MessageParam[]> {
  const messages = [...history];
  const effectiveModel = options?.model ?? MODEL;
  const mode: AgentMode = options?.mode ?? 'build';
  const signal = options?.signal;
  const effectiveSystem =
    mode === 'plan' ? RESOLVED_SYSTEM_PROMPT + PLAN_MODE_SUFFIX :
    mode === 'auto' ? RESOLVED_SYSTEM_PROMPT + AUTO_MODE_SUFFIX :
    RESOLVED_SYSTEM_PROMPT;

  while (true) {
    if (signal?.aborted) throw new AgentAbortedError();

    const response = await retryOn429(async () => {
      const stream = getClient().messages.stream({
        model: effectiveModel,
        max_tokens: 8192,
        system: cachedSystem(effectiveSystem),
        messages: withMessageCache(messages),
        tools: CACHED_TOOLS,
      }, { signal });
      stream.on('text', callbacks.onText);
      return stream.finalMessage();
    });
    callbacks.onUsage?.(extractUsage(response.usage), effectiveModel);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') break;
    if (signal?.aborted) throw new AgentAbortedError();

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    // All tool calls in a single turn run concurrently — agent calls included
    const toolResults = await Promise.all(
      toolBlocks.map(async (block) => {
        const input = block.input as Record<string, unknown>;
        const label = block.name === 'agent'
          ? ((input.description as string | undefined) ?? 'sub-agent')
          : block.name;

        callbacks.onToolStart(label, input);

        let result: string;
        if (block.name === 'agent') {
          const subAgentLabel = (input.description as string | undefined) ?? 'sub-agent';
          const { text, usage } = await throttleSubAgents(() => runSubAgent(input.prompt as string, signal));
          callbacks.onUsage?.(usage, SUB_AGENT_MODEL, subAgentLabel);
          result = text;
        } else {
          result = await executeTool(block.name, input);
        }

        callbacks.onToolEnd(label, result);
        return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
      }),
    );

    messages.push({ role: 'user', content: toolResults });
  }

  return messages;
}
