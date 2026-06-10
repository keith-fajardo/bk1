// Pure windowing math for the alt-screen transcript.
//
// In alt-screen mode bk1 owns its own scrolling (the terminal's native scrollback
// doesn't exist in the alternate buffer). The conversation renders inside a
// fixed-height, overflow-hidden box. Two problems this module solves WITHOUT
// touching React:
//
//   1. Performance: feeding every message of a long session into the box makes Yoga
//      re-lay-out the entire history on every frame (the pet animates on timers, so
//      that's constant). We instead render only a trailing WINDOW of messages large
//      enough to fill the viewport at the current scroll offset. `windowStartIndex`
//      picks that slice.
//   2. Scroll clamping: `totalHeight` lets the caller bound the scroll offset so you
//      can't scroll past the top (the wordmark header) or below the newest line.
//
// The exact on-screen POSITION is handled by flexbox in app.tsx (justifyContent
// flex-end + a negative marginBottom equal to the scroll offset), so the heights
// here only need to be good enough to (a) include enough messages and (b) clamp
// scrolling sensibly. Minor estimation drift shows at most a blank sliver at the very
// top when scrolled to the limit, which self-corrects on the next scroll tick.
//
// Heights MUST track the message JSX in app.tsx (the old <Static items={messages}>
// block and RichMessage / MarkdownTable). If that rendering changes, update this and
// its tests together.

export type TranscriptItem =
  | { kind: 'header'; lines: number }
  | { kind: 'message'; role: 'user' | 'assistant'; content: string; info?: boolean; hasTokens?: boolean };

// Wrapped-line count for `text` at a given content width. Empty string still occupies
// one row. Uses code-unit length (not grapheme width) — close enough for windowing.
function wrappedLines(text: string, width: number): number {
  if (width <= 0) return 1;
  if (text === '') return 1;
  return Math.max(1, Math.ceil(text.length / width));
}

// Height of one rendered MarkdownTable block (mirrors MarkdownTable in app.tsx).
// Valid table (header + separator + N data rows): top border, header row, then per
// data row a mid border + the row, then a bottom border = 3 + 2*dataRows. An invalid
// table falls back to one RichLine per source line.
function tableBlockHeight(lines: string[]): number {
  const isValid = lines.length >= 2 && /^\|[\s\-:|]+\|/.test(lines[1] ?? '');
  if (!isValid) return lines.length;
  const dataRows = lines.length - 2;
  return 3 + 2 * dataRows;
}

// Height of a RichMessage body (assistant, non-info) at content width `cols`.
// Splits into table blocks vs plain lines exactly like RichMessage does, and wraps
// plain lines at the content width. Headings/separators/blank render as a single row
// each but are still wrapped defensively in case they're long.
function richMessageHeight(text: string, width: number): number {
  const allLines = text.split('\n');
  let total = 0;
  let i = 0;
  while (i < allLines.length) {
    if ((allLines[i] ?? '').trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < allLines.length && (allLines[i] ?? '').trimStart().startsWith('|')) {
        tableLines.push(allLines[i]!);
        i++;
      }
      total += tableBlockHeight(tableLines);
    } else {
      total += wrappedLines(allLines[i] ?? '', width);
      i++;
    }
  }
  return total;
}

// Estimated rendered terminal rows for one transcript item, including the 1-row
// bottom margin every message carries. `cols` is process.stdout.columns.
export function estimateMessageHeight(item: TranscriptItem, cols: number): number {
  if (item.kind === 'header') return item.lines;

  // The message wrapper has paddingX={2} (−4 cols) and marginBottom={1} (+1 row).
  const wrapperWidth = Math.max(1, cols - 4);
  const marginBottom = 1;

  if (item.role === 'user') {
    // Bordered round box: width = max(20, cols-5), +2 rows for the top/bottom border,
    // paddingX={1} inside (−2), and the border itself (−2) → inner text width −4.
    const boxWidth = Math.max(20, cols - 5);
    const innerWidth = Math.max(1, boxWidth - 4);
    const body = item.content.split('\n').reduce((n, line) => n + wrappedLines(line, innerWidth), 0);
    return 2 + body + marginBottom;
  }

  if (item.info) {
    const body = item.content.split('\n').reduce((n, line) => n + wrappedLines(line, wrapperWidth), 0);
    return body + marginBottom;
  }

  // Assistant rich message, + an optional one-row token badge.
  return richMessageHeight(item.content, wrapperWidth) + (item.hasTokens ? 1 : 0) + marginBottom;
}

// Sum of all item heights — the total scrollable content height.
export function totalHeight(items: TranscriptItem[], cols: number): number {
  return items.reduce((n, it) => n + estimateMessageHeight(it, cols), 0);
}

// Largest valid scroll offset (in rows from the bottom). 0 when everything fits.
export function computeMaxScroll(items: TranscriptItem[], cols: number, viewportRows: number): number {
  return Math.max(0, totalHeight(items, cols) - viewportRows);
}

// Index of the first item to render so the rendered slice covers at least
// `neededLines` rows measured from the END of the list. Walks backward accumulating
// heights until the budget is met; returns 0 if the whole list is needed. This bounds
// Yoga layout to ~a screenful of messages regardless of session length.
export function windowStartIndex(items: TranscriptItem[], cols: number, neededLines: number): number {
  let acc = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    acc += estimateMessageHeight(items[i]!, cols);
    if (acc >= neededLines) return i;
  }
  return 0;
}
