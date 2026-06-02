import { describe, expect, test } from 'bun:test';
import { normalizeKittyKeys, isNewlineKey } from '../src/mouse';

// Guards the kitty CSI-u -> legacy-byte translation that keeps Escape, Shift+Tab,
// and Ctrl+<letter> working in terminals that honor the kitty keyboard protocol
// (VS Code's xterm.js, kitty, Ghostty). Sequences confirmed via the key inspector.
describe('normalizeKittyKeys', () => {
  test('Escape -> legacy ESC', () => {
    expect(normalizeKittyKeys('\x1b[27u')).toBe('\x1b');
  });

  test('Shift+Tab -> classic backtab', () => {
    expect(normalizeKittyKeys('\x1b[9;2u')).toBe('\x1b[Z');
  });

  test('Ctrl+C/L/T -> legacy control bytes', () => {
    expect(normalizeKittyKeys('\x1b[99;5u')).toBe('\x03');  // Ctrl+C
    expect(normalizeKittyKeys('\x1b[108;5u')).toBe('\x0c'); // Ctrl+L
    expect(normalizeKittyKeys('\x1b[116;5u')).toBe('\x14'); // Ctrl+T
  });

  test('whole lowercase Ctrl range maps to \\x01..\\x1a', () => {
    expect(normalizeKittyKeys('\x1b[97;5u')).toBe('\x01');  // Ctrl+A
    expect(normalizeKittyKeys('\x1b[122;5u')).toBe('\x1a'); // Ctrl+Z
  });

  test('non-letter ctrl combos pass through untouched', () => {
    // Ctrl+Escape (code 27) is not a letter — must not be mangled.
    expect(normalizeKittyKeys('\x1b[27;5u')).toBe('\x1b[27;5u');
  });

  test('Enter+modifier sequences are left for isNewlineKey to detect', () => {
    // normalizeKittyKeys must NOT rewrite these — the newline detector consumes
    // them downstream. Both kitty CSI u and modifyOtherKeys forms, for Shift
    // (mod 2), Alt/Opt (mod 3), and Shift+Alt (mod 4).
    for (const seq of ['\x1b[13;2u', '\x1b[13;3u', '\x1b[13;4u',
                       '\x1b[27;2;13~', '\x1b[27;3;13~', '\x1b[27;4;13~']) {
      expect(normalizeKittyKeys(seq)).toBe(seq);
      expect(isNewlineKey(seq)).toBe(true);
    }
  });

  test('isNewlineKey ignores plain Enter and unrelated sequences', () => {
    expect(isNewlineKey('\r')).toBe(false);
    expect(isNewlineKey('\n')).toBe(false);
    expect(isNewlineKey('\x1b[13;1u')).toBe(false);  // Enter, no modifier
    expect(isNewlineKey('hello')).toBe(false);
  });

  test('plain typed text is unchanged', () => {
    expect(normalizeKittyKeys('hello world')).toBe('hello world');
  });
});
