import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { render, Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent, AgentAbortedError, resetAnthropicClient, type TokenUsage } from './agent';
import { PROJECT_DIR } from './tools';
import { SKILLS, expandSkill } from './skills';
import { getStoredKey, storeKey, clearStoredKey, isValidKeyShape, authFilePath } from './auth';
import { estimateCostUsd, formatUsd } from './pricing';
import { createUsageState, recordUsage, buildReport, renderReport, classifyTurnLabel } from './usage';
import {
  loadPet, savePet, newPet, tickPet, petFace,
  petSprite, petSpriteBlink,
  petSpriteLookLeft, petSpriteLookRight, petSpriteLookUp, petSpriteLookDown,
  petSpriteLookUL, petSpriteLookUR, petSpriteLookDL, petSpriteLookDR,
  renderPetView,
  feed, play, petSleep, rename, autoFeedFromActivity,
  type PetState,
} from './pet';
import { enableMouseTracking, disableMouseTracking, parseMouseEvents } from './mouse';

const MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-7',           label: 'Opus 4.7' },
];
const DEFAULT_MODEL_IDX = Math.max(
  0,
  MODELS.findIndex(m => m.id === (process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6')),
);

const WORDMARK = [
  '██████╗ ██╗  ██╗ ██╗',
  '██╔══██╗██║ ██╔╝███║',
  '██████╔╝█████╔╝ ╚██║',
  '██╔══██╗██╔═██╗  ██║',
  '██████╔╝██║  ██╗ ██║',
  '╚═════╝ ╚═╝  ╚═╝ ╚═╝',
];

interface ToolEvent { name: string; result?: string; }
interface TokenTotals { input: number; output: number; cacheRead: number; }
interface Message { role: 'user' | 'assistant'; content: string; tools?: ToolEvent[]; tokens?: TokenTotals; }

const CMD_COL_WIDTH = 16;

function HRule() {
  const cols = (process.stdout.columns ?? 80) - 4;
  return (
    <Box paddingX={2}>
      <Text color="#5A8060">{'─'.repeat(cols)}</Text>
    </Box>
  );
}

function Suggestions({ suggestions, selectedIndex, input }: {
  suggestions: [string, typeof SKILLS[string]][];
  selectedIndex: number;
  input: string;
}) {
  if (suggestions.length === 0) return null;
  const partial = input.startsWith('/') ? (input.slice(1).split(' ')[0]?.toLowerCase() ?? '') : '';
  const matchLen = partial.length + 1; // +1 for the leading "/"

  return (
    <Box flexDirection="column" marginBottom={0}>
      {suggestions.map(([cmd, skill], i) => {
        const isSelected = i === selectedIndex;
        const fullCmd = '/' + cmd;
        const matched = fullCmd.slice(0, matchLen);
        const rest = fullCmd.slice(matchLen);
        return (
          <Box key={cmd} paddingX={2}>
            <Box width={CMD_COL_WIDTH} flexShrink={0}>
              <Text color="#B9FECF" bold>{matched}</Text>
              <Text color={isSelected ? '#C0FAD2' : '#5A8060'}>{rest}</Text>
            </Box>
            <Text color={isSelected ? '#C0FAD2' : '#5A8060'} wrap="wrap">
              {skill.description}
            </Text>
          </Box>
        );
      })}
      <Box paddingX={2} marginTop={0}>
        <Text color="#5A8060">↑↓ navigate  Tab complete</Text>
      </Box>
    </Box>
  );
}

const MODEL_DESCS: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'Faster · cheaper · good for routine tasks',
  'claude-sonnet-4-6':         'Balanced · recommended for most work',
  'claude-opus-4-7':           'Most capable · best for complex analysis',
};

function ModelPicker({ currentIdx }: { currentIdx: number }) {
  return (
    <Box flexDirection="column" marginBottom={0}>
      {MODELS.map((m, i) => {
        const active = i === currentIdx;
        return (
          <Box key={m.id} paddingX={2} gap={1}>
            <Box width={CMD_COL_WIDTH} flexShrink={0}>
              <Text color={active ? '#C0FAD2' : '#5A8060'} bold={active}>{m.label}</Text>
              <Text color="#B9FECF">{active ? ' ●' : '  '}</Text>
            </Box>
            <Text color={active ? '#7AB890' : '#3D6650'}>{MODEL_DESCS[m.id]}</Text>
          </Box>
        );
      })}
      <Box paddingX={2} marginTop={0}>
        <Text color="#5A8060">↑↓ navigate · Enter confirm</Text>
      </Box>
    </Box>
  );
}

const CONFIRM_OPTIONS = [
  { label: 'Yes', color: '#4ADE80', value: 'yes' },
  { label: 'No',  color: '#F87171', value: 'no'  },
] as const;

function ConfirmBar({ question, selectedIdx }: { question: string; selectedIdx: number }) {
  return (
    <Box paddingX={2} flexDirection="column">
      <Box gap={1}>
        <Text color="#B9FECF">?</Text>
        <Text color="#C0FAD2" bold>{question}</Text>
      </Box>
      <Box paddingLeft={2} gap={0} marginTop={0}>
        {CONFIRM_OPTIONS.map((opt, i) => {
          const active = i === selectedIdx;
          return (
            <Box key={opt.value} gap={1} marginRight={3}>
              <Text color={active ? '#B9FECF' : '#3D6650'}>{'❯'}</Text>
              <Text color={active ? opt.color : '#3D6650'} bold={active}>{opt.label}</Text>
            </Box>
          );
        })}
      </Box>
      <Box paddingLeft={2} marginTop={0}>
        <Text color="#3D6650">←→ navigate · Enter confirm · Y/N quick select</Text>
      </Box>
    </Box>
  );
}

function HintBar({ isRunning }: { isRunning: boolean }) {
  return (
    <Box paddingX={2} paddingBottom={1}>
      {isRunning
        ? <Text color="#3D6650">t  toggle output   Esc  stop agent   Ctrl+C  exit</Text>
        : <Text color="#3D6650">↵ send   Tab switch mode (plan/build/auto)   ↑↓ navigate   /model ↑↓ switch model   Ctrl+C exit</Text>
      }
    </Box>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function TokenBadge({ tokens, dim }: { tokens: TokenTotals; dim?: boolean }) {
  const col = dim ? '#3D6650' : '#5A8060';
  const valCol = dim ? '#5A8060' : '#7AB890';
  return (
    <Box gap={1} paddingLeft={4}>
      <Text color={col}>↑</Text><Text color={valCol}>{fmtTokens(tokens.input)}</Text>
      <Text color={col}>↓</Text><Text color={valCol}>{fmtTokens(tokens.output)}</Text>
      <Text color={col}>tokens</Text>
      {tokens.cacheRead > 0 && (
        <><Text color={col}>·</Text><Text color={dim ? '#3D6650' : '#5A8060'}>{fmtTokens(tokens.cacheRead)} cached</Text></>
      )}
    </Box>
  );
}

function GlowText({ text }: { text: string }) {
  const chars = text.split('');
  const total = chars.length + 6;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % total), 70);
    return () => clearInterval(t);
  }, [total]);

  const colorAt = (dist: number) => {
    if (dist === 0) return '#C0FAD2';
    if (dist === 1) return '#B9FECF';
    if (dist === 2) return '#A8DFBE';
    if (dist === 3) return '#7AB890';
    if (dist === 4) return '#5A8060';
    return '#3D6650';
  };

  return (
    <Box>
      {chars.map((ch, i) => (
        <Text key={i} color={colorAt(Math.abs(i - frame))}>{ch}</Text>
      ))}
    </Box>
  );
}

type Mode = 'plan' | 'build' | 'auto';

const MODE_ORDER: Mode[] = ['plan', 'build', 'auto'];

const MODE_THEME: Record<Mode, { badge: string; accent: string; text: string; label: string }> = {
  plan:  { badge: '#FCD34D', accent: '#FCD34D', text: '#FCD34D', label: 'PLAN' },
  build: { badge: '#B9FECF', accent: '#B9FECF', text: '#C0FAD2', label: 'BUILD' },
  auto:  { badge: '#7DD3FC', accent: '#7DD3FC', text: '#BAE6FD', label: 'AUTO' },
};

function nextMode(m: Mode): Mode {
  return MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length]!;
}

function InputBar({ input, isRunning, mode, modelLabel }: {
  input: string; isRunning: boolean; mode: Mode; modelLabel: string;
}) {
  const theme = MODE_THEME[mode];
  const accent = isRunning ? '#5A8060' : theme.accent;
  const text   = isRunning ? '#5A8060' : theme.text;
  return (
    <Box paddingX={2} gap={1}>
      <Text color={theme.badge} bold>{theme.label}</Text>
      <Text color={accent}>{'>'}</Text>
      <Text color={text}>{input}</Text>
      <Text color={accent}>█</Text>
      <Text color="#3D6650">  {modelLabel}</Text>
    </Box>
  );
}

// Animated pixel pet for the StatusFooter.
//
// Eye direction is driven by the live mouse cursor position (passed in via props from
// App). The pet sits in the StatusFooter at paddingX=2 and is 9 cells wide, so its
// horizontal center is around column 7; its vertical center is approximated as 3 rows
// up from the terminal's bottom edge (sprite is 2 rows + HRule below).
//
// Direction choice: pick the AXIS with larger displacement (|dx| vs |dy|), then look
// in that direction. A small deadzone (±1 col, ±1 row) keeps the eyes from twitching
// when the cursor is right on top of the pet — pet "looks at user" (normal) instead.
//
// Blink overrides eye direction briefly (~180ms) on a jittered ~3–6s schedule so the
// pet feels alive even when the cursor is parked.
type PetFrame =
  | 'normal' | 'blink'
  | 'lookL' | 'lookR' | 'lookU' | 'lookD'
  | 'lookUL' | 'lookUR' | 'lookDL' | 'lookDR';

const PET_CENTER_COL  = 7;
const PET_DEAD_ZONE_X = 1;
const PET_DEAD_ZONE_Y = 1;

function PetSpritePanel({ pet, mouseCol, mouseRow }: {
  pet: PetState;
  mouseCol: number | null;
  mouseRow: number | null;
}) {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout>;
    function schedule() {
      const delay = 3000 + Math.random() * 3000;
      pending = setTimeout(() => {
        setBlinking(true);
        pending = setTimeout(() => {
          setBlinking(false);
          schedule();
        }, 180);
      }, delay);
    }
    schedule();
    return () => clearTimeout(pending);
  }, []);

  // Pet vertical center: terminal_height - 4. Sprite is now 4 terminal rows tall
  // (3 body + 1 legs), plus 1 HRule below, plus ~1 row for HintBar — center sits
  // around 4 rows up from the bottom edge. Approximate is fine — the deadzone
  // absorbs layout drift, and the legs row biases the center upward into the body.
  const petCenterRow = (process.stdout.rows ?? 24) - 4;

  let frame: PetFrame = 'normal';
  if (blinking) {
    frame = 'blink';
  } else if (mouseCol !== null && mouseRow !== null) {
    const dx = mouseCol - PET_CENTER_COL;
    const dy = mouseRow - petCenterRow;
    const xOut = Math.abs(dx) > PET_DEAD_ZONE_X;
    const yOut = Math.abs(dy) > PET_DEAD_ZONE_Y;
    // 9-zone direction lookup: both axes out → diagonal, single axis → cardinal,
    // neither → center (normal). Diagonals fire whenever the cursor is off-center
    // on BOTH axes; previously the "pick larger axis" rule snapped diagonals onto
    // a single cardinal and the up-right / down-left etc. positions were unreachable.
    if (xOut && yOut) {
      if (dx < 0 && dy < 0) frame = 'lookUL';
      else if (dx > 0 && dy < 0) frame = 'lookUR';
      else if (dx < 0 && dy > 0) frame = 'lookDL';
      else frame = 'lookDR';
    } else if (xOut) {
      frame = dx < 0 ? 'lookL' : 'lookR';
    } else if (yOut) {
      frame = dy < 0 ? 'lookU' : 'lookD';
    }
  }

  const sprite =
    frame === 'blink'  ? petSpriteBlink(pet) :
    frame === 'lookR'  ? petSpriteLookRight(pet) :
    frame === 'lookL'  ? petSpriteLookLeft(pet) :
    frame === 'lookU'  ? petSpriteLookUp(pet) :
    frame === 'lookD'  ? petSpriteLookDown(pet) :
    frame === 'lookUL' ? petSpriteLookUL(pet) :
    frame === 'lookUR' ? petSpriteLookUR(pet) :
    frame === 'lookDL' ? petSpriteLookDL(pet) :
    frame === 'lookDR' ? petSpriteLookDR(pet) :
                         petSprite(pet);

  return (
    <Box flexDirection="column">
      {sprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
    </Box>
  );
}

function StatusFooter({ sessionUsd, pet, mouseCol, mouseRow }: {
  sessionUsd: number;
  pet: PetState;
  mouseCol: number | null;
  mouseRow: number | null;
}) {
  const face = petFace(pet);
  const petLabel = pet.name ?? 'pet';
  return (
    <Box paddingX={2} gap={2}>
      <PetSpritePanel pet={pet} mouseCol={mouseCol} mouseRow={mouseRow} />
      {/* Info column sits to the right of the animated sprite. Bottom-aligned so the
          existing single-line readout lines up with the bottom edge of the sprite
          panel rather than floating mid-air. */}
      <Box flexDirection="column" justifyContent="flex-end">
        <Box gap={1}>
          <Text color="#E76F51">{petLabel}:</Text>
          <Text color="#FF9F40">{face}</Text>
          <Text color="#3D6650">·</Text>
          {sessionUsd > 0 && (
            <>
              <Text color="#3D6650">~{formatUsd(sessionUsd)} session</Text>
              <Text color="#3D6650">·</Text>
            </>
          )}
          <Text color="#3D6650">balance</Text>
          <Text color="#5A8060">↗</Text>
          <Text color="cyan">console.anthropic.com/settings/billing</Text>
        </Box>
      </Box>
    </Box>
  );
}

// ── Rich text renderer ─────────────────────────────────────────────────────────

type Span = { text: string; color?: string; bold?: boolean; italic?: boolean };

function parseInline(raw: string): Span[] {
  type Seg = Span & { done?: boolean };
  let segs: Seg[] = [{ text: raw }];

  function pass(re: RegExp, toSpan: (m: RegExpMatchArray) => Span) {
    const out: Seg[] = [];
    for (const seg of segs) {
      if (seg.done) { out.push(seg); continue; }
      let last = 0;
      re.lastIndex = 0;
      let m: RegExpMatchArray | null;
      while ((m = re.exec(seg.text)) !== null) {
        if (m.index! > last) out.push({ text: seg.text.slice(last, m.index) });
        out.push({ ...toSpan(m), done: true });
        last = re.lastIndex;
      }
      if (last < seg.text.length) out.push({ text: seg.text.slice(last) });
    }
    segs = out;
  }

  // Bold and inline code (strip delimiters, show inner text).
  // Bold inline text uses the brand mint — matches the h2 heading shade so an inline
  // **Heading** reads as the same hierarchy level as a `## Heading` line.
  pass(/\*\*([^*\n]+)\*\*/g,  m => ({ text: m[1]!, bold: true, color: '#B9FECF' }));
  pass(/`([^`\n]+)`/g,         m => ({ text: m[1]!, color: '#B9FECF' }));

  // Italic — single `*…*`. Lookarounds prevent matching `select * from` (bare asterisk)
  // or stray asterisks adjacent to word chars. Runs after bold so `**x**` is already taken.
  pass(/(?<![\w*])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?![\w*])/g,
                                m => ({ text: m[1]!, italic: true }));

  // File/folder paths
  pass(/(?:models|target|macros|seeds|tests|analyses|snapshots|logs|dbt_packages)\/[^\s,)'"]+/g,
                                m => ({ text: m[0], color: '#67E8F9' }));
  pass(/~\/[^\s,)'"]+/g,        m => ({ text: m[0], color: '#67E8F9' }));
  pass(/\b[\w.-]+\.(?:sql|yml|yaml|json|toml|md)\b/g,
                                m => ({ text: m[0], color: '#67E8F9' }));

  // dbt model names — anything with a recognised layer prefix and snake_case body.
  // Runs after file-path passes so paths win; backticked code is already marked done.
  pass(/\b(?:stg|int|dim|fct|bridge|rpt|lkp)_[a-z0-9][a-z0-9_]*\b/g,
                                m => ({ text: m[0], color: '#C4B5FD', bold: true }));

  // Severity — blockers/errors/failures (red). `critical` / `severe` rank with `blocker`.
  pass(/\b(?:blocker|blockers?|critical|severe)\b/gi,
                                m => ({ text: m[0], color: '#F87171', bold: true }));
  pass(/\b(?:error|fail(?:ed|ure)?|violations?|missing|absent)\b/gi,
                                m => ({ text: m[0], color: '#F87171' }));
  pass(/❌/g,                   m => ({ text: m[0], color: '#F87171' }));

  // Severity — major / high (orange, bold), warning (orange, no bold).
  pass(/\b(?:major|high)\b/gi,  m => ({ text: m[0], color: '#FB923C', bold: true }));
  pass(/\bwarning\b/gi,         m => ({ text: m[0], color: '#FB923C' }));

  // Severity — minor / moderate / medium (yellow).
  pass(/\b(?:minor|moderate|medium)\b/gi,
                                m => ({ text: m[0], color: '#FCD34D' }));

  // Severity — low / info / notice (muted brand green, low emphasis).
  pass(/\b(?:low|info|notice)\b/gi,
                                m => ({ text: m[0], color: '#7AB890' }));

  // Status — passing (green)
  pass(/\b(?:healthy|passing|success|clean|pass(?:ed)?)\b/gi,
                                m => ({ text: m[0], color: '#4ADE80' }));
  pass(/✅/g,                   m => ({ text: m[0], color: '#4ADE80' }));

  // Health scores like 72/100
  pass(/\b\d+\/100\b/g,         m => ({ text: m[0], color: '#C0FAD2', bold: true }));

  return segs.map(({ text, color, bold, italic }) => ({ text, color, bold, italic }));
}

// Pet stat lines render as "<emoji> <name>  <bar>  <n>%". Color reflects whether
// the value is in healthy range — and hunger is inverted (low=good) versus
// happiness/energy (high=good). Thresholds mirror the mood logic in pet.ts.
function petStatColor(name: string, value: number): string {
  if (name === 'hunger') {
    if (value >= 80) return '#F87171';
    if (value >= 50) return '#FCD34D';
    return '#4ADE80';
  }
  if (name === 'happiness') {
    if (value <= 30) return '#F87171';
    if (value <= 60) return '#FCD34D';
    return '#4ADE80';
  }
  // energy
  if (value <= 30) return '#F87171';
  if (value <= 70) return '#FCD34D';
  return '#4ADE80';
}

function PetStatLine({ prefix, name, gap1, bar, gap2, value }: {
  prefix: string; name: string; gap1: string; bar: string; gap2: string; value: number;
}) {
  const color = petStatColor(name, value);
  const filledCount = (bar.match(/█/g) ?? []).length;
  const filled = '█'.repeat(filledCount);
  const empty  = '░'.repeat(bar.length - filledCount);
  return (
    <Text>
      <Text>{prefix}</Text>
      <Text color={color} bold>{name}</Text>
      <Text>{gap1}</Text>
      <Text color={color}>{filled}</Text>
      <Text color="#3D6650">{empty}</Text>
      <Text>{gap2}</Text>
      <Text color={color} bold>{value}%</Text>
    </Text>
  );
}

// Half-block cell table. Each key is one char from the encoded sprite (alphabet
// defined in pet.ts). Two stacked pixels are rendered into ONE terminal cell using
// the ▀ glyph: foreground paints the upper half, background paints the lower half.
// For cells where both halves are the same color, a space with that background is
// preferred — it fills the font line-leading so cells meet flush vertically
// (the original stripe-elimination trick, applied per cell).
const PET_BODY  = '#9FE749';
const PET_EYE   = '#000000';
const PET_BLINK = '#FCD34D';

interface CellSpec { glyph: string; fg?: string; bg?: string; }
const PET_CELLS: Record<string, CellSpec> = {
  B: { glyph: ' ', bg: PET_BODY },                 // body | body
  V: { glyph: '▀', fg: PET_EYE,   bg: PET_BODY },  // eye-open (top) | body
  M: { glyph: '▄', fg: PET_EYE,   bg: PET_BODY },  // body | eye-open (bottom)
  Y: { glyph: '▀', fg: PET_BLINK, bg: PET_BODY },  // eye-blink | body
  U: { glyph: '▀', fg: PET_BODY },                 // body | empty (legacy: legs / sprite top)
  L: { glyph: '▄', fg: PET_BODY },                 // empty | body  (leg hanging below body)
  ' ': { glyph: ' ' },                              // empty | empty
};

const PET_SPRITE_SENTINEL = '​'; // zero-width space — sprite-line marker

function PetSpriteLine({ line }: { line: string }) {
  const payload = line.startsWith(PET_SPRITE_SENTINEL) ? line.slice(1) : line;
  return (
    <Text>
      {[...payload].map((ch, i) => {
        const spec = PET_CELLS[ch];
        if (!spec) return <Text key={i}>{ch}</Text>;
        if (spec.bg && spec.fg) return <Text key={i} color={spec.fg} backgroundColor={spec.bg}>{spec.glyph}</Text>;
        if (spec.bg)            return <Text key={i} backgroundColor={spec.bg}>{spec.glyph}</Text>;
        if (spec.fg)            return <Text key={i} color={spec.fg}>{spec.glyph}</Text>;
        return <Text key={i}>{spec.glyph}</Text>;
      })}
    </Text>
  );
}

// Same backgrounded-space trick as PetSpriteLine, applied to the WORDMARK banner.
// `█` cells become a colored space so the entire cell (including font line-leading)
// is filled — eliminates the horizontal stripes that appear between stacked rows of
// `█`. Box-drawing edges (╗ ╔ ═ ║ ╝ ╚) stay as foreground glyphs because they're
// designed to meet at cell boundaries and look fine on the terminal background.
function WordmarkLine({ line, color }: { line: string; color: string }) {
  return (
    <Text>
      {[...line].map((ch, i) =>
        ch === '█'
          ? <Text key={i} backgroundColor={color}> </Text>
          : <Text key={i} color={color}>{ch}</Text>
      )}
    </Text>
  );
}

function RichLine({ line }: { line: string }) {
  // Pet sprite line: identified by the zero-width-space sentinel that pet.ts prefixes
  // onto every encoded sprite row. Match before any markdown logic so the encoded
  // payload chars (BVYU) aren't interpreted as text.
  if (line.startsWith(PET_SPRITE_SENTINEL)) {
    return <PetSpriteLine line={line} />;
  }

  // Pet stat line: "<emoji> hunger     ░░░░░░░░░░  0%". Match before headings/inline
  // because the bar glyphs would otherwise pass through as ordinary text.
  const pet = line.match(/^(.*?)(hunger|happiness|energy)(\s+)([█░]+)(\s+)(\d+)%\s*$/);
  if (pet) {
    return (
      <PetStatLine
        prefix={pet[1]!} name={pet[2]!} gap1={pet[3]!}
        bar={pet[4]!}    gap2={pet[5]!} value={parseInt(pet[6]!, 10)}
      />
    );
  }

  // Strip markdown heading markers, apply hierarchy colors
  const h3 = line.match(/^### (.+)/);
  if (h3) return <Text bold color="#A8DFBE">{h3[1]!}</Text>;
  const h2 = line.match(/^## (.+)/);
  if (h2) return <Text bold color="#B9FECF">{h2[1]!}</Text>;
  const h1 = line.match(/^# (.+)/);
  if (h1) return <Text bold color="#C0FAD2">{h1[1]!}</Text>;

  // Separator lines (---, ───, etc.)
  if (line.trim().length > 0 && /^[\s─\-=]{3,}$/.test(line)) {
    return <Text color="#3D6650">{line}</Text>;
  }

  // Blank line — preserve spacing
  if (line.trim() === '') return <Text>{' '}</Text>;

  const spans = parseInline(line);
  return (
    <Text wrap="wrap">
      {spans.map((s, i) =>
        s.color || s.bold || s.italic
          ? <Text key={i} color={s.color} bold={!!s.bold} italic={!!s.italic}>{s.text}</Text>
          : <Text key={i}>{s.text}</Text>
      )}
    </Text>
  );
}

function MarkdownTable({ lines }: { lines: string[] }) {
  const parseRow = (line: string) =>
    line.split('|').slice(1, -1).map(c => c.trim());

  if (lines.length < 2 || !/^\|[\s\-:|]+\|/.test(lines[1]!)) {
    return <Box flexDirection="column">{lines.map((l, i) => <RichLine key={i} line={l} />)}</Box>;
  }

  // Strip markdown bold/code/italic markers from header text before measuring/rendering
  const stripMd = (s: string) => s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(?<![\w*])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?![\w*])/g, '$1');

  const headers  = parseRow(lines[0]!).map(stripMd);
  const sepCells = parseRow(lines[1]!);
  const alignments = sepCells.map((s): 'left' | 'right' | 'center' => {
    if (s.startsWith(':') && s.endsWith(':')) return 'center';
    if (s.endsWith(':')) return 'right';
    return 'left';
  });
  const dataRows = lines.slice(2).map(parseRow);
  const colCount = headers.length;

  const colWidths = Array.from({ length: colCount }, (_, ci) =>
    Math.max(headers[ci]?.length ?? 0, ...dataRows.map(r => (r[ci] ?? '').length))
  );

  const pad = (text: string, width: number, align: 'left' | 'right' | 'center') => {
    if (align === 'right') return text.padStart(width);
    if (align === 'center') {
      const p = width - text.length;
      return ' '.repeat(Math.floor(p / 2)) + text + ' '.repeat(Math.ceil(p / 2));
    }
    return text.padEnd(width);
  };

  // Full-width border strings built once
  const top    = '┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
  const mid    = '├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
  const bottom = '└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

  // Rows as single pre-padded strings — single Text per row guarantees alignment
  const headerCells = headers.map((h, ci) => pad(h, colWidths[ci]!, 'center'));
  const dataStrs  = dataRows.map(row =>
    '│ ' + colWidths.map((_, ci) => pad(row[ci] ?? '', colWidths[ci]!, alignments[ci]!)).join(' │ ') + ' │'
  );

  const BORDER = '#5A8060';

  return (
    <Box flexDirection="column">
      <Text bold color={BORDER}>{top}</Text>
      <Text>
        <Text color={BORDER}>│ </Text>
        {headerCells.map((cell, ci) => (
          <Text key={ci}>
            <Text bold color="#B9FECF">{cell}</Text>
            <Text color={BORDER}>{ci === headerCells.length - 1 ? ' │' : ' │ '}</Text>
          </Text>
        ))}
      </Text>
      {dataStrs.map((rowStr, ri) => (
        <Box key={ri} flexDirection="column">
          <Text bold color={BORDER}>{mid}</Text>
          <Text>
            {parseInline(rowStr).map((s, si) =>
              s.color
                ? <Text key={si} color={s.color} bold>{s.text}</Text>
                : <Text key={si} color={BORDER} bold>{s.text}</Text>
            )}
          </Text>
        </Box>
      ))}
      <Text bold color={BORDER}>{bottom}</Text>
    </Box>
  );
}

function RichMessage({ text }: { text: string }) {
  const allLines = text.split('\n');
  type Block = { type: 'table'; lines: string[] } | { type: 'line'; content: string };
  const blocks: Block[] = [];

  let i = 0;
  while (i < allLines.length) {
    if (allLines[i]!.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < allLines.length && allLines[i]!.trimStart().startsWith('|')) {
        tableLines.push(allLines[i]!);
        i++;
      }
      blocks.push({ type: 'table', lines: tableLines });
    } else {
      blocks.push({ type: 'line', content: allLines[i]! });
      i++;
    }
  }

  return (
    <Box flexDirection="column">
      {blocks.map((block, bi) =>
        block.type === 'table'
          ? <MarkdownTable key={bi} lines={block.lines} />
          : <RichLine key={bi} line={block.content} />
      )}
    </Box>
  );
}

interface SemanticAgent { label: string; done: boolean; }
interface SemanticProgress { agents: SemanticAgent[]; }

interface LintProgress {
  phase: 'syncing' | 'scanning' | 'analyzing' | 'semantic' | 'recording';
  batchSize: number;     // set after model_state(queue) returns
  modelsRecorded: number;
  estimatedMs: number;   // refined once batchSize is known
  startedAt: number;
  scanStartedAt: number | null;  // set when bash starts, used for scan interpolation
  currentModel: string;          // name of the model currently being processed
  queueModels: string[];         // ordered list from queue — used to show name during scanning
}

const PHASE_LABEL: Record<LintProgress['phase'], string> = {
  syncing:   'Syncing model state',
  scanning:  'Scanning files',
  analyzing: 'Analyzing violations',
  semantic:  'Semantic checks',
  recording: 'Recording results',
};

// Estimate: 15s LLM overhead + 0.15s per model for mechanical scan
function estimateLintMs(batchSize: number) {
  return (15 + batchSize * 0.15) * 1000;
}

function LintProgressBar({ progress }: { progress: LintProgress }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const elapsed   = now - progress.startedAt;
  const ratio     = Math.min(0.95, elapsed / Math.max(progress.estimatedMs, 1));
  const width     = 20;
  const filled    = Math.round(ratio * width);
  const bar       = '█'.repeat(filled) + '░'.repeat(width - filled);
  const elapsedS  = Math.round(elapsed / 1000);
  const remainS   = Math.max(0, Math.round((progress.estimatedMs - elapsed) / 1000));

  // During scanning: interpolate estimated count from elapsed time in this phase.
  // bk1-lint (Rust) runs at ~120ms/model; show with ~ to signal it's an estimate.
  let phaseLabel = PHASE_LABEL[progress.phase];
  let modelLabel = progress.currentModel;

  if (progress.phase === 'scanning' && progress.batchSize > 0) {
    const elapsedInScan = progress.scanStartedAt ? now - progress.scanStartedAt : 0;
    const msPerModel = 120;
    const estimated = Math.min(progress.batchSize - 1, Math.round(elapsedInScan / msPerModel));
    phaseLabel = `Scanning ~${estimated}/${progress.batchSize} models`;
    modelLabel = progress.queueModels[estimated] ?? '';
  } else if (progress.phase === 'analyzing') {
    phaseLabel = 'Analyzing violations';
  } else if (progress.phase === 'recording' && progress.batchSize > 0) {
    phaseLabel = `Recording results  ${progress.modelsRecorded}/${progress.batchSize}`;
  }

  return (
    <Box flexDirection="column" paddingLeft={4}>
      <Box gap={1}>
        <Text color="#B9FECF">[{bar}]</Text>
        <Text color="#5A8060">{elapsedS}s</Text>
        {remainS > 0 && <Text color="#3D6650">· ~{remainS}s left</Text>}
      </Box>
      <Box gap={2}>
        <Text color="#7AB890">{phaseLabel}</Text>
        {modelLabel && <Text color="#5A8060">{modelLabel}</Text>}
      </Box>
    </Box>
  );
}

function SemanticProgressBar({ progress }: { progress: SemanticProgress }) {
  const { agents } = progress;
  const done  = agents.filter(a => a.done).length;
  const total = agents.length;
  const width = 10;
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return (
    <Box flexDirection="column" paddingLeft={4}>
      <Box gap={1}>
        <Text color="#5A8060">Semantic checks</Text>
        <Text color="#B9FECF">[{bar}]</Text>
        <Text color="#7AB890">{done}/{total}</Text>
      </Box>
      {agents.map((a, i) => (
        <Box key={i} gap={1} paddingLeft={2}>
          <Text color={a.done ? '#4ADE80' : '#FCD34D'}>{a.done ? '✓' : '●'}</Text>
          <Text color={a.done ? '#5A8060' : '#7AB890'}>{a.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── Login screen ────────────────────────────────────────────────────────────
//
// Shown before the main TUI when no API key is found in env or ~/.bk1/auth.json.
// Uses its own useInput handler so none of the main App's input plumbing (cursor,
// history, suggestions, etc.) is touched. Renders asterisks for the typed/pasted
// key — the actual value is held only in component state, never logged.

function LoginScreen({ onLogin }: { onLogin: (key: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.return) {
      const trimmed = value.trim();
      if (!isValidKeyShape(trimmed)) {
        setError('Key must start with "sk-ant-" and be at least 20 characters.');
        return;
      }
      setError(null);
      onLogin(trimmed);
      return;
    }
    if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1));
      return;
    }
    if (key.escape) {
      // ESC clears the field so the user can retry a paste from scratch.
      setValue('');
      setError(null);
      return;
    }
    // Ignore other special keys (arrows, tab, etc.) — we only want printable chars.
    // `input` is a string of one or more characters (a paste arrives as one chunk).
    if (input && !key.ctrl && !key.meta) {
      // Strip any newlines/tabs the terminal might inject during paste.
      const cleaned = input.replace(/[\r\n\t]/g, '');
      if (cleaned.length > 0) {
        setValue(v => v + cleaned);
        if (error) setError(null);
      }
    }
  });

  const masked = '*'.repeat(value.length);
  const placeholder = '(paste your sk-ant-... key and press Enter)';

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} flexDirection="column">
        {WORDMARK.map((line, i) => <WordmarkLine key={i} line={line} color="cyan" />)}
      </Box>
      <Text bold>bk1 login</Text>
      <Box marginTop={1}>
        <Text>Paste your Anthropic API key. Get one at </Text>
        <Text color="cyan">https://console.anthropic.com/settings/keys</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">key › </Text>
        <Text color={value.length === 0 ? 'gray' : 'white'}>
          {value.length === 0 ? placeholder : masked}
        </Text>
      </Box>
      {error && (
        <Box marginTop={1}><Text color="red">{error}</Text></Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">
          Enter to submit · Esc to clear · Backspace to edit · Stored at {authFilePath()} (chmod 0600)
        </Text>
      </Box>
    </Box>
  );
}

// ─── Top-level auth gate ─────────────────────────────────────────────────────
//
// Holds the auth state above App so /logout can flip it back to LoginScreen
// without restarting the process. On mount: try env, then stored file. If a key
// is found, it's pushed into process.env so the SDK picks it up.

function AppShell() {
  const [authed, setAuthed] = useState<boolean>(() => {
    const k = getStoredKey();
    if (k) {
      process.env.ANTHROPIC_API_KEY = k;
      return true;
    }
    return false;
  });

  // Enable xterm mouse tracking once at startup, disable on every exit path. Without the
  // explicit disable, the terminal stays in mouse mode after bk1 closes and any clicks
  // in the next shell print garbage escape sequences — really bad UX. We hook SIGINT
  // and the `exit` event so accidental kills still restore the terminal.
  useEffect(() => {
    enableMouseTracking(process.stdout);
    const restore = () => disableMouseTracking(process.stdout);
    process.on('exit', restore);
    process.on('SIGINT', () => { restore(); process.exit(0); });
    process.on('SIGTERM', restore);
    return () => {
      restore();
      process.off('exit', restore);
      process.off('SIGTERM', restore);
    };
  }, []);

  const handleLogin = useCallback((key: string) => {
    storeKey(key);
    process.env.ANTHROPIC_API_KEY = key;
    resetAnthropicClient(); // discard any client that might have been built without a key
    setAuthed(true);
  }, []);

  const handleLogout = useCallback(() => {
    clearStoredKey();
    delete process.env.ANTHROPIC_API_KEY;
    resetAnthropicClient();
    setAuthed(false);
  }, []);

  if (!authed) return <LoginScreen onLogin={handleLogin} />;
  return <App onLogout={handleLogout} />;
}

function App({ onLogout }: { onLogout: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [liveText, setLiveText] = useState('');
  const [activeTool, setActiveTool] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [liveExpanded, setLiveExpanded] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [mode, setMode] = useState<Mode>('plan');
  const [modelIdx, setModelIdx] = useState(DEFAULT_MODEL_IDX);
  const [semanticProgress, setSemanticProgress] = useState<SemanticProgress | null>(null);
  const [lintProgress, setLintProgress] = useState<LintProgress | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<string | null>(null);
  const [confirmSelected, setConfirmSelected] = useState(0);
  const [liveTokens, setLiveTokens] = useState<TokenTotals | null>(null);

  const inputRef = useRef('');
  const isRunningRef = useRef(false);
  const historyRef = useRef<Anthropic.MessageParam[]>([]);
  // Refs so submit() (useCallback []) always reads the latest values
  const modelIdxRef = useRef(DEFAULT_MODEL_IDX);
  const modeRef = useRef<Mode>('plan');
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => { modelIdxRef.current = modelIdx; }, [modelIdx]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  // Lint phase tracking refs — readable inside the memoised submit callback
  const lintProgressRef = useRef<LintProgress | null>(null);
  const lastModelStateActionRef = useRef<string | null>(null);
  useEffect(() => { lintProgressRef.current = lintProgress; }, [lintProgress]);
  const tokenAccRef = useRef<TokenTotals>({ input: 0, output: 0, cacheRead: 0 });

  // Per-app-instance running USD estimate. Resets only on process restart, not per submit.
  // Tracks per-model totals separately so a Sonnet call and a Haiku sub-agent call are billed
  // at their actual rates instead of being smeared into a single average.
  const sessionTokensByModelRef = useRef<Record<string, {
    input: number; output: number; cacheRead: number; cacheWrite: number;
  }>>({});
  const [sessionUsd, setSessionUsd] = useState(0);

  // /usage tracking — full attribution by turn-label (which command started the turn) +
  // sub-agent description. Holds the same data as sessionTokensByModelRef but at a finer
  // granularity, so we can answer "which process burned the most tokens" not just
  // "what was the total spend."
  const usageStateRef = useRef(createUsageState());
  const currentTurnLabelRef = useRef<string>('chat');

  // Pet — persistent Tamagotchi state at ~/.bk1/pet.json. Lazy-init on first render:
  // if no file exists, hatch a fresh egg. tickPet() runs immediately so the StatusFooter
  // shows the correct mood reflecting any time elapsed since last launch.
  const [pet, setPet] = useState<PetState>(() => {
    const loaded = loadPet();
    const initial = loaded ? tickPet(loaded) : newPet();
    savePet(initial);
    return initial;
  });
  // Mirror the latest pet in a ref so the closure in onUsage (registered once) can read
  // the freshest value without re-creating callbacks every render.
  const petRef = useRef(pet);
  useEffect(() => { petRef.current = pet; }, [pet]);

  // Live mouse cursor position — drives the pet's eye-tracking. `null` means we haven't
  // seen any motion event yet (eyes stay centered). Throttled to ~100ms updates so a
  // fast cursor doesn't cause a re-render storm; the eye direction only has 5 states
  // (L/R/U/D/center), so finer resolution is wasted.
  const [mouseCol, setMouseCol] = useState<number | null>(null);
  const [mouseRow, setMouseRow] = useState<number | null>(null);
  const lastMouseUpdateRef = useRef(0);

  // Mouse click → pet interaction. Mouse motion → eye tracking.
  //
  // Listen to raw stdin and parse xterm SGR mouse escape sequences. A left-press
  // anywhere in the bottom rows (where StatusFooter lives) is treated as "the user
  // tapped the pet" and routed to play() — boosts happiness, costs a little energy.
  // Motion events update mouseCol so the pet's eyes follow the cursor.
  //
  // Why the bottom-rows heuristic and not pixel-accurate hit detection on the pet's
  // actual columns? Ink doesn't expose component render coordinates, and the pet face
  // shifts width with name + mood. A generous click target is more forgiving and the
  // worst case is "user clicked the cost text and pet got happier" — harmless.
  useEffect(() => {
    const handler = (data: Buffer) => {
      const events = parseMouseEvents(data.toString('utf8'));
      for (const ev of events) {
        if (ev.motion) {
          // Throttle: at most one state update per 100ms — mouse-move can fire >60Hz.
          const now = Date.now();
          if (now - lastMouseUpdateRef.current >= 100) {
            lastMouseUpdateRef.current = now;
            setMouseCol(ev.col);
            setMouseRow(ev.row);
          }
          continue;
        }
        if (ev.button !== 'left' || !ev.press) continue;
        const totalRows = process.stdout.rows ?? 24;
        // StatusFooter is the line above the HintBar; allow a 3-row band to absorb
        // terminal padding differences.
        if (ev.row >= totalRows - 3 && ev.row <= totalRows) {
          const petted = play(petRef.current);
          petRef.current = petted;
          setPet(petted);
          savePet(petted);
        }
      }
    };
    process.stdin.on('data', handler);
    return () => { process.stdin.off('data', handler); };
  }, []);

  const isModelPicker = input.startsWith('/model');

  const suggestions = useMemo(() => {
    if (isModelPicker) return [] as [string, typeof SKILLS[string]][];
    if (!input.startsWith('/')) return [] as [string, typeof SKILLS[string]][];
    const partial = input.slice(1).split(' ')[0]?.toLowerCase() ?? '';
    return Object.entries(SKILLS).filter(([cmd]) => cmd.startsWith(partial)) as [string, typeof SKILLS[string]][];
  }, [input, isModelPicker]);

  const submit = useCallback(async () => {
    const raw = inputRef.current.trim();
    if (!raw || isRunningRef.current) return;
    setConfirmPrompt(null);

    // Local UI commands — handled here, never sent to the agent
    if (raw === '/plan' || raw === '/build' || raw === '/auto') {
      const next = raw.slice(1) as Mode;
      setMode(next); modeRef.current = next;
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      return;
    }
    if (raw.startsWith('/model')) {
      // Tab already cycled the selection — Enter just closes the picker
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      return;
    }
    if (raw === '/logout') {
      // Intercept before expandSkill — /logout is a UI-state transition, not a prompt
      // for the agent. AppShell handles clearing the key and re-rendering the login
      // screen; we just clear input and trigger.
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      onLogout();
      return;
    }
    if (raw === '/usage') {
      // Local report — no LLM call. Inject the formatted breakdown as an assistant
      // message so it appears in the chat scroll just like other responses.
      const report = renderReport(buildReport(usageStateRef.current));
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      setMessages(prev => [
        ...prev,
        { role: 'user',      content: raw },
        { role: 'assistant', content: report },
      ]);
      return;
    }
    if (raw === '/pet' || raw.startsWith('/pet ')) {
      // Local handler — all pet interactions are pure state updates against the on-disk
      // pet.json. No LLM call, no token spend. Each interaction ticks first so elapsed
      // time decay is applied before the action takes effect.
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      const args = raw.slice('/pet'.length).trim();
      const [sub, ...rest] = args.split(/\s+/);
      const arg = rest.join(' ');

      let nextPet = petRef.current;
      let note: string | null = null;
      if (sub === '' || sub === undefined) {
        // Bare /pet — just show the view, no state change.
        nextPet = tickPet(nextPet);
      } else if (sub === 'feed') {
        nextPet = feed(nextPet);
        note = `You fed ${nextPet.name ?? 'your pet'}.`;
      } else if (sub === 'play') {
        nextPet = play(nextPet);
        note = `You played with ${nextPet.name ?? 'your pet'}.`;
      } else if (sub === 'sleep') {
        nextPet = petSleep(nextPet);
        note = `${nextPet.name ?? 'Your pet'} fell asleep. Energy restored.`;
      } else if (sub === 'name') {
        if (!arg) {
          note = 'Usage: /pet name <name>';
        } else {
          nextPet = rename(nextPet, arg);
          note = nextPet.name ? `Your pet is now named ${nextPet.name}.` : 'Name unchanged (empty input).';
        }
      } else if (sub === 'release') {
        // Goodbye + immediate fresh start. Destructive (loses name, age, stats) but
        // explicit — the user typed the word "release" so we don't gate behind a confirm.
        const farewellName = nextPet.name ?? 'your pet';
        nextPet = newPet();
        note = `You released ${farewellName} back into the mangroves. A new egg appears.`;
      } else {
        note = `Unknown /pet subcommand "${sub}". Try: /pet · /pet feed · /pet play · /pet sleep · /pet name <name> · /pet release`;
      }

      petRef.current = nextPet;
      setPet(nextPet);
      savePet(nextPet);

      // Render view AFTER the action so the user sees the updated stats and face.
      const body = (note ? note + '\n\n' : '') + renderPetView(nextPet);
      setMessages(prev => [
        ...prev,
        { role: 'user',      content: raw },
        { role: 'assistant', content: body },
      ]);
      return;
    }

    // Label this turn for /usage attribution BEFORE any LLM call fires. Sub-agents
    // spawned during this turn will inherit it via the closure in onUsage.
    currentTurnLabelRef.current = classifyTurnLabel(raw);

    const skill = expandSkill(raw);
    const displayText = skill ? skill.display : raw;
    const promptText = skill ? skill.prompt : raw;

    setInput('');
    inputRef.current = '';
    setSuggestionIndex(-1);
    isRunningRef.current = true;
    setIsRunning(true);
    setLiveExpanded(false);
    setLiveText('');
    setSemanticProgress(null);
    tokenAccRef.current = { input: 0, output: 0, cacheRead: 0 };
    setLiveTokens(null);

    setMessages(prev => [...prev, { role: 'user', content: displayText }]);
    historyRef.current.push({ role: 'user', content: promptText });

    const controller = new AbortController();
    abortRef.current = controller;

    let fullText = '';
    const toolLog: ToolEvent[] = [];

    try {
      const updated = await runAgent(
        historyRef.current,
        {
          onText: (chunk) => { fullText += chunk; setLiveText(fullText); },
          onToolStart: (name, input) => {
            setActiveTool(name);
            toolLog.push({ name });

            if (name.startsWith('Semantic:')) {
              const label = name.slice('Semantic: '.length);
              setSemanticProgress(p => ({ agents: [...(p?.agents ?? []), { label, done: false }] }));
              setLintProgress(p => p ? { ...p, phase: 'semantic',
                estimatedMs: Math.max(p.estimatedMs, (Date.now() - p.startedAt) + 40_000) } : p);
            }

            if (name === 'model_state') {
              const action = input.action as string;
              lastModelStateActionRef.current = action;
              if (action === 'sync') {
                setLintProgress({ phase: 'syncing', batchSize: 0, modelsRecorded: 0,
                  estimatedMs: 30_000, startedAt: Date.now(), scanStartedAt: null,
                  currentModel: '', queueModels: [] });
              }
              if (action === 'mark_linted' && lintProgressRef.current) {
                const modelName = (input.model_name as string | undefined) ?? '';
                setLintProgress(p => p ? { ...p, phase: 'recording',
                  modelsRecorded: p.modelsRecorded + 1,
                  currentModel: modelName || p.currentModel } : p);
              }
            }

            if (name === 'bash' && lintProgressRef.current) {
              setLintProgress(p => p ? { ...p, phase: 'scanning', scanStartedAt: Date.now() } : p);
            }
            if (name === 'read_file' && lintProgressRef.current) {
              const modelName = (input.path as string).match(/([^/\\]+)\.sql$/)?.[1] ?? '';
              setLintProgress(p => p ? {
                ...p,
                phase: p.phase === 'scanning' ? 'analyzing' : p.phase,
                ...(modelName ? { currentModel: modelName } : {}),
              } : p);
            }
          },
          onUsage: (u: TokenUsage, model: string, subAgentLabel?: string) => {
            const acc = tokenAccRef.current;
            const next = {
              input:     acc.input     + u.inputTokens,
              output:    acc.output    + u.outputTokens,
              cacheRead: acc.cacheRead + u.cacheReadTokens,
            };
            tokenAccRef.current = next;
            setLiveTokens({ ...next });

            // Accumulate per-model totals across the whole app session, then recompute
            // the running USD estimate. Doing this incrementally per call (rather than
            // re-summing the whole map) keeps it O(1) — important when sub-agents fire
            // many small updates during a parallel /lint-deep run.
            const bucket = sessionTokensByModelRef.current[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            bucket.input      += u.inputTokens;
            bucket.output     += u.outputTokens;
            bucket.cacheRead  += u.cacheReadTokens;
            bucket.cacheWrite += u.cacheWriteTokens;
            sessionTokensByModelRef.current[model] = bucket;
            let total = 0;
            for (const [m, t] of Object.entries(sessionTokensByModelRef.current)) {
              total += estimateCostUsd(t, m);
            }
            setSessionUsd(total);

            // Finer-grained attribution for /usage: bucket by turn label + sub-agent label.
            // currentTurnLabelRef is set at submit start, so every API call inside this
            // turn — main agent and any sub-agents — gets the right turn attribution.
            recordUsage(usageStateRef.current, {
              turnLabel: currentTurnLabelRef.current,
              subAgentLabel,
              model,
              input:      u.inputTokens,
              output:     u.outputTokens,
              cacheRead:  u.cacheReadTokens,
              cacheWrite: u.cacheWriteTokens,
            });

            // Each LLM call feeds the pet a little (your tokens are its food). We tick
            // off the latest petRef so this composes cleanly with elapsed-time decay.
            const fed = autoFeedFromActivity(petRef.current);
            petRef.current = fed;
            setPet(fed);
            savePet(fed);
          },
          onToolEnd: (name, result) => {
            setActiveTool('');
            if (toolLog.length > 0) toolLog[toolLog.length - 1]!.result = result.substring(0, 300);
            if (name.startsWith('Semantic:')) {
              const label = name.slice('Semantic: '.length);
              setSemanticProgress(p => p
                ? { agents: p.agents.map(a => a.label === label ? { ...a, done: true } : a) }
                : null);
            }
            // model_state(queue) result contains batch size + model list — refine estimate
            if (name === 'model_state' && lastModelStateActionRef.current === 'queue') {
              try {
                const data = JSON.parse(result) as { batch?: number; queue?: Array<{ name: string }> };
                const batchSize = data.batch ?? 0;
                const queueModels = (data.queue ?? []).map(m => m.name);
                if (batchSize > 0) {
                  setLintProgress(p => p ? { ...p, batchSize, queueModels,
                    estimatedMs: estimateLintMs(batchSize) } : p);
                }
              } catch { /* ignore */ }
            }
          },
        },
        { model: MODELS[modelIdxRef.current]!.id, mode: modeRef.current, signal: controller.signal },
      );
      historyRef.current = updated;
      const trimmed = fullText.trim();
      const finalTokens = { ...tokenAccRef.current };
      setMessages(prev => [...prev, { role: 'assistant', content: trimmed, tools: toolLog, tokens: finalTokens }]);
      // Detect trailing (yes / no) prompts and surface as an interactive confirm bar
      const lastLine = trimmed.split('\n').pop()?.trim() ?? '';
      if (/\(yes\s*\/\s*no\)\s*$/i.test(lastLine)) {
        setConfirmSelected(0);
        setConfirmPrompt(lastLine.replace(/\s*\(yes\s*\/\s*no\)\s*$/i, '').trim());
      }
    } catch (err) {
      if (err instanceof AgentAbortedError) {
        const partial = fullText.trim();
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: partial ? `${partial}\n\n[Interrupted by user]` : '[Interrupted by user]',
          tools: toolLog,
          tokens: { ...tokenAccRef.current },
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }]);
      }
    } finally {
      abortRef.current = null;
      setLiveText('');
      setActiveTool('');
      setIsRunning(false);
      setLintProgress(null);
      isRunningRef.current = false;
    }
  }, []);

  useInput((inputChar, key) => {
    // Ctrl+C always exits. ESC interrupts a running agent; when idle, ESC is a no-op
    // so users can't accidentally kill the app with one keystroke.
    if (key.ctrl && inputChar === 'c') process.exit(0);
    if (key.escape) {
      if (isRunningRef.current) abortRef.current?.abort();
      return;
    }
    if (isRunningRef.current) {
      if (inputChar === 't') setLiveExpanded(e => !e);
      return;
    }

    // Confirm bar — arrow keys navigate, Enter confirms, Y/N quick-select
    if (confirmPrompt !== null) {
      if (key.leftArrow || key.upArrow)   { setConfirmSelected(0); return; }
      if (key.rightArrow || key.downArrow) { setConfirmSelected(1); return; }
      if (key.return) {
        inputRef.current = CONFIRM_OPTIONS[confirmSelected]!.value;
        void submit();
        return;
      }
      if (inputChar === 'y' || inputChar === 'Y') { inputRef.current = 'yes'; void submit(); }
      else if (inputChar === 'n' || inputChar === 'N') { inputRef.current = 'no'; void submit(); }
      return;
    }

    // /model arrow cycling — up/down navigate models without submitting
    if (inputRef.current.startsWith('/model')) {
      if (key.upArrow) {
        const next = (modelIdx - 1 + MODELS.length) % MODELS.length;
        setModelIdx(next); modelIdxRef.current = next;
      } else if (key.downArrow) {
        const next = (modelIdx + 1) % MODELS.length;
        setModelIdx(next); modelIdxRef.current = next;
      }
      return;
    }

    // Navigate suggestions with arrow keys
    if (suggestions.length > 0) {
      if (key.upArrow) {
        setSuggestionIndex(i => Math.max(-1, i - 1));
        return;
      }
      if (key.downArrow) {
        setSuggestionIndex(i => Math.min(suggestions.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const idx = suggestionIndex >= 0 ? suggestionIndex : (suggestions.length === 1 ? 0 : -1);
        if (idx >= 0 && suggestions[idx]) {
          const [cmd, skill] = suggestions[idx]!;
          const needsArg = skill.usage.includes('<');
          const next = `/${cmd}${needsArg ? ' ' : ''}`;
          inputRef.current = next;
          setInput(next);
          setSuggestionIndex(-1);
        }
        return;
      }
    }

    // Tab with no slash-completion in flight → cycle agent mode
    if (key.tab) {
      const next = nextMode(modeRef.current);
      setMode(next); modeRef.current = next;
      return;
    }

    if (key.return) {
      if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
        const [cmd, skill] = suggestions[suggestionIndex]!;
        const needsArg = skill.usage.includes('<');
        const next = `/${cmd}${needsArg ? ' ' : ''}`;
        inputRef.current = next;
        setInput(next);
        setSuggestionIndex(-1);
      } else {
        void submit();
      }
    } else if (key.backspace || key.delete) {
      const next = inputRef.current.slice(0, -1);
      inputRef.current = next;
      setInput(next);
      setSuggestionIndex(-1);
    } else if (inputChar && !key.ctrl && !key.meta) {
      // Ink's keypress parser strips the leading ESC from SGR mouse sequences but lets
      // the rest of the CSI through as printable text — e.g. a left-click leaks `[<0;8;40M`
      // into the input buffer. The raw stdin listener above has already handled the click,
      // so any residue here is safe to drop.
      const cleaned = inputChar.replace(/\[<\d+;\d+;\d+[Mm]/g, '');
      if (!cleaned) return;
      const next = inputRef.current + cleaned;
      inputRef.current = next;
      setInput(next);
      setSuggestionIndex(-1);
    }
  });

  // Welcome screen
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingTop={1}>
        <Box flexDirection="column" paddingX={2}>
          {WORDMARK.map((line, i) => (
            <WordmarkLine key={i} line={line} color="#B9FECF" />
          ))}
          <Box marginTop={1} flexDirection="column">
            <Box gap={1}>
              <Text bold color="#C0FAD2">bk1</Text>
              <Text color="#5A8060">v0.1.0</Text>
            </Box>
            <Text color="#5A8060"><Text color="#C0FAD2">{MODELS[modelIdx]!.label}</Text> · Mangrove's dbt Coding Agent</Text>
            <Text color="#5A8060">{PROJECT_DIR}</Text>
          </Box>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {isModelPicker
            ? <ModelPicker currentIdx={modelIdx} />
            : <Suggestions suggestions={suggestions} selectedIndex={suggestionIndex} input={input} />
          }
          <HRule />
          <InputBar input={input} isRunning={isRunning} mode={mode} modelLabel={MODELS[modelIdx]!.label} />
          <HRule />
          <StatusFooter sessionUsd={sessionUsd} pet={pet} mouseCol={mouseCol} mouseRow={mouseRow} />
          <HRule />
          <HintBar isRunning={isRunning} />
        </Box>
      </Box>
    );
  }

  // Conversation view
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" paddingX={2} paddingTop={1} paddingBottom={0}>
        {WORDMARK.map((line, i) => (
          <WordmarkLine key={i} line={line} color="#B9FECF" />
        ))}
        <Box marginTop={1} flexDirection="column">
          <Box gap={1}>
            <Text bold color="#C0FAD2">bk1</Text>
            <Text color="#5A8060">v0.1.0</Text>
          </Box>
          <Text color="#5A8060"><Text color="#C0FAD2">{MODELS[modelIdx]!.label}</Text> · Mangrove's dbt Coding Agent</Text>
          <Text color="#5A8060">{PROJECT_DIR}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" paddingX={2} paddingTop={1}>
        {messages.map((msg, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            {msg.role === 'user' ? (
              <Box gap={1}>
                <Text color="#B9FECF">{'>'}</Text>
                <Text color="#C0FAD2" wrap="wrap">{msg.content}</Text>
              </Box>
            ) : (
              <>
                <RichMessage text={msg.content} />
                {msg.tokens && <TokenBadge tokens={msg.tokens} />}
              </>
            )}
          </Box>
        ))}

        {isRunning && (
          <Box flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              <Text color="#5A8060">{liveExpanded ? '-' : '+'}</Text>
              <Text color="#B9FECF"><Spinner type="sand" /></Text>
              <GlowText text="mangroooooving..." />
              {activeTool && (
                <Text color="#5A8060">· {activeTool}</Text>
              )}
            </Box>
            {lintProgress && lintProgress.phase !== 'semantic' && <LintProgressBar progress={lintProgress} />}
            {semanticProgress && semanticProgress.agents.some(a => !a.done) && (
              <SemanticProgressBar progress={semanticProgress} />
            )}
            {liveTokens && <TokenBadge tokens={liveTokens} dim />}
            {!liveExpanded && liveText && (
              <Box paddingLeft={4}>
                <Text color="#3D6650">
                  {(liveText.trim().split('\n').slice(-1)[0] ?? '').slice(0, 120)}
                </Text>
              </Box>
            )}
            {liveExpanded && liveText && (
              <Box flexDirection="column" paddingLeft={3}>
                <Text wrap="wrap" color="#7AB890">{liveText.trimEnd()}</Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {!confirmPrompt && (isModelPicker
        ? <ModelPicker currentIdx={modelIdx} />
        : <Suggestions suggestions={suggestions} selectedIndex={suggestionIndex} input={input} />
      )}
      <HRule />
      {confirmPrompt
        ? <ConfirmBar question={confirmPrompt} selectedIdx={confirmSelected} />
        : <InputBar input={input} isRunning={isRunning} mode={mode} modelLabel={MODELS[modelIdx]!.label} />
      }
      <StatusFooter sessionUsd={sessionUsd} pet={pet} mouseCol={mouseCol} mouseRow={mouseRow} />
      <HRule />
      <HintBar isRunning={isRunning} />
    </Box>
  );
}

render(<AppShell />);
