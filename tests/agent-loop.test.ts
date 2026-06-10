import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  isConcurrencySafe,
  planToolBatches,
  isRetriableError,
  isContextOverflow,
  isRealUserPrompt,
  segmentTurns,
  planCompaction,
  renderForSummary,
} from '../src/agent-loop';

// ─── Tool concurrency policy ──────────────────────────────────────────────────
describe('isConcurrencySafe', () => {
  test('read-only tools and sub-agents are safe', () => {
    for (const t of ['read_file', 'list_files', 'query_run_results', 'query_manifest', 'kimball_query', 'agent']) {
      expect(isConcurrencySafe(t)).toBe(true);
    }
  });
  test('mutating tools are unsafe', () => {
    for (const t of ['write_file', 'run_dbt_command', 'bash', 'model_state']) {
      expect(isConcurrencySafe(t)).toBe(false);
    }
  });
  test('unknown tools default to unsafe', () => {
    expect(isConcurrencySafe('some_new_tool')).toBe(false);
  });
});

describe('planToolBatches', () => {
  const names = (groups: { name: string }[][]) => groups.map(g => g.map(b => b.name));

  test('all read-only tools run as one concurrent group', () => {
    const blocks = [{ name: 'read_file' }, { name: 'query_manifest' }, { name: 'read_file' }];
    expect(names(planToolBatches(blocks))).toEqual([['read_file', 'query_manifest', 'read_file']]);
  });

  test('each mutating tool runs alone', () => {
    const blocks = [{ name: 'write_file' }, { name: 'write_file' }];
    expect(names(planToolBatches(blocks))).toEqual([['write_file'], ['write_file']]);
  });

  test('mixed read/write/read serializes the write but keeps order', () => {
    const blocks = [{ name: 'read_file' }, { name: 'write_file' }, { name: 'read_file' }];
    expect(names(planToolBatches(blocks))).toEqual([['read_file'], ['write_file'], ['read_file']]);
  });

  test('consecutive safe tools group, then an unsafe tool breaks the group', () => {
    const blocks = [{ name: 'read_file' }, { name: 'list_files' }, { name: 'bash' }, { name: 'read_file' }];
    expect(names(planToolBatches(blocks))).toEqual([['read_file', 'list_files'], ['bash'], ['read_file']]);
  });

  test('preserves overall order when flattened', () => {
    const blocks = [{ name: 'read_file' }, { name: 'write_file' }, { name: 'agent' }, { name: 'run_dbt_command' }];
    expect(planToolBatches(blocks).flat()).toEqual(blocks);
  });

  test('empty input yields no groups', () => {
    expect(planToolBatches([])).toEqual([]);
  });
});

// ─── Error classification ─────────────────────────────────────────────────────
describe('isRetriableError', () => {
  test('rate limit, overload, and 5xx are retriable', () => {
    expect(isRetriableError({ status: 429 })).toBe(true);
    expect(isRetriableError({ status: 529 })).toBe(true);
    expect(isRetriableError({ status: 503 })).toBe(true);
  });
  test('timeouts and dropped connections are retriable', () => {
    expect(isRetriableError(new Error('Request timed out'))).toBe(true);
    expect(isRetriableError(new Error('socket hang up'))).toBe(true);
    expect(isRetriableError(new Error('ECONNRESET'))).toBe(true);
  });
  test('context overflow is NOT retriable (needs compaction)', () => {
    expect(isRetriableError({ status: 400, message: 'prompt is too long: 250000 tokens > 200000' })).toBe(false);
  });
  test('plain client errors are not retriable', () => {
    expect(isRetriableError({ status: 400, message: 'invalid_request_error' })).toBe(false);
    expect(isRetriableError(new Error('boom'))).toBe(false);
  });
});

describe('isContextOverflow', () => {
  test('detects the prompt-too-long message and 413', () => {
    expect(isContextOverflow(new Error('prompt is too long: 210000 tokens > 200000'))).toBe(true);
    expect(isContextOverflow({ status: 413 })).toBe(true);
  });
  test('rejects unrelated errors', () => {
    expect(isContextOverflow({ status: 429 })).toBe(false);
    expect(isContextOverflow(new Error('overloaded'))).toBe(false);
  });
});

// ─── Compaction planning ──────────────────────────────────────────────────────
const userText = (t: string): Anthropic.MessageParam => ({ role: 'user', content: t });
const asstText = (t: string): Anthropic.MessageParam => ({ role: 'assistant', content: t });
const asstToolUse = (id: string): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'x.sql' } }],
});
const toolResult = (id: string): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'data' }],
});

describe('isRealUserPrompt', () => {
  test('text user message is a real prompt', () => {
    expect(isRealUserPrompt(userText('hi'))).toBe(true);
  });
  test('tool_result-only user message is a continuation, not a prompt', () => {
    expect(isRealUserPrompt(toolResult('t1'))).toBe(false);
  });
  test('assistant messages are never prompts', () => {
    expect(isRealUserPrompt(asstText('ok'))).toBe(false);
  });
});

describe('segmentTurns', () => {
  test('groups a tool round into a single turn', () => {
    const msgs = [userText('hi'), asstToolUse('t1'), toolResult('t1'), asstText('done')];
    const turns = segmentTurns(msgs);
    expect(turns.length).toBe(1);
    expect(turns[0]!.length).toBe(4);
  });
  test('a new user prompt starts a new turn', () => {
    const msgs = [userText('a'), asstText('1'), userText('b'), asstText('2')];
    const turns = segmentTurns(msgs);
    expect(turns.length).toBe(2);
    expect(turns[0]).toEqual([userText('a'), asstText('1')]);
  });
});

describe('planCompaction', () => {
  test('returns null when there are too few turns', () => {
    const msgs = [userText('a'), asstText('1'), userText('b'), asstText('2')];
    expect(planCompaction(msgs)).toBeNull();
  });

  test('splits head / middle / tail at turn boundaries', () => {
    // 6 turns; default keepHead=1, keepTail=3 → middle is turns 2-3.
    const msgs: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userText(`q${i}`), asstText(`a${i}`));
    }
    const plan = planCompaction(msgs)!;
    expect(plan).not.toBeNull();
    expect(plan.head).toEqual([userText('q0'), asstText('a0')]);
    expect(plan.tail).toEqual([
      userText('q3'), asstText('a3'),
      userText('q4'), asstText('a4'),
      userText('q5'), asstText('a5'),
    ]);
    expect(plan.middle).toEqual([userText('q1'), asstText('a1'), userText('q2'), asstText('a2')]);
  });

  test('never splits a tool_use from its tool_result', () => {
    const msgs: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(userText(`q${i}`), asstToolUse(`t${i}`), toolResult(`t${i}`), asstText(`a${i}`));
    }
    const plan = planCompaction(msgs)!;
    // Every tool_use id present in the middle must have its tool_result in the middle too.
    const ids = (ms: Anthropic.MessageParam[], kind: 'tool_use' | 'tool_result') =>
      ms.flatMap(m => (typeof m.content === 'string' ? [] : m.content))
        .filter((b: any) => b.type === kind)
        .map((b: any) => (kind === 'tool_use' ? b.id : b.tool_use_id));
    expect(ids(plan.middle, 'tool_use').sort()).toEqual(ids(plan.middle, 'tool_result').sort());
  });
});

describe('renderForSummary', () => {
  test('flattens text, tool calls, and tool results to labeled lines', () => {
    const out = renderForSummary([
      userText('fix stg_orders'),
      asstToolUse('t1'),
      toolResult('t1'),
      asstText('done'),
    ]);
    expect(out).toContain('USER: fix stg_orders');
    expect(out).toContain('ASSISTANT called read_file(');
    expect(out).toContain('TOOL RESULT: data');
    expect(out).toContain('ASSISTANT: done');
  });

  test('honors the char cap', () => {
    const out = renderForSummary([userText('x'.repeat(1000))], 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});
