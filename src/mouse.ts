// xterm mouse-tracking integration for bk1.
//
// Why this is separate from Ink's useInput(): Ink doesn't expose mouse events. To get
// them we enable xterm's mouse-reporting modes and parse the raw escape sequences
// arriving on stdin ourselves. The terminal emits `\x1b[<{btn};{col};{row}{M|m}` per
// SGR mouse protocol (mode 1006), which is the modern format supporting arbitrary
// coordinates (the older X10 mode 1000 caps out at column 223).
//
// Compatibility caveats users should know about:
//   - iTerm2 / kitty / Ghostty / WezTerm / modern Terminal.app: works out of the box.
//   - tmux: requires `set -g mouse on` in tmux.conf, otherwise tmux intercepts.
//   - Older / minimal terminals: clicks may be silently ignored. No graceful fallback.
//   - Enabling mouse tracking disables native click-drag text selection. On macOS,
//     hold Option (⌥) while dragging to bypass and select text the normal way.
//
// Why we don't strip mouse data from Ink's input stream: Ink uses readline keypress
// events and treats unrecognized escape sequences as no-op key events with empty input.
// In practice mouse clicks don't produce spurious characters in the prompt, but if a
// regression appears, the fix would be to patch process.stdin's data handler upstream
// of Ink — which is invasive enough that we accept the small risk for now.

export interface MouseEvent {
  button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down' | 'other';
  col: number;        // 1-indexed terminal column
  row: number;        // 1-indexed terminal row
  press: boolean;     // true = button-press, false = release
  motion: boolean;    // true if this is a mouse-move event (from mode 1002/1003)
  shift: boolean;     // shift modifier held (bit 2 of SGR button byte)
  alt:   boolean;     // alt/meta modifier held (bit 3)
  ctrl:  boolean;     // ctrl modifier held (bit 4)
}

// SGR mouse protocol pattern. Buttons & modifiers are encoded in the first number;
// 0=left, 1=middle, 2=right, 64=wheel-up, 65=wheel-down. Modifier bits (shift/ctrl/alt)
// add 4/8/16. Motion flag is bit 5 (0x20) — set by modes 1002/1003 on mouse-move.
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export function parseMouseEvents(chunk: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  // Recreate the regex per call so concurrent callers don't trip the shared lastIndex.
  const re = new RegExp(SGR_MOUSE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const raw    = parseInt(m[1]!, 10);
    const motion = (raw & 0x20) !== 0;                // bit 5 = motion flag (set by 1002/1003)
    const shift  = (raw & 0x04) !== 0;                // bit 2 = shift
    const alt    = (raw & 0x08) !== 0;                // bit 3 = alt/meta
    const ctrl   = (raw & 0x10) !== 0;                // bit 4 = ctrl
    const code   = raw & 0b11000011;                  // strip modifier + motion bits; keep button + wheel
    const col    = parseInt(m[2]!, 10);
    const row    = parseInt(m[3]!, 10);
    const press  = m[4] === 'M';
    let button: MouseEvent['button'] = 'other';
    if      (code === 0)  button = 'left';
    else if (code === 1)  button = 'middle';
    else if (code === 2)  button = 'right';
    else if (code === 64) button = 'wheel-up';
    else if (code === 65) button = 'wheel-down';
    events.push({ button, col, row, press, motion, shift, alt, ctrl });
  }
  return events;
}

// Enables basic (1000), any-motion (1003), and SGR (1006) mouse modes. Mode 1003 fires
// on every mouse-move regardless of button state — needed for the pet's eye-tracking.
// Some terminals (or tmux without `mouse on`) silently ignore 1003 and only fire on
// clicks; that gracefully degrades to "eyes don't follow" but everything else works.
export function enableMouseTracking(out: NodeJS.WriteStream): void {
  out.write('\x1b[?1000h\x1b[?1003h\x1b[?1006h');
}

// Disable in reverse order. Must run before bk1 exits or the terminal stays in mouse
// mode after bk1 closes — clicks keep producing garbage characters in the next shell.
//
// We disable a broader set than we ever enable, on the theory that some terminal
// (or downstream library) might have flipped on a sibling mode we don't know about.
// Modes covered:
//   1000  basic press/release
//   1002  button-drag motion
//   1003  any-motion
//   1005  utf-8 mouse encoding
//   1006  SGR encoding
//   1015  urxvt encoding
// Disabling a mode that was never set is a no-op, so this is safe.
export function disableMouseTracking(out: NodeJS.WriteStream): void {
  out.write('\x1b[?1006l\x1b[?1015l\x1b[?1005l\x1b[?1003l\x1b[?1002l\x1b[?1000l');
}

// xterm "modifyOtherKeys" mode 2 — makes the terminal report Shift+Enter,
// Ctrl+Enter, etc. as distinct CSI escape sequences instead of collapsing them
// to bare \r (which is indistinguishable from a plain Enter). Used to detect
// Shift+Enter for multi-line input.
//
// Shift+Enter under this mode arrives as `\x1b[27;2;13~` (CSI 27 ; modifier ; 13 ~):
//   - 27 is the prefix used by xterm-style modifyOtherKeys for "other key"
//   - modifier: 2 = Shift, 3 = Alt, 4 = Shift+Alt, 5 = Ctrl, etc.
//   - 13 is the Enter keycode (0x0D)
//
// Terminals that don't support it ignore the enable sequence; Shift+Enter then
// behaves like plain Enter, which degrades gracefully (no newline, just submit).
// Verified working: VS Code integrated terminal, iTerm2, kitty, Ghostty.
export function enableModifyOtherKeys(out: NodeJS.WriteStream): void {
  out.write('\x1b[>4;2m');
}

export function disableModifyOtherKeys(out: NodeJS.WriteStream): void {
  out.write('\x1b[>4;0m');
}

// Detects the Shift+Enter escape sequence in an input chunk. Returns true if
// any Shift+Enter byte sequence is present. Caller is responsible for treating
// it as a newline insertion and stripping it from the buffer before re-using
// the chunk as printable input.
const SHIFT_ENTER_RE = /\x1b?\[27;2;13~/;
export function isShiftEnter(inputChar: string): boolean {
  return SHIFT_ENTER_RE.test(inputChar);
}
