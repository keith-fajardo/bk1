// Minimal ANSI SGR parser. dbt emits the standard 8/16-color palette via
// `\x1b[<codes>m` sequences; we translate those into Ink-friendly spans so
// PASS/FAIL/WARN coloring survives the pipe→React render path.

export interface AnsiSpan {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

const SGR = /\x1b\[([\d;]*)m/g;

// Maps to chalk color names that Ink's <Text color=…> accepts.
const COLOR: Record<number, string> = {
  30: 'black',   31: 'red',          32: 'green',         33: 'yellow',
  34: 'blue',    35: 'magenta',      36: 'cyan',          37: 'white',
  90: 'gray',    91: 'redBright',    92: 'greenBright',   93: 'yellowBright',
  94: 'blueBright', 95: 'magentaBright', 96: 'cyanBright', 97: 'whiteBright',
};

export function parseAnsi(input: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let state: { color?: string; bold?: boolean; dim?: boolean } = {};
  let pos = 0;
  let m: RegExpExecArray | null;
  SGR.lastIndex = 0;

  while ((m = SGR.exec(input)) !== null) {
    if (m.index > pos) out.push({ text: input.slice(pos, m.index), ...state });
    const codes = (m[1] || '0').split(';').filter(Boolean).map(n => parseInt(n, 10) || 0);
    if (codes.length === 0) state = {};
    for (const c of codes) {
      if (c === 0) state = {};
      else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 22) { state.bold = false; state.dim = false; }
      else if (c === 39) delete state.color;
      else if (COLOR[c]) state.color = COLOR[c];
    }
    pos = m.index + m[0].length;
  }
  if (pos < input.length) out.push({ text: input.slice(pos), ...state });

  // Drop CSI sequences other than SGR (cursor moves, clears) — they'd appear as
  // literal "[2K" etc. otherwise. dbt's progress bars use these.
  return out.map(sp => ({ ...sp, text: sp.text.replace(/\x1b\[[\d;?]*[A-HJKSTfminsulh]/g, '') }))
            .filter(sp => sp.text.length > 0);
}
