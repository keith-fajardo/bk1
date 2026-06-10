import { describe, expect, test } from 'bun:test';
import {
  estimateMessageHeight,
  totalHeight,
  computeMaxScroll,
  windowStartIndex,
  type TranscriptItem,
} from '../src/transcript';

const user = (content: string): TranscriptItem => ({ kind: 'message', role: 'user', content });
const info = (content: string): TranscriptItem => ({ kind: 'message', role: 'assistant', content, info: true });
const asst = (content: string, hasTokens = false): TranscriptItem => ({ kind: 'message', role: 'assistant', content, hasTokens });

describe('estimateMessageHeight', () => {
  test('user bubble adds 2 border rows + 1 bottom margin', () => {
    // single short line, wide terminal: 2 border + 1 body + 1 margin
    expect(estimateMessageHeight(user('hello'), 120)).toBe(4);
  });

  test('user bubble wraps the body at the inner box width', () => {
    // cols=40 → boxWidth=max(20,35)=35 → inner=31. 62 chars → 2 wrapped rows.
    const line = 'x'.repeat(62);
    expect(estimateMessageHeight(user(line), 40)).toBe(2 /*border*/ + 2 /*body*/ + 1 /*margin*/);
  });

  test('multi-line user content counts each source line', () => {
    expect(estimateMessageHeight(user('a\nb\nc'), 120)).toBe(2 + 3 + 1);
  });

  test('info message is plain wrapped lines + margin, no border', () => {
    expect(estimateMessageHeight(info('just a note'), 120)).toBe(1 + 1);
    expect(estimateMessageHeight(info('one\ntwo'), 120)).toBe(2 + 1);
  });

  test('assistant rich message wraps body at cols-4', () => {
    // cols=24 → width=20. 40 chars → 2 rows. +1 margin.
    expect(estimateMessageHeight(asst('y'.repeat(40)), 24)).toBe(2 + 1);
  });

  test('token badge adds one row', () => {
    expect(estimateMessageHeight(asst('short', true), 120)).toBe(1 + 1 + 1);
    expect(estimateMessageHeight(asst('short', false), 120)).toBe(1 + 1);
  });

  test('markdown table block: 3 + 2*dataRows rows', () => {
    const table = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
    // 2 data rows → 3 + 4 = 7 table rows, + 1 margin
    expect(estimateMessageHeight(asst(table), 120)).toBe(7 + 1);
  });

  test('invalid table (no separator) falls back to one row per line', () => {
    const notTable = ['| a | b |', '| 1 | 2 |'].join('\n');
    expect(estimateMessageHeight(asst(notTable), 120)).toBe(2 + 1);
  });

  test('header item returns its precomputed line count', () => {
    expect(estimateMessageHeight({ kind: 'header', lines: 9 }, 120)).toBe(9);
  });

  test('width sensitivity: narrower terminal is never shorter', () => {
    const long = asst('z'.repeat(300));
    expect(estimateMessageHeight(long, 40)).toBeGreaterThan(estimateMessageHeight(long, 120));
  });
});

describe('totalHeight / computeMaxScroll', () => {
  const items: TranscriptItem[] = [
    { kind: 'header', lines: 9 },
    user('hi'),          // 4
    asst('there'),       // 2
    info('done'),        // 2
  ];

  test('totalHeight sums every item', () => {
    expect(totalHeight(items, 120)).toBe(9 + 4 + 2 + 2);
  });

  test('maxScroll is zero when content fits the viewport', () => {
    expect(computeMaxScroll(items, 120, 100)).toBe(0);
  });

  test('maxScroll is content overflow beyond the viewport', () => {
    expect(computeMaxScroll(items, 120, 10)).toBe(17 - 10);
  });
});

describe('windowStartIndex', () => {
  // 10 single-row assistant messages on a wide terminal → each height 2 (1 body + 1 margin).
  const items: TranscriptItem[] = Array.from({ length: 10 }, (_, i) => asst(`m${i}`));

  test('returns a trailing slice that covers at least neededLines', () => {
    // need 6 rows → 3 messages (height 2 each) → start at index 7.
    const start = windowStartIndex(items, 120, 6);
    expect(start).toBe(7);
    const covered = totalHeight(items.slice(start), 120);
    expect(covered).toBeGreaterThanOrEqual(6);
  });

  test('returns 0 when the whole list is needed', () => {
    expect(windowStartIndex(items, 120, 1000)).toBe(0);
  });

  test('empty list returns 0', () => {
    expect(windowStartIndex([], 120, 10)).toBe(0);
  });
});
