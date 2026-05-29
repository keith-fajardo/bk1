import { describe, expect, test } from 'bun:test';
import { parseMouseEvents, normalizeKittyKeys } from '../src/mouse';

describe('parseMouseEvents (xterm SGR protocol)', () => {
  test('parses a left-button press at coords', () => {
    // Format: ESC [ < button ; col ; row M (press) or m (release)
    const events = parseMouseEvents('\x1b[<0;42;15M');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ button: 'left', col: 42, row: 15, press: true, motion: false, shift: false, alt: false, ctrl: false });
  });

  test('parses release (lowercase m) distinctly from press (uppercase M)', () => {
    // press → release pair. Important: if release isn't distinguished, drag operations
    // would constantly fire pet-interactions on every motion update.
    const events = parseMouseEvents('\x1b[<0;5;5M\x1b[<0;5;5m');
    expect(events.map(e => e.press)).toEqual([true, false]);
  });

  test('parses motion event (mode 1003 sets bit 5 / value 32 on the button code)', () => {
    // Pure motion with no button held: button code = 32 (bit 5 set) + 3 (release id) = 35.
    // Without the motion flag we'd mis-classify this as a stray "other" press and possibly
    // route it to the pet-click handler.
    const events = parseMouseEvents('\x1b[<35;12;8M');
    expect(events).toHaveLength(1);
    expect(events[0]?.motion).toBe(true);
    expect(events[0]?.col).toBe(12);
    expect(events[0]?.row).toBe(8);
  });

  test('decodes middle/right/wheel buttons', () => {
    const press = parseMouseEvents('\x1b[<1;1;1M\x1b[<2;1;1M\x1b[<64;1;1M\x1b[<65;1;1M');
    expect(press.map(e => e.button)).toEqual(['middle', 'right', 'wheel-up', 'wheel-down']);
  });

  test('strips modifier bits (shift/ctrl/alt) so plain clicks still classify as left', () => {
    // SGR adds +4 (shift), +8 (alt), +16 (ctrl) to the button code. If we don't mask
    // those off, shift-click reports as "other" and never triggers the pet interaction.
    const events = parseMouseEvents('\x1b[<20;1;1M'); // 16 + 4 = ctrl-shift-left
    expect(events[0]?.button).toBe('left');
    expect(events[0]?.shift).toBe(true);
    expect(events[0]?.ctrl).toBe(true);
    expect(events[0]?.alt).toBe(false);
  });

  test('returns empty array when input contains no mouse escape', () => {
    expect(parseMouseEvents('')).toEqual([]);
    expect(parseMouseEvents('hello world')).toEqual([]);
    // Non-mouse escape (arrow key) must NOT be misparsed as a mouse event.
    expect(parseMouseEvents('\x1b[A')).toEqual([]);
  });

  test('handles multiple events in one stdin chunk (rapid clicks)', () => {
    // Stdin batches data — a fast double-click often arrives as one buffer. The parser
    // must pull all events out, not just the first.
    const events = parseMouseEvents('\x1b[<0;10;10M\x1b[<0;10;10m\x1b[<0;20;20M\x1b[<0;20;20m');
    expect(events).toHaveLength(4);
  });

  test('ignores non-numeric coordinates (defensive against malformed sequences)', () => {
    // A truncated or mangled sequence should not crash the parser. Pin the no-throw
    // behavior so a flaky terminal can't take bk1 down.
    expect(() => parseMouseEvents('\x1b[<0;abc;15M')).not.toThrow();
    expect(parseMouseEvents('\x1b[<0;abc;15M')).toEqual([]);
  });
});

describe('normalizeKittyKeys (kitty disambiguate → legacy bytes)', () => {
  test('rewrites kitty Escape (CSI 27 u) to a lone ESC', () => {
    expect(normalizeKittyKeys('\x1b[27u')).toBe('\x1b');
  });

  test('rewrites kitty Shift+Tab (CSI 9;2 u) to legacy backtab (CSI Z)', () => {
    expect(normalizeKittyKeys('\x1b[9;2u')).toBe('\x1b[Z');
  });

  test('leaves plain Tab (0x09) and other input untouched', () => {
    expect(normalizeKittyKeys('\t')).toBe('\t');
    expect(normalizeKittyKeys('hello')).toBe('hello');
  });

  test('does not touch the kitty Shift+Enter sequence (CSI 13;2 u)', () => {
    // Shift+Enter detection still depends on this reaching the prompt handler.
    expect(normalizeKittyKeys('\x1b[13;2u')).toBe('\x1b[13;2u');
  });

  test('leaves SGR mouse sequences intact', () => {
    expect(normalizeKittyKeys('\x1b[<0;42;15M')).toBe('\x1b[<0;42;15M');
  });

  test('rewrites multiple occurrences in one chunk', () => {
    expect(normalizeKittyKeys('\x1b[27u\x1b[9;2u\x1b[27u')).toBe('\x1b\x1b[Z\x1b');
  });
});
