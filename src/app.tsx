import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { spawnSync } from 'node:child_process';
import { render, Box, Text, Static, useInput, measureElement, type DOMElement } from 'ink';
import Spinner from 'ink-spinner';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent, AgentAbortedError, resetAnthropicClient, type TokenUsage } from './agent';
import { PROJECT_DIR } from './tools';
import { LINT_REPORT_PATH } from './state';
import { readIdeContextBlock, readIdeContextRaw, type IdeContext } from './ide-context';
import { SKILLS, expandSkill } from './skills';
import { getStoredKey, storeKey, clearStoredKey, isValidKeyShape, authFilePath, getStoredAdminKey, storeAdminKey } from './auth';
import { estimateCostUsd, formatUsd } from './pricing';
import { recordProjectUsage, loadProjectTotals, type ProjectTotals } from './project-usage';
import { createUsageState, recordUsage, buildReport, renderReport, classifyTurnLabel, fetchOrgUsage, fetchOrgUsageSeries, type UsageState } from './usage';
import {
  loadPet, savePet, newPet, tickPet, petFace, petFaceEating,
  petSprite, petSpriteBlink, petSpriteSleep, petSpriteEating,
  petSpriteLookLeft, petSpriteLookRight, petSpriteLookUp, petSpriteLookDown,
  petSpriteLookUL, petSpriteLookUR, petSpriteLookDL, petSpriteLookDR,
  renderPetView, isSleeping, isEating,
  feed, play, petSleep, wakePet, rename, autoFeedFromActivity,
  FOODS, addCoins,
  type PetState,
} from './pet';
import { disableMouseTracking, parseMouseEvents } from './mouse';
import { GAMES } from './games';
import { registerCoinEventHandler, emitCoinEvent, COIN_REWARDS, PASSIVE_SESSION_CAP, type CoinEvent } from './coin-events';
import { parseAnsi, type AnsiSpan } from './ansi';

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

// Mini-game picker — shown when input starts with "/pet play". Same shape as
// ModelPicker so the UX is consistent with /model. The selected entry is
// launched on Enter via the /pet play submit branch.
function GamePicker({ currentIdx }: { currentIdx: number }) {
  const entries = Object.values(GAMES);
  // Labels are "/pet play <id>" + " ●" — wider than CMD_COL_WIDTH (sized for
  // short model names). Size the column to the longest registered label so
  // game ids never truncate as new games are added.
  const labelWidth = Math.max(
    CMD_COL_WIDTH,
    ...entries.map(g => `/pet play ${g.id}`.length + 2),
  );
  return (
    <Box flexDirection="column" marginBottom={0}>
      {entries.map((g, i) => {
        const active = i === currentIdx;
        return (
          <Box key={g.id} paddingX={2} gap={1}>
            <Box width={labelWidth} flexShrink={0}>
              <Text color={active ? '#C0FAD2' : '#5A8060'} bold={active}>/pet play {g.id}</Text>
              <Text color="#B9FECF">{active ? ' ●' : '  '}</Text>
            </Box>
            <Text color={active ? '#7AB890' : '#3D6650'}>{g.description}</Text>
          </Box>
        );
      })}
      <Box paddingX={2} marginTop={0}>
        <Text color="#5A8060">↑↓ navigate · Enter play · Esc cancel</Text>
      </Box>
    </Box>
  );
}

// Food picker — same shape as GamePicker. Each row shows id + cost + effect
// so the user can budget against their coin balance before pressing Enter.
function FoodPicker({ currentIdx, balance }: { currentIdx: number; balance: number }) {
  const entries = Object.values(FOODS);
  const labelWidth = Math.max(
    CMD_COL_WIDTH,
    ...entries.map(f => `/pet feed ${f.id}`.length + 2),
  );
  return (
    <Box flexDirection="column" marginBottom={0}>
      {entries.map((f, i) => {
        const active     = i === currentIdx;
        const affordable = balance >= f.cost;
        return (
          <Box key={f.id} paddingX={2} gap={1}>
            <Box width={labelWidth} flexShrink={0}>
              <Text color={active ? '#C0FAD2' : '#5A8060'} bold={active}>/pet feed {f.id}</Text>
              <Text color="#B9FECF">{active ? ' ●' : '  '}</Text>
            </Box>
            <Text color={affordable ? '#FCD34D' : '#7A4747'}>🪙  {f.cost}</Text>
            <Text color={active ? '#7AB890' : '#3D6650'}>{f.description}</Text>
          </Box>
        );
      })}
      <Box paddingX={2} marginTop={0}>
        <Text color="#5A8060">↑↓ navigate · Enter buy · Esc cancel · balance 🪙  {balance}</Text>
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

// Renders the currently-open file (and selected lines) from the bk1-context
// VS Code extension. One thin dim line above the input — mirrors the cue
// Claude Code shows so users know which file bk1 is about to use as ambient
// context. Hidden when nothing is open or the snapshot is stale.
function IdeContextBar({ ctx }: { ctx: IdeContext | null }) {
  if (!ctx || !ctx.file_path) return null;
  const rel = ctx.file_path.startsWith(PROJECT_DIR + '/')
    ? ctx.file_path.slice(PROJECT_DIR.length + 1)
    : ctx.file_path.replace(homedir(), '~');
  const sel = ctx.has_selection && ctx.selection_start_line && ctx.selection_end_line
    ? ctx.selection_start_line === ctx.selection_end_line
      ? `L${ctx.selection_start_line}`
      : `L${ctx.selection_start_line}–${ctx.selection_end_line}`
    : null;
  return (
    <Box paddingX={2} gap={1}>
      <Text color="#5A8060">▸</Text>
      <Text color="#7AB890">{rel}</Text>
      {sel && <><Text color="#3D6650">·</Text><Text color="#7AB890">{sel}</Text></>}
    </Box>
  );
}

function HintBar({ isRunning, paneMode, terminalMode }: { isRunning: boolean; paneMode: boolean; terminalMode: boolean }) {
  return (
    <Box paddingX={2} paddingBottom={1}>
      {isRunning
        ? <Text color="#3D6650">t  toggle output   Esc  stop agent   Ctrl+C  exit</Text>
        : paneMode
          ? <Text color="#FCD34D">PANE MODE — wheel/click the dbt pane   Ctrl+P  back to input mode   Ctrl+C exit</Text>
          : terminalMode
            ? <Text color="#7DD3FC">TERMINAL MODE — input runs as shell   ? prefix  ask agent   Ctrl+T  back to prompt   Ctrl+C exit</Text>
            : <Text color="#3D6650">↵ send   Tab switch mode   ! prefix  shell   Ctrl+T  terminal mode   Ctrl+P  pane mode   Ctrl+C exit</Text>
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

function InputBar({ input, isRunning, mode, modelLabel, maskInput, terminalMode }: {
  input: string; isRunning: boolean; mode: Mode; modelLabel: string; maskInput?: boolean; terminalMode?: boolean;
}) {
  const theme = MODE_THEME[mode];
  const termAccent = '#7DD3FC';
  const accent = isRunning ? '#5A8060' : (terminalMode ? termAccent : theme.accent);
  const text   = isRunning ? '#5A8060' : (terminalMode ? termAccent : theme.text);
  const badgeColor = terminalMode ? termAccent : theme.badge;
  const badgeLabel = terminalMode ? 'TERM' : theme.label;
  const promptChar = terminalMode ? '$' : '>';
  const display = maskInput ? '*'.repeat(input.length) : input;
  // Cursor is a static block — no blink. Blinking would fire setState on an
  // interval, forcing Ink to repaint the dynamic frame and wiping any
  // in-progress terminal selection. Static cursor = no repaint pressure.
  return (
    <Box paddingX={2} gap={1}>
      <Text color={badgeColor} bold>{badgeLabel}</Text>
      <Text color={accent}>{promptChar}</Text>
      <Text color={text}>{display}</Text>
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
  | 'normal' | 'blink' | 'sleep' | 'eating'
  | 'lookL' | 'lookR' | 'lookU' | 'lookD'
  | 'lookUL' | 'lookUR' | 'lookDL' | 'lookDR';

// Snore animation frames — rendered as a vertical column to the right of the sprite
// while the pet is sleeping. Tuple order is [top, middle, bottom]. Each frame is a
// single Z rising from the bottom (near the pet's head) toward the top, fading out
// once it reaches the top row. Cycles every ~500ms.
const SNORE_FRAMES: ReadonlyArray<readonly [string, string, string]> = [
  [' ', ' ', 'z'],
  [' ', 'z', ' '],
  ['Z', ' ', ' '],
  [' ', ' ', ' '],
];

// Single-element items array for the conversation-view header <Static>. Declared
// at module scope so the reference is stable across renders — Ink keys Static
// items by index, so a fresh `['header']` literal each render would technically
// still work, but a stable constant is cheaper and clearer about intent.
const HEADER_ITEMS: string[] = ['header'];

// Local greeting template — when the user opens with a plain "hi" / "what can you
// do?" we short-circuit the LLM and reply with this static capability summary.
// Saves an API call (and the corresponding tokens) for what's otherwise the same
// boilerplate every session.
const GREETING_TEMPLATE = `Hi! I'm bk1, your dbt coding agent. I can help you with:

  - dbt Modeling — staging, intermediate, marts, dimensions, facts
  - data modeling — uses Kimball dimensional modeling
  - SQL — dialect-specific queries, casting, performance
  - Testing & documentation — YAML specs, dbt tests, column descriptions
  - Model Failure Investigations — Investigates failures based on run results
  - Lineage & impact analysis — tracing dependencies across your project
  - Folder Linting & refactoring — conventions, naming, structure`;

// Triggers for the local greeting reply. Kept narrow so an actual question that
// just happens to start with "hi …" doesn't accidentally hit the intercept —
// each pattern matches the full input after stripping trailing punctuation.
const GREETING_PATTERNS: ReadonlyArray<RegExp> = [
  /^(hi|hello|hey|howdy|yo|hiya|sup)(\s+(bk1|there|bot|buddy))?$/i,
  /^(good\s+(morning|afternoon|evening))(\s+bk1)?$/i,
  /^(what\s+(can|do)\s+you\s+do(\s+for\s+me)?|what\s+are\s+your\s+(capabilities|features|skills)|how\s+(can|do)\s+you\s+help(\s+me)?)$/i,
];

function isGreeting(raw: string): boolean {
  const stripped = raw.trim().replace(/[!.?]+$/, '').replace(/\s+/g, ' ');
  if (!stripped) return false;
  return GREETING_PATTERNS.some(re => re.test(stripped));
}

// Module-level mutable mouse position for the pet's eye tracking. Updated
// directly by the raw mouse handler (no setState → no Ink re-render → no
// flicker). PetSpritePanel reads `.col` / `.row` at render time, so the eye
// direction picks up the latest cursor position on whatever next render
// happens (blink scheduler, eating tick, parent prop change, etc.). The
// trade-off is eye tracking that's lazy rather than real-time — eyes
// "freeze" at the last known direction until another render happens.
const petMousePos: { col: number | null; row: number | null } = { col: null, row: null };


const PET_CENTER_COL  = 7;
const PET_DEAD_ZONE_X = 1;
const PET_DEAD_ZONE_Y = 1;

function PetSpritePanel({ pet, renderHeight }: {
  pet: PetState;
  renderHeight: number;
}) {
  // Read mouse position from the module-level mutable object. Reads happen at
  // render time, so the eye direction reflects whatever position the motion
  // handler last wrote — without that handler having to trigger a re-render.
  const { col: mouseCol, row: mouseRow } = petMousePos;
  // Blink animation removed — see no-interval comment below. Pet's eyes stay
  // open. The blinking flag is kept (constant false) so the rest of the sprite
  // picker code that references it remains compile-clean.
  const blinking = false;
  // Snore frame cycler. Also doubles as a re-render tick while sleeping so the panel
  // naturally drops out of the sleep frame when sleeping_until elapses (isSleeping
  // re-evaluates on each tick and flips to false).
  // Snore frame is held at 0 instead of cycling — see the no-interval comment
  // below. Index into SNORE_FRAMES still drives the rendered "Z" column.
  const snoreFrame = 0;
  // Same idea for the chewing animation — cycles every ~300ms while eating_until is
  // in the future, then naturally drops back to the static sprite when it elapses.
  const [eatingFrame, setEatingFrame] = useState(0);
  const sleeping = isSleeping(pet);
  const eating   = isEating(pet) && !sleeping;

  // Blink scheduler removed — was the last idle-state setState in bk1's
  // dynamic frame. With it gone, an idle pet awake (no agent run, no dbt
  // streaming) produces zero React state changes per second, which means zero
  // Ink repaints, which means terminal text selection survives indefinitely.
  // Snore animation intentionally not run for the same reason.

  useEffect(() => {
    if (!eating) return;
    const id = setInterval(() => {
      setEatingFrame(f => (f + 1) % 2);
    }, 300);
    return () => clearInterval(id);
  }, [eating]);

  // Pet eye row, in absolute 1-indexed terminal coords (matches mouse Y from xterm).
  // Counting from the bottom of the rendered output: HintBar paddingBottom(1) +
  // HintBar text(1) + HRule(1) + legs(1) + body bottom(1) + eye(1) = the 6th row up.
  // So eye row = rendered_bottom - 5.
  //
  // rendered_bottom = min(renderHeight, terminal_rows): when content is shorter than
  // the terminal, the output occupies rows 1..renderHeight (top-anchored) so the
  // visible bottom is at renderHeight. When content fills/scrolls, the visible
  // bottom is at terminal_rows. The earlier version used `terminal_rows` unconditionally,
  // which broke vertical tracking on the intro screen and short conversations because
  // the eye row was computed as if the footer were pinned to the terminal bottom.
  const terminalRows = process.stdout.rows ?? 24;
  const renderedBottom = Math.min(renderHeight, terminalRows);
  const petCenterRow = renderedBottom - 5;

  let frame: PetFrame = 'normal';
  if (sleeping) {
    // Sleep wins over blink and mouse-tracking — the pet is OUT, not napping with one
    // eye open.
    frame = 'sleep';
  } else if (eating) {
    // Eating wins over blink and mouse-tracking too — the jaw animation is the whole
    // point. Eyes in the sprite stay open so the pet still "looks at" the user.
    frame = 'eating';
  } else if (blinking) {
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

  const baseSprite =
    frame === 'sleep'  ? petSpriteSleep(pet) :
    frame === 'eating' ? petSpriteEating(pet, eatingFrame) :
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
  // Mood eye overrides — apply on top of the look-direction sprite.
  //   tired (energy === 0): H eyes — same drowsy eyelid as sleep.
  //   hungry (hunger ≥ 80): S eyes — spiral.
  // Tired runs first so its H eyes stick when both conditions hit (hungry's
  // V/M→S no-ops on H). Sleep + eating sprites already use H/W/T glyphs that
  // neither pass touches, so deliberate animations stay intact even while
  // tired or hungry.
  const tired  = pet.energy === 0 && !sleeping && !eating;
  const hungry = pet.hunger >= 80 && !sleeping && !eating;
  const sprite = applyHungryEyes(applyTiredEyes(baseSprite, tired), hungry);

  // Snore column: 3 cells tall (matches the 3 body rows of the sprite — legs row gets
  // a blank pad so the Z's hover next to the head, not the feet).
  const snore = SNORE_FRAMES[snoreFrame];
  return (
    <Box flexDirection="row">
      <Box flexDirection="column">
        {sprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
      </Box>
      {sleeping && (
        <Box flexDirection="column" marginLeft={1}>
          {snore.map((ch, i) => <Text key={i} color="gray">{ch}</Text>)}
          <Text> </Text>
        </Box>
      )}
    </Box>
  );
}

function StatusFooter({ sessionUsd, pet, renderHeight, coinToast }: {
  sessionUsd: number;
  pet: PetState;
  renderHeight: number;
  coinToast: { delta: number; reason: string } | null;
}) {
  // 2-frame chewing animation: while isEating(pet) is true, swap the kaomoji
  // between `(•~•)` and `(•∽•)` every 300 ms. The interval also doubles as the
  // re-render tick that lets the panel drop back to the static face when
  // eating_until naturally elapses (similar pattern to the snore animation).
  const eating = isEating(pet);
  const [eatingFrame, setEatingFrame] = useState(0);
  useEffect(() => {
    if (!eating) return;
    const id = setInterval(() => setEatingFrame(f => (f + 1) % 2), 300);
    return () => clearInterval(id);
  }, [eating]);

  const face = eating ? petFaceEating(pet, eatingFrame) : petFace(pet);
  const petLabel = pet.name ?? 'pet';
  return (
    <Box paddingX={2} gap={2} marginTop={1}>
      <PetSpritePanel pet={pet} renderHeight={renderHeight} />
      {/* Info column sits to the right of the animated sprite. Bottom-aligned so the
          existing single-line readout lines up with the bottom edge of the sprite
          panel rather than floating mid-air. */}
      <Box flexDirection="column" justifyContent="flex-end">
        <Box gap={1}>
          <Text color="#E76F51">{petLabel}:</Text>
          <Text color="#FF9F40">{face}</Text>
          <Text color="#3D6650">·</Text>
          <Text color="#FCD34D">💰  {pet.coins}</Text>
          {coinToast && (
            <Text color={coinToast.delta >= 0 ? '#4ADE80' : '#F87171'} bold>
              {coinToast.delta >= 0 ? '+' : ''}{coinToast.delta} ({coinToast.reason})
            </Text>
          )}
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

// Decode the small handful of HTML entities the LLM tends to emit when it's trying
// to control whitespace or escape special chars in markdown. We render to a terminal,
// not a browser, so anything left as `&nbsp;` would otherwise show up as literal text.
function decodeHtmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function parseInline(raw: string): Span[] {
  type Seg = Span & { done?: boolean };
  let segs: Seg[] = [{ text: decodeHtmlEntities(raw) }];

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
  H: { glyph: '─', fg: PET_EYE,   bg: PET_BODY },  // thin horizontal line — closed-eye dash
  // Eating-mouth cells — chosen to be GUARANTEED 1 terminal cell wide so the body
  // outline stays rectangular while the mouth animates. Wide wave glyphs (U+301C
  // 〜 / U+FF5E ～) render as 1 cell in some fonts and 2 in others, which leaves a
  // notch on the side of the body whenever the terminal's idea of the char width
  // disagrees with the encoded row length.
  W: { glyph: '~', fg: PET_EYE,   bg: PET_BODY },  // ASCII tilde — eating frame A (wavy mouth)
  T: { glyph: '—', fg: PET_EYE,   bg: PET_BODY },  // ASCII em dash — eating frame B (flat mouth)
  // Right-cheek paren — sits to the LEFT of the eating mouth so the face reads as
  // a profile munch: `)` (cheek) then `~` / `-` (mouth in motion).
  ')': { glyph: ')', fg: PET_EYE, bg: PET_BODY },
  Y: { glyph: '▀', fg: PET_BLINK, bg: PET_BODY },  // eye-blink | body
  U: { glyph: '▀', fg: PET_BODY },                 // body | empty (legacy: legs / sprite top)
  L: { glyph: '▄', fg: PET_BODY },                 // empty | body  (leg hanging below body)
  S: { glyph: '꩜', fg: PET_EYE,  bg: PET_BODY },  // U+AA5C spiral — hungry-mood eye glyph
  ' ': { glyph: ' ' },                              // empty | empty
};

// Post-process a decoded sprite to swap eye glyphs when the pet is hungry.
// Replaces V (top-half eye) and M (bottom-half eye) with S (spiral). Leaves
// H (sleep eyelid) and Y (blink) alone so sleep/blink frames stay intact —
// hungry is a continuous-state mood, sleep/blink are deliberate overrides.
function applyHungryEyes(rows: string[], hungry: boolean): string[] {
  if (!hungry) return rows;
  return rows.map(row => row.replace(/[VM]/g, 'S'));
}

// Same idea for "tired" — energy bottomed out at 0. Eyes become H (the same
// drowsy eyelid the sleep sprite uses). Apply this BEFORE applyHungryEyes
// so when both conditions hit, H stays (hungry's V/M→S no-ops on H). Tired
// = passive collapse, more severe than hungry, so it wins.
function applyTiredEyes(rows: string[], tired: boolean): string[] {
  if (!tired) return rows;
  return rows.map(row => row.replace(/[VM]/g, 'H'));
}

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

  // Column width must reflect *visible* (post-parseInline) cell width, not raw markdown
  // length — otherwise `**foo**` (7 chars raw, 3 visible after stripping delimiters)
  // inflates the column and the trailing border drifts row-to-row.
  const visibleLen = (s: string) => stripMd(s).length;
  const colWidths = Array.from({ length: colCount }, (_, ci) =>
    Math.max(headers[ci]?.length ?? 0, ...dataRows.map(r => visibleLen(r[ci] ?? '')))
  );

  // Pad against the visible length so the raw markdown (kept for parseInline to color)
  // still ends up occupying exactly `width` visible cells.
  const padCell = (raw: string, width: number, align: 'left' | 'right' | 'center') => {
    const padding = Math.max(0, width - visibleLen(raw));
    if (align === 'right')  return ' '.repeat(padding) + raw;
    if (align === 'center') {
      const left = Math.floor(padding / 2);
      return ' '.repeat(left) + raw + ' '.repeat(padding - left);
    }
    return raw + ' '.repeat(padding);
  };

  // Full-width border strings built once
  const top    = '┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
  const mid    = '├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤';
  const bottom = '└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

  // Rows as single pre-padded strings — single Text per row guarantees alignment
  const headerCells = headers.map((h, ci) => padCell(h, colWidths[ci]!, 'center'));
  const dataStrs  = dataRows.map(row =>
    '│ ' + colWidths.map((_, ci) => padCell(row[ci] ?? '', colWidths[ci]!, alignments[ci]!)).join(' │ ') + ' │'
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

// ─── dbt log pane ────────────────────────────────────────────────────────────
//
// Right-side panel that streams output from `dbt …` commands the user types
// directly into the prompt. Lives in the dynamic frame (top-right) so it
// re-renders as new lines arrive without affecting the Static message scroll.
// ANSI colors from dbt are parsed and re-rendered as Ink spans — PASS green /
// FAIL red / WARN yellow all survive the pipe.

// Horizontal slice that respects ANSI span boundaries: drops the first `offset`
// visible characters across spans without losing colors on what remains.
function sliceSpansH(spans: AnsiSpan[], offset: number): AnsiSpan[] {
  if (offset <= 0) return spans;
  const out: AnsiSpan[] = [];
  let drop = offset;
  for (const sp of spans) {
    if (drop >= sp.text.length) { drop -= sp.text.length; continue; }
    out.push({ ...sp, text: sp.text.slice(drop) });
    drop = 0;
  }
  return out;
}

function DbtLogPane({ logs, running, width, height, scrollV, scrollH, copyFlash, paneMode, searchQuery }: {
  logs: string[]; running: boolean; width: number; height: number;
  scrollV: number; scrollH: number; copyFlash: boolean; paneMode: boolean;
  searchQuery: string;
}) {
  const q = searchQuery.toLowerCase();
  const searchActive = q.length > 0;
  const matchCount = searchActive
    ? logs.reduce((n, l) => n + (l.toLowerCase().includes(q) ? 1 : 0), 0)
    : 0;
  // scrollV is "lines back from bottom". end excludes the trailing N lines.
  const end = Math.max(0, logs.length - scrollV);
  const start = Math.max(0, end - height);
  const visible = logs.slice(start, end);
  const atBottom = scrollV === 0;
  const totalBack = logs.length;

  // Vertical scrollbar thumb. Track length is FIXED at `height` (matches the
  // log-rows area, which always renders `height` rows). Earlier this used
  // visible.length which grew with log count, causing the whole pane to change
  // height row-by-row during a dbt run.
  const needsBar = logs.length > height;
  const trackLen = height;
  let thumbStart = 0, thumbLen = trackLen;
  if (needsBar) {
    thumbLen = Math.max(1, Math.round((height / logs.length) * trackLen));
    const maxThumb = trackLen - thumbLen;
    const maxScrollV = logs.length - height;
    const ratio = maxScrollV > 0 ? scrollV / maxScrollV : 0;
    thumbStart = Math.round((1 - ratio) * maxThumb);
  }

  // Horizontal scrollbar. Spans the full pane width inside the borders
  // (width - 2), so it reaches edge-to-edge — no inset gap from padding.
  // The thumb represents scroll position against the widest visible log line.
  // Raw line length is used as a width proxy (ANSI codes inflate it slightly,
  // so the thumb runs a touch smaller than the "true" content — acceptable
  // for a position indicator).
  const hBarWidth = Math.max(1, width - 2);
  // -2 border, -2 padding, -2 v-scrollbar = -6 (v-scrollbar is now 2 cols wide
  // so it visually matches the h-scrollbar's 1-row thickness).
  const contentWidth = Math.max(1, width - 6);
  // Strip ANSI escape codes before measuring line length — without this, a
  // colored 20-char line measures as 50+ raw chars and the h-scrollbar lets
  // the user "scroll right" into 30 cols of blank space that don't exist.
  const stripAnsi = (s: string) => s.replace(/\x1b\[[\d;?]*[A-Za-z~]/g, '');
  const maxLineVisible = logs.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
  const hNeedsBar = maxLineVisible > contentWidth;
  let hThumbStart = 0, hThumbLen = hBarWidth;
  if (hNeedsBar) {
    // Minimum thumb length of 4 so it's always visually grab-able.
    hThumbLen = Math.max(4, Math.round((contentWidth / maxLineVisible) * hBarWidth));
    const hMaxThumb = Math.max(0, hBarWidth - hThumbLen);
    const hRange = Math.max(1, maxLineVisible - contentWidth);
    hThumbStart = Math.min(hMaxThumb, Math.round((scrollH / hRange) * hMaxThumb));
  }

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="#3D6650">
      {/* Top section: header + log content + vertical scrollbar as a row */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          <Box gap={1}>
            <Text bold color="#B9FECF">dbt logs</Text>
            {running
              ? <Text color="#FCD34D"><Spinner type="dots" /></Text>
              : <Text color="#3D6650">· idle</Text>}
            {!atBottom && (
              <Text color="#5A8060">↕ {Math.max(1, end)}/{totalBack}</Text>
            )}
            {scrollH > 0 && <Text color="#5A8060">→ col {scrollH}</Text>}
            {searchActive && (
              <Text color="#FCD34D">/{searchQuery}/ {matchCount}</Text>
            )}
            <Box flexGrow={1} />
            {copyFlash
              ? <Text color="#4ADE80">copied!</Text>
              : paneMode
                ? <Text color="#7AB890">[copy]</Text>
                : <Text color="#5A8060">Ctrl+P to scroll</Text>}
          </Box>
          {/* Always render exactly `height` rows. Blank rows render as a
              single space so the pane's vertical dimension stays constant
              from the first frame onward — no growing-pane drift. */}
          {Array.from({ length: height }, (_, i) => {
            const line = visible[i];
            // For missing entries (logs.length < height) render an explicit
            // single-space row so Ink reserves a row of vertical space.
            if (line === undefined) return <Text key={i}>{' '}</Text>;

            const isMatch = searchActive && line.toLowerCase().includes(q);
            const leftClip = scrollH > 0;

            // Match rendering — whole line forced yellow + bold.
            if (isMatch) {
              const tail = line.slice(scrollH).replace(/\x1b\[[\d;?]*[A-Za-z~]/g, '');
              return (
                <Text key={i} wrap="truncate-end" color="#FCD34D" bold>
                  {leftClip ? '…' : ''}{tail || ' '}
                </Text>
              );
            }

            // Normal rendering. Compute the ANSI-stripped visible tail length
            // so we can detect rows that became empty after h-scrolling — and
            // render them as a single-space row instead of nothing (Ink
            // collapses empty <Text> to 0 rows, which made the pane look
            // shorter when many lines were shorter than scrollH).
            const stripAnsi = (s: string) => s.replace(/\x1b\[[\d;?]*[A-Za-z~]/g, '');
            const visibleLen = stripAnsi(line).length - scrollH;
            if (visibleLen <= 0) {
              // Whole row scrolled off — render `…` (if scrolled) or a blank
              // space, guaranteed to occupy 1 row.
              return <Text key={i} wrap="truncate-end" color="#5A8060">{leftClip ? '…' : ' '}</Text>;
            }

            return (
              <Text key={i} wrap="truncate-end">
                {leftClip && <Text color="#5A8060">…</Text>}
                {sliceSpansH(parseAnsi(line), scrollH).map((sp, j) => (
                  <Text key={j} color={sp.color} bold={sp.bold} dimColor={sp.dim}>{sp.text}</Text>
                ))}
              </Text>
            );
          })}
        </Box>
        {/* Vertical scrollbar column. 2 cols wide so its visual thickness
            matches the h-scrollbar's 1-row thickness (1 col would look thin
            since terminal cells are ~2x taller than they are wide). */}
        <Box flexDirection="column" width={2} flexShrink={0}>
          <Text> </Text>{/* spacer to align track with log rows, not header */}
          {Array.from({ length: trackLen }, (_, i) => {
            const isThumb = needsBar && i >= thumbStart && i < thumbStart + thumbLen;
            return (
              <Text key={i} color={isThumb ? '#FCD34D' : '#5A8060'} bold={isThumb}>
                {isThumb ? '██' : '││'}
              </Text>
            );
          })}
        </Box>
      </Box>
      {/* Bottom section: horizontal scrollbar — spans the full pane width
          inside the borders (not constrained by the inner column's padding),
          so it visually reaches edge-to-edge. */}
      <Box>
        {Array.from({ length: hBarWidth }, (_, i) => {
          const isThumb = hNeedsBar && i >= hThumbStart && i < hThumbStart + hThumbLen;
          // Thumb uses solid block (█) which is unambiguously distinct from
          // the rounded-border ─ glyph that sits just below the h-scrollbar.
          // Color contrast (yellow vs olive) reinforces this.
          return isThumb
            ? <Text key={i} color="#FCD34D" bold>█</Text>
            : <Text key={i} color="#5A8060">─</Text>;
        })}
      </Box>
    </Box>
  );
}

// ─── Login screen ────────────────────────────────────────────────────────────
//
// Shown before the main TUI when no API key is found in env or ~/.bk1/auth.json.
// Uses its own useInput handler so none of the main App's input plumbing (cursor,
// history, suggestions, etc.) is touched. Renders asterisks for the typed/pasted
// key — the actual value is held only in component state, never logged.

// ─── Conversation review mode (full-screen scrollable history) ──────────────
//
// Triggered by `/review` (or `/scroll`). Replaces the normal TUI with a single
// scrollable list of every message in the session. Exists so users can read
// back through long agent output (lint findings, analyses) without relying on
// VS Code's terminal scrollback — which may be disabled, remapped, or eaten by
// bk1's mouse-tracking mode. Scroll via ↑↓/PgUp/PgDn/Home/End. Esc returns to
// the normal TUI.

function ReviewMode({ messages, onExit }: { messages: Message[]; onExit: () => void }) {
  // Flatten each message into individual terminal lines so we can window by
  // line count (not message count). Long messages no longer count as a single
  // PgDn step — you scroll past them one line at a time.
  const lines = useMemo(() => {
    const out: { kind: 'user' | 'assistant'; text: string }[] = [];
    for (const msg of messages) {
      const split = msg.content.split('\n');
      if (msg.role === 'user') {
        split.forEach((line, i) => {
          out.push({ kind: 'user', text: i === 0 ? `> ${line}` : `  ${line}` });
        });
      } else {
        for (const line of split) out.push({ kind: 'assistant', text: line });
      }
      out.push({ kind: 'assistant', text: '' });
    }
    return out;
  }, [messages]);

  const termRows = process.stdout.rows ?? 24;
  // Reserve 1 row for header + 1 row for spacing + 1 row for hint footer.
  const visibleHeight = Math.max(1, termRows - 4);
  const maxOffset = Math.max(0, lines.length - visibleHeight);
  // Start at the bottom of the conversation so the latest content is on screen.
  const [offset, setOffset] = useState(maxOffset);

  useInput((_input, key) => {
    if (key.escape) { onExit(); return; }
    if (key.upArrow)   setOffset(o => Math.max(0, o - 1));
    if (key.downArrow) setOffset(o => Math.min(maxOffset, o + 1));
    if (key.pageUp)    setOffset(o => Math.max(0, o - visibleHeight + 1));
    if (key.pageDown)  setOffset(o => Math.min(maxOffset, o + visibleHeight - 1));
  });

  const visible = lines.slice(offset, offset + visibleHeight);
  const last = Math.min(offset + visibleHeight, lines.length);

  return (
    <Box flexDirection="column">
      <Box paddingX={2} gap={1}>
        <Text bold color="#B9FECF">Conversation Review</Text>
        <Text color="#5A8060">·</Text>
        <Text color="#5A8060">lines {offset + 1}–{last} of {lines.length}</Text>
      </Box>
      <Box flexDirection="column" paddingX={2}>
        {visible.map((entry, i) => (
          entry.kind === 'user'
            ? <Text key={i} color="#C0FAD2" wrap="wrap">{entry.text || ' '}</Text>
            : <RichLine key={i} line={entry.text} />
        ))}
      </Box>
      <Box paddingX={2} marginTop={1}>
        <Text color="#3D6650">↑↓ scroll · PgUp/PgDn page · Esc exit</Text>
      </Box>
    </Box>
  );
}

// ─── /usage tabbed panel ────────────────────────────────────────────────────
//
// Fullscreen takeover (like GameComponent) with Tab-cycling tabs:
//   Status   — bk1 project/model/mode state, Claude-Code style two-column rows
//   Usage    — org-level text summary (current month totals, daily avg, etc.)
//   Stats    — horizontal stacked-bar time-series graph (m/d/h × tokens/cost)
//   Session  — per-/command in-process attribution from this bk1 session
//
// Tab and Shift+Tab cycle tabs. Inside Stats, m/d/h cycle granularity and
// t/$ toggle metric. Esc closes everywhere.

const USAGE_FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'other'] as const;
const USAGE_FAMILY_LABEL: Record<string, string> = {
  opus:   'Opus',
  sonnet: 'Sonnet',
  haiku:  'Haiku',
  other:  'Other',
};
// Three distinct shades so stacked segments are visually separable while still
// living within the mangrove-green palette used elsewhere in bk1.
const USAGE_FAMILY_COLOR: Record<string, string> = {
  opus:   '#FFD27C',   // warm gold — premium model accent
  sonnet: '#7CB7E0',   // cool blue — workhorse model
  haiku:  '#B9FECF',   // brand pale-green — light/cheap model
  other:  '#5A8060',   // muted moss — fallback bucket
};

type UsagePanelTab = 'status' | 'usage' | 'stats' | 'projects' | 'session';
const USAGE_TAB_ORDER: UsagePanelTab[] = ['status', 'usage', 'stats', 'projects', 'session'];
const USAGE_TAB_LABEL: Record<UsagePanelTab, string> = {
  status:   'Status',
  usage:    'Usage',
  stats:    'Stats',
  projects: 'Projects',
  session:  'Session',
};

function UsagePanel({
  adminKey, model, mode, paneMode, terminalMode, usageState, onExit,
}: {
  adminKey: string;
  model: { id: string; label: string };
  mode: Mode;
  paneMode: boolean;
  terminalMode: boolean;
  usageState: UsageState;
  onExit: () => void;
}) {
  const [tab, setTab] = useState<UsagePanelTab>('status');
  // Stats-tab state lives on the panel (not inside StatsTab) so the user's
  // granularity / metric choices survive flipping to another tab and back.
  const [granularity, setGranularity] = useState<import('./usage').UsageGranularity>('daily');
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');

  useInput((inputChar, key) => {
    if (key.escape) { onExit(); return; }
    if (key.tab && key.shift) {
      setTab(t => USAGE_TAB_ORDER[(USAGE_TAB_ORDER.indexOf(t) - 1 + USAGE_TAB_ORDER.length) % USAGE_TAB_ORDER.length]!);
      return;
    }
    if (key.tab) {
      setTab(t => USAGE_TAB_ORDER[(USAGE_TAB_ORDER.indexOf(t) + 1) % USAGE_TAB_ORDER.length]!);
      return;
    }
    if (tab === 'stats') {
      if (inputChar === 't') setMetric('tokens');
      else if (inputChar === '$' || inputChar === 'c') setMetric('cost');
      else if (inputChar === 'm') setGranularity('monthly');
      else if (inputChar === 'd') setGranularity('daily');
      else if (inputChar === 'h') setGranularity('hourly');
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <UsagePanelTabsHeader active={tab} />
      <Box marginTop={1} flexDirection="column">
        {tab === 'status'  && <StatusTab model={model} mode={mode} paneMode={paneMode} terminalMode={terminalMode} adminKey={adminKey} />}
        {tab === 'usage'   && <UsageTab adminKey={adminKey} />}
        {tab === 'stats'    && <StatsTab adminKey={adminKey} granularity={granularity} metric={metric} />}
        {tab === 'projects' && <ProjectsTab />}
        {tab === 'session'  && <SessionTab usageState={usageState} />}
      </Box>
      <Box marginTop={1}>
        <Text color="#3D6650">
          Tab next · Shift+Tab prev · Esc close
          {tab === 'stats' && ' · m/d/h granularity · t/$ metric'}
        </Text>
      </Box>
    </Box>
  );
}

function UsagePanelTabsHeader({ active }: { active: UsagePanelTab }) {
  return (
    <Box gap={2}>
      {USAGE_TAB_ORDER.map(t => (
        <Box key={t}>
          {t === active
            ? <Text bold backgroundColor="#3D6650" color="#FFFFFF"> {USAGE_TAB_LABEL[t]} </Text>
            : <Text color="#5A8060"> {USAGE_TAB_LABEL[t]} </Text>}
        </Box>
      ))}
    </Box>
  );
}

function StatusTab({
  model, mode, paneMode, terminalMode, adminKey,
}: {
  model: { id: string; label: string };
  mode: Mode;
  paneMode: boolean;
  terminalMode: boolean;
  adminKey: string;
}) {
  // One-shot git branch lookup. Spawned synchronously via spawnSync (already
  // imported above) on mount. If git isn't available or the dir isn't a repo,
  // we fall back to "—" rather than surfacing an error here.
  const [branch, setBranch] = useState<string>('…');
  useEffect(() => {
    try {
      const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: PROJECT_DIR, encoding: 'utf-8' });
      setBranch(res.status === 0 ? (res.stdout?.trim() || '—') : '—');
    } catch { setBranch('—'); }
  }, []);

  // Presence only — no fingerprint, no last-N chars. The admin key never
  // appears on screen so an over-the-shoulder reader / screenshot / screen
  // share can't recover any part of it.
  const keyHint = adminKey ? 'stored' : 'not stored';
  const lintBuilt = existsSync(`${process.env.HOME}/.bk1/bk1-lint`);
  const dbtProject = `${PROJECT_DIR}/dbt_project.yml`;
  const dbtPresent = existsSync(dbtProject);

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Version',       value: <Text color="#C0FAD2">bk1 v0.1.0</Text> },
    { label: 'Project',       value: <Text color="#C0FAD2">{PROJECT_DIR}</Text> },
    { label: 'Branch',        value: <Text color="#C0FAD2">{branch}</Text> },
    { label: 'Model',         value: <Text color="#C0FAD2">{model.label}  <Text color="#5A8060">({model.id})</Text></Text> },
    { label: 'Mode',          value: <Text color="#C0FAD2">{mode}</Text> },
    { label: 'Admin API key', value: <Text color={adminKey ? '#C0FAD2' : '#E08080'}>{keyHint}</Text> },
    { label: 'Pane mode',     value: <Text color="#C0FAD2">{paneMode ? 'on' : 'off'}  <Text color="#5A8060">·</Text>  Terminal mode: {terminalMode ? 'on' : 'off'}</Text> },
    { label: 'dbt project',   value: <Text color={dbtPresent ? '#C0FAD2' : '#E08080'}>{dbtProject}  <Text color="#5A8060">{dbtPresent ? '· present' : '· missing'}</Text></Text> },
    { label: 'Lint binary',   value: <Text color={lintBuilt ? '#C0FAD2' : '#E08080'}>~/.bk1/bk1-lint  <Text color="#5A8060">{lintBuilt ? '· built' : '· missing — run `bun run setup`'}</Text></Text> },
  ];

  const labelWidth = Math.max(...rows.map(r => r.label.length)) + 1;

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={i}>
          <Box width={labelWidth} flexShrink={0}>
            <Text color="#5A8060">{row.label}:</Text>
          </Box>
          <Box>{row.value}</Box>
        </Box>
      ))}
    </Box>
  );
}

function UsageTab({ adminKey }: { adminKey: string }) {
  // Text-summary view (per-model rollup, daily avg, projection, cache
  // efficiency). Re-fetched each time the tab mounts; for tighter caching
  // see the StatsTab pattern.
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchOrgUsage(adminKey).then(t => {
      if (cancelled) return;
      setText(t); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [adminKey]);
  if (loading) return <Text color="#5A8060">Loading organization usage…</Text>;
  return (
    <Box flexDirection="column">
      {(text ?? '').split('\n').map((line, i) => (
        <Text key={i} color="#C0FAD2">{line || ' '}</Text>
      ))}
    </Box>
  );
}

function StatsTab({
  adminKey, granularity, metric,
}: {
  adminKey: string;
  granularity: import('./usage').UsageGranularity;
  metric: 'cost' | 'tokens';
}) {
  // Pre-fetch all three granularities in parallel as soon as the /usage menu
  // mounts, so switching h/d/m is instant. The cache is intentionally NOT
  // persisted across menu closes — every fresh /usage invocation re-pulls.
  type G = import('./usage').UsageGranularity;
  const [cache, setCache]     = useState<Partial<Record<G, import('./usage').UsageSeries>>>({});
  const [errors, setErrors]   = useState<Partial<Record<G, string>>>({});
  const [pending, setPending] = useState<Set<G>>(new Set(['hourly', 'daily', 'monthly']));

  useEffect(() => {
    let cancelled = false;
    const grans: G[] = ['hourly', 'daily', 'monthly'];
    for (const g of grans) {
      (async () => {
        const result = await fetchOrgUsageSeries(adminKey, g);
        if (cancelled) return;
        if (typeof result === 'string') {
          setErrors(e => ({ ...e, [g]: result }));
        } else {
          setCache(c => ({ ...c, [g]: result }));
        }
        setPending(s => { const n = new Set(s); n.delete(g); return n; });
      })();
    }
    return () => { cancelled = true; };
  }, [adminKey]);

  const series  = cache[granularity] ?? null;
  const error   = errors[granularity] ?? null;
  const loading = pending.has(granularity);

  const granularityLabel =
    granularity === 'monthly' ? 'Monthly' :
    granularity === 'daily'   ? 'Daily'   : 'Hourly';

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color="#C0FAD2">{granularityLabel}</Text>
        {series && <><Text color="#5A8060">·</Text><Text color="#5A8060">{series.rangeLabel}</Text></>}
        <Text color="#5A8060">·</Text>
        <Text color="#C0FAD2">{metric === 'cost' ? 'cost ($)' : 'tokens'}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {loading && <Text color="#5A8060">Loading {granularityLabel.toLowerCase()} data…</Text>}
        {error && <Text color="#E08080">{error}</Text>}
        {series && !loading && !error && <UsageBars series={series} metric={metric} />}
      </Box>
      {series && !loading && !error && (
        <Box marginTop={1} flexDirection="column">
          <Box gap={2}>
            <Text color="#5A8060">Total:</Text>
            <Text color="#C0FAD2">{metric === 'cost' ? formatUsd(series.totalUsd) : fmtTokens(series.totalTokens)}</Text>
            {series.daysElapsed > 0 && metric === 'cost' && (
              <>
                <Text color="#5A8060">·</Text>
                <Text color="#5A8060">Daily avg:</Text>
                <Text color="#C0FAD2">{formatUsd(series.totalUsd / series.daysElapsed)}</Text>
              </>
            )}
          </Box>
          <Box gap={2} marginTop={0}>
            <Text color="#5A8060">Legend:</Text>
            {USAGE_FAMILY_ORDER.map(fam => (
              <Box key={fam} gap={1}>
                <Text backgroundColor={USAGE_FAMILY_COLOR[fam]}>  </Text>
                <Text color="#C0FAD2">{USAGE_FAMILY_LABEL[fam]}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function ProjectsTab() {
  // Lifetime per-dbt-project breakdown sourced from ~/.bk1/usage.db. Re-loaded
  // on each /usage open (the panel unmounts when you Esc out, so this effect
  // fires fresh next time). Sorted by cost desc so the heaviest projects sit
  // at the top.
  const [rows, setRows] = useState<ProjectTotals[] | null>(null);

  useEffect(() => {
    setRows(loadProjectTotals());
  }, []);

  if (rows === null) return <Text color="#5A8060">Loading…</Text>;
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="#5A8060">No locally tracked usage yet.</Text>
        <Text color="#3D6650">bk1 records one row per LLM call to ~/.bk1/usage.db — come back after a session or two.</Text>
      </Box>
    );
  }

  const maxCost   = Math.max(...rows.map(r => r.costUsd));
  const totalUsd  = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalTok  = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCall = rows.reduce((s, r) => s + r.callCount, 0);

  // Collapse $HOME prefix so paths read as "~/work/dbt-acme" instead of
  // "/Users/long-name/work/dbt-acme" — keeps the column narrow.
  const home = process.env.HOME ?? '';
  const display = (p: string) => home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  const pathW   = Math.max(8, ...rows.map(r => display(r.projectPath).length));
  const barW    = 18;

  return (
    <Box flexDirection="column">
      <Text color="#5A8060">bk1-tracked sessions only · lifetime · sorted by cost</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((r, i) => {
          const filled = Math.max(1, Math.round((r.costUsd / maxCost) * barW));
          return (
            <Box key={i} gap={1}>
              <Box width={pathW} flexShrink={0}>
                <Text color="#C0FAD2">{display(r.projectPath)}</Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text color="#C0FAD2">{formatUsd(r.costUsd)}</Text>
              </Box>
              <Box width={12} flexShrink={0}>
                <Text color="#5A8060">{fmtTokens(r.tokens)} tok</Text>
              </Box>
              <Text backgroundColor="#6B5E8C">{' '.repeat(filled)}</Text>
              <Text color="#3D6650">{r.callCount} call{r.callCount === 1 ? '' : 's'}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box gap={2}>
          <Text color="#5A8060">Total tracked:</Text>
          <Text color="#C0FAD2">{formatUsd(totalUsd)}</Text>
          <Text color="#5A8060">·</Text>
          <Text color="#C0FAD2">{fmtTokens(totalTok)} tok</Text>
          <Text color="#5A8060">·</Text>
          <Text color="#C0FAD2">{totalCall} calls</Text>
        </Box>
        <Text color="#3D6650">Locally tracked. Anthropic Admin totals (Usage tab) may be higher if other tools share the org.</Text>
      </Box>
    </Box>
  );
}

function SessionTab({ usageState }: { usageState: UsageState }) {
  const report = renderReport(buildReport(usageState));
  return (
    <Box flexDirection="column">
      {report.split('\n').map((line, i) => (
        <Text key={i} color="#C0FAD2">{line || ' '}</Text>
      ))}
    </Box>
  );
}

function UsageBars({
  series, metric,
}: { series: import('./usage').UsageSeries; metric: 'cost' | 'tokens' }) {
  // Column chart: time on the x-axis, value on the y-axis. Each bucket is a
  // vertical stack of cells, with per-family segments stacked from the bottom
  // up in USAGE_FAMILY_ORDER. The previous layout was rows-per-bucket, which
  // made it hard to scan a time series — this one reads left-to-right.
  const values = series.buckets.map(b => metric === 'cost' ? b.totalUsd : b.totalTokens);
  const maxVal = Math.max(0.0000001, ...values);

  // Y-axis width is fixed so the bars line up no matter what value formatter
  // we're using. Heights are tuned for terminals that are typically 24 rows
  // tall with chrome above + below the chart.
  const chartH    = 12;
  const yLabelW   = 9;
  const cols      = process.stdout.columns ?? 80;
  const availW    = Math.max(20, cols - yLabelW - 6);
  // Each bucket gets at least 2 cells so even single-color bars are visible
  // as bars and not vertical hairlines. Cap at 4 so 6-bucket monthly views
  // don't stretch into giant blocks.
  const colW      = Math.max(2, Math.min(4, Math.floor(availW / Math.max(1, series.buckets.length))));

  const bars = series.buckets.map(b => {
    const value = metric === 'cost' ? b.totalUsd : b.totalTokens;
    const rawFilled = Math.round((value / maxVal) * chartH);
    // Non-zero buckets get at least one row so a small day next to a huge
    // day doesn't vanish (same reasoning as the old horizontal version).
    const filled = value > 0 ? Math.max(1, rawFilled) : 0;
    const segments: { family: string; cells: number }[] = [];
    if (filled > 0 && value > 0) {
      const raw = USAGE_FAMILY_ORDER.map(fam => {
        const s = b.perFamily[fam];
        const famValue = s ? (metric === 'cost' ? s.usd : s.tokens) : 0;
        return { family: fam, exact: (famValue / value) * filled };
      });
      const floors = raw.map(r => ({ family: r.family, cells: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }));
      let used = floors.reduce((s, r) => s + r.cells, 0);
      const leftovers = [...floors].sort((a, b) => b.frac - a.frac);
      for (const r of leftovers) {
        if (used >= filled) break;
        r.cells += 1; used += 1;
      }
      for (const r of floors) if (r.cells > 0) segments.push({ family: r.family, cells: r.cells });
    }
    return { filled, segments, value };
  });

  // For column `col`, row `row` (0 = top), what family color (if any) fills it?
  // Walks segments bottom-up — segments[0] is the bottom-most family.
  const cellAt = (col: number, row: number): string | null => {
    const bar = bars[col];
    if (!bar) return null;
    const fromBottom = chartH - row;
    if (fromBottom > bar.filled) return null;
    let acc = 0;
    for (const seg of bar.segments) {
      acc += seg.cells;
      if (fromBottom <= acc) return seg.family;
    }
    return null;
  };

  const fmtVal = (v: number) => metric === 'cost' ? formatUsd(v) : fmtTokens(v);
  // Compact form used for on-graph labels — needs to fit in roughly colW*2
  // cells (one slot + one slot of right-overflow). The Y-axis still uses the
  // full formatter so the scale ticks read precisely.
  const compactVal = (v: number) => {
    if (metric === 'tokens') return fmtTokens(v);
    if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
    if (v >= 10)   return `$${Math.round(v)}`;
    if (v >= 1)    return `$${v.toFixed(1)}`;
    return `$${v.toFixed(2)}`;
  };
  const yTicks: Record<number, string> = {
    [0]:                      fmtVal(maxVal),
    [Math.floor(chartH / 2)]: fmtVal(maxVal / 2),
    [chartH - 1]:             fmtVal(0),
  };

  // X-axis labels: pick a stride so labels don't collide. Each label is
  // rendered in `colW` columns; pad with a separator so they read cleanly.
  const labels = series.buckets.map(b => b.label);
  const maxLabel = Math.max(...labels.map(l => l.length));
  const stride = Math.max(1, Math.ceil((maxLabel + 1) / colW));

  // Build a per-cell plan for each row. Cells are either part of a bar
  // (backgroundColor = family) or empty/text. Value labels go into empty
  // cells one row above each bar's tip; if a label is wider than `colW`
  // it spills into the adjacent empty cell to the right. Bar cells always
  // win over label cells, so a label on a short bar can't ever overlay a
  // taller bar's column.
  type RowCell = { bg: string | null; ch: string };
  const buildRow = (row: number): RowCell[] => {
    const totalCols = bars.length * colW;
    const cells: RowCell[] = Array.from({ length: totalCols }, () => ({ bg: null, ch: ' ' }));
    // Bars
    bars.forEach((_, col) => {
      const fam = cellAt(col, row);
      if (!fam) return;
      const color = USAGE_FAMILY_COLOR[fam];
      if (!color) return;
      for (let i = 0; i < colW; i++) cells[col * colW + i] = { bg: color, ch: ' ' };
    });
    // Value labels — one row above each non-zero bar's tip
    bars.forEach((b, col) => {
      if (b.value === 0) return;
      const labelRow = Math.max(0, chartH - b.filled - 1);
      if (labelRow !== row) return;
      const label = compactVal(b.value);
      for (let i = 0; i < label.length; i++) {
        const idx = col * colW + i;
        if (idx >= totalCols) break;
        // Don't overwrite a bar cell from a taller neighbor.
        if (cells[idx]!.bg === null) cells[idx] = { bg: null, ch: label[i]! };
      }
    });
    return cells;
  };
  // Collapse a row's cells into contiguous spans so Ink only allocates one
  // <Text> per color change.
  const rowToSpans = (cells: RowCell[]): { bg: string | null; text: string }[] => {
    const spans: { bg: string | null; text: string }[] = [];
    for (const c of cells) {
      const last = spans[spans.length - 1];
      if (last && last.bg === c.bg) last.text += c.ch;
      else                          spans.push({ bg: c.bg, text: c.ch });
    }
    return spans;
  };

  return (
    <Box flexDirection="column">
      {Array.from({ length: chartH }, (_, row) => {
        const spans = rowToSpans(buildRow(row));
        return (
          <Box key={row}>
            <Box width={yLabelW} flexShrink={0}>
              <Text color="#5A8060">{(yTicks[row] ?? '').padStart(yLabelW)}</Text>
            </Box>
            <Text color="#3D6650">{row === chartH - 1 ? '└' : '│'}</Text>
            <Text>
              {spans.map((s, i) => (
                s.bg
                  ? <Text key={i} backgroundColor={s.bg}>{s.text}</Text>
                  : <Text key={i} color="#C0FAD2">{s.text}</Text>
              ))}
            </Text>
          </Box>
        );
      })}
      {/* X-axis labels — staggered by stride so they don't overlap */}
      <Box>
        <Box width={yLabelW + 1} flexShrink={0}><Text> </Text></Box>
        <Text color="#5A8060">
          {bars.map((_, col) => {
            const show = col % stride === 0;
            const label = show ? labels[col]! : '';
            const slotW = colW * stride;
            // For the last visible label, only pad up to the end of the chart
            // so we don't print stray spaces past the right edge.
            const remaining = (bars.length - col) * colW;
            const width = Math.min(slotW, remaining);
            return <Text key={col}>{show ? label.padEnd(width).slice(0, width) : ''}</Text>;
          })}
        </Text>
      </Box>
    </Box>
  );
}

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

  // Mouse-tracking lifecycle. Enabled by default so the pet's eyes follow the cursor,
  // but suspended while the pet is asleep — this doubles as the "let me scroll the
  // terminal" escape hatch: putting the pet to sleep via `/pet sleep` releases the
  // wheel + scrollbar back to the terminal for ~10 minutes (or until the next /pet
  // interaction wakes the pet). Without this, xterm modes 1000/1003 swallow wheel
  // events and the user can't scroll back through their conversation.
  //
  // The unconditional restore on unmount/exit still runs so the terminal never gets
  // stranded in mouse mode after bk1 closes — printing garbage escape sequences in
  // the next shell session would be very bad UX.
  useEffect(() => {
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
  const [petPlayIdx, setPetPlayIdx] = useState(0);
  const [petFeedIdx, setPetFeedIdx] = useState(0);
  const [semanticProgress, setSemanticProgress] = useState<SemanticProgress | null>(null);
  const [lintProgress, setLintProgress] = useState<LintProgress | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<string | null>(null);
  const [confirmSelected, setConfirmSelected] = useState(0);
  const [liveTokens, setLiveTokens] = useState<TokenTotals | null>(null);
  // dbt passthrough: typed `dbt …` commands run as subprocesses (no LLM, no tokens)
  // and stream into the right-side log pane. dbtRunning is separate from isRunning
  // so the user can keep chatting while a long dbt build runs.
  const [dbtLogs, setDbtLogs] = useState<string[]>([]);
  const [dbtRunning, setDbtRunning] = useState(false);
  // Scroll offsets for DbtLogPane. scrollV is "lines back from bottom" (0 = follow tail);
  // scrollH is "characters scrolled right" (0 = at left edge). New lines auto-stick to
  // bottom only when scrollV is already 0 — otherwise the user's read position is held.
  const [dbtScrollV, setDbtScrollV] = useState(0);
  const [dbtScrollH, setDbtScrollH] = useState(0);
  // Search query for highlighting matching lines in the dbt log pane. Set via
  // the /find command; empty string disables highlighting.
  const [dbtSearchQuery, setDbtSearchQuery] = useState('');
  // Bounds of the rendered pane in terminal coordinates, captured at paint time so the
  // raw mouse handler (which only knows screen col/row) can route wheel + clicks to it.
  const dbtPaneBoundsRef = useRef<{
    top: number; bottom: number; left: number; right: number;
    copyLeft: number; copyRight: number; copyRow: number;
    // Vertical scrollbar: scrollCol is the column; track[Top|Bottom] are the
    // first/last track cell rows. Horizontal scrollbar: hbarRow is its row;
    // hbar[Left|Right] are the first/last cells. Used by the drag handler.
    scrollCol: number; trackTop: number; trackBottom: number;
    hbarRow: number; hbarLeft: number; hbarRight: number;
  } | null>(null);
  // 'v' = dragging vertical scrollbar (cursor row → scrollV).
  // 'h' = dragging horizontal scrollbar (cursor col → scrollH).
  // null = not dragging.
  const dbtDragRef = useRef<'v' | 'h' | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);
  // Mirror dbtLogs into a ref so the raw-stdin mouse handler (mounted once with
  // empty deps) can read the current value without re-binding on every append.
  const dbtLogsRef = useRef<string[]>([]);
  useEffect(() => { dbtLogsRef.current = dbtLogs; }, [dbtLogs]);
  // Mirror messages into a ref so callbacks with empty deps (e.g. submit's
  // /history handler) read the live state instead of the empty array captured
  // at mount. Same pattern as dbtLogsRef above.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const dbtProcRef = useRef<ReturnType<typeof Bun.spawn> | null>(null);

  const inputRef = useRef('');
  const isRunningRef = useRef(false);
  const historyRef = useRef<Anthropic.MessageParam[]>([]);
  // Prompt-history navigation (shell-style): every submitted prompt is pushed, and
  // the up/down arrows scrub through it. promptHistoryIdx === -1 means "not currently
  // scrubbing" — first up-arrow press jumps to the most recent entry; typing any
  // printable char resets it.
  const promptHistoryRef = useRef<string[]>([]);
  const promptHistoryIdxRef = useRef<number>(-1);
  // Timestamp of the most recent ESC keypress. Used to discard the trailing byte of
  // an Option+<letter> sequence that some terminals (VS Code's xterm.js) split into
  // two keypresses.
  const lastEscapeAtRef = useRef<number>(0);
  // When set, the next confirm prompt's yes/no resolves locally via these callbacks
  // instead of being forwarded to the agent. Used by `/lint-deep` (and any future
  // command that wants to gate an expensive LLM call on a local Y/N).
  const pendingConfirmActionRef = useRef<null | { onYes: () => void; onNo: () => void }>(null);
  // Measured rendered height of the App's outer Box. Used by PetSpritePanel to map
  // mouse-Y onto pet sprite coordinates correctly even when content doesn't fill the
  // terminal (intro screen, short conversations).
  const containerRef = useRef<DOMElement>(null);
  const [renderHeight, setRenderHeight] = useState(process.stdout.rows ?? 24);
  // Reactive terminal-row count. Pet eye-tracking anchors to terminal_bottom - 5,
  // so the calculation needs to follow window resizes. Ink doesn't expose a
  // ready-made hook, so we listen to stdout's resize event ourselves.
  const [terminalRows, setTerminalRows] = useState(process.stdout.rows ?? 24);
  useEffect(() => {
    const onResize = () => {
      setTerminalRows(process.stdout.rows ?? 24);
    };
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);
  useEffect(() => {
    if (!containerRef.current) return;
    const { height } = measureElement(containerRef.current);
    if (height > 0) setRenderHeight(prev => (prev === height ? prev : height));
  });
  // Refs so submit() (useCallback []) always reads the latest values
  const modelIdxRef = useRef(DEFAULT_MODEL_IDX);
  const modeRef = useRef<Mode>('plan');
  const abortRef = useRef<AbortController | null>(null);
  // Game / food picker selection — used inside the /pet play and /pet feed
  // handlers in submit(). Without these refs, submit captures the initial
  // picker indices (always 0) and ignores arrow-key navigation, so picking
  // "exam" still launched "fetch" and picking any non-first food always used
  // the first food.
  const petPlayIdxRef = useRef(0);
  const petFeedIdxRef = useRef(0);
  useEffect(() => { modelIdxRef.current = modelIdx; }, [modelIdx]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { petPlayIdxRef.current = petPlayIdx; }, [petPlayIdx]);
  useEffect(() => { petFeedIdxRef.current = petFeedIdx; }, [petFeedIdx]);
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

  // Transient toast surfaced when a coin event fires (lint fix, push, etc.).
  // Auto-clears after a few seconds so it doesn't linger past the moment.
  const [coinToast, setCoinToast] = useState<{ delta: number; reason: string } | null>(null);

  // Track cumulative passive earnings (model add/update) this session — capped
  // at PASSIVE_SESSION_CAP so a refactor that touches 100 files doesn't dump
  // 500 coins. Lint fixes, pushes, dbt runs are NOT capped (they reflect real
  // work). Resets on app restart, intentionally — the cap is per-session.
  const passiveEarnedRef = useRef(0);

  // Register the coin-event handler once at mount. State.ts (lint pipeline)
  // and future emitters (git poll, dbt tool wrappers) call emitCoinEvent;
  // this handler applies the delta to the pet and shows a transient toast.
  useEffect(() => {
    registerCoinEventHandler((event: CoinEvent) => {
      let delta = event.delta;
      if (event.countsTowardPassiveCap && delta > 0) {
        const headroom = Math.max(0, PASSIVE_SESSION_CAP - passiveEarnedRef.current);
        delta = Math.min(delta, headroom);
        passiveEarnedRef.current += delta;
        if (delta === 0) return;  // cap hit — silently drop
      }
      const next = addCoins(petRef.current, delta);
      petRef.current = next;
      setPet(next);
      savePet(next);
      setCoinToast({ delta, reason: event.reason });
      setTimeout(() => setCoinToast(c => (c && c.reason === event.reason ? null : c)), 4_000);
    });
    return () => registerCoinEventHandler(null);
  }, []);

  // Active pet mini-game (currently 'fetch'). When set, the game owns the screen +
  // input; the welcome / conversation view is suppressed and the App-level mouse
  // handler short-circuits via activeGameRef so clicks don't double-fire as both
  // "throw to fetch" AND "tap the StatusFooter pet". onExit applies any happiness
  // boost the game earned, like the old /pet play tap did instantly.
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const activeGameRef = useRef<string | null>(null);
  useEffect(() => { activeGameRef.current = activeGame; }, [activeGame]);

  // Full-screen scrollable conversation view (triggered by /review or /scroll).
  // Replaces the normal TUI with a keyboard-navigable history so users don't
  // depend on VS Code's terminal scrollback to read back through long sessions.
  const [reviewMode, setReviewMode] = useState(false);
  const [awaitingAdminKey, setAwaitingAdminKey] = useState(false);
  const awaitingAdminKeyRef = useRef(false);
  // When set to a non-null string, the render path swaps the conversation view
  // for the interactive /usage graph (stacked-bar time series). The string IS
  // the Admin API key — passed to the modal directly so it can fetch series
  // data without re-reading from disk. Set to null to close.
  const [usageGraphKey, setUsageGraphKey] = useState<string | null>(null);
  // Pane mode toggle. When ON, bk1 enables xterm mouse tracking so the dbt
  // log pane's wheel/click/scrollbar/copy button respond again — at the cost
  // of the terminal's native scroll/select. When OFF (default), no mouse
  // tracking, native terminal everything. Toggled via Ctrl+P in useInput.
  const [paneMode, setPaneMode] = useState(false);
  // Terminal mode toggle. When ON, lines submitted at the prompt run as shell
  // commands via runShellCommand (no LLM, no tokens) — prefix with `?` to ask
  // the agent. When OFF (default), submitted lines go to the agent — prefix
  // with `!` to shell out for a single command. Toggled via Ctrl+T.
  const [terminalMode, setTerminalMode] = useState(false);
  const terminalModeRef = useRef(false);
  // Live shell indicator state. liveShellCmd is the command currently running
  // (null when idle); liveShellText is the rolling stdout+stderr buffer that
  // gets rendered in the dynamic frame so the user sees output as it streams
  // instead of waiting for the command to exit.
  const [liveShellCmd, setLiveShellCmd] = useState<string | null>(null);
  const [liveShellText, setLiveShellText] = useState('');
  const shellProcRef = useRef<ReturnType<typeof Bun.spawn> | null>(null);
  // IDE context indicator. Polls ~/.bk1/ide-context.json once a second so the
  // user can see at a glance which file (and selection) bk1 is about to send
  // as ambient context with the next prompt. Same freshness rules as the
  // submit-time injection — stale snapshots render as null.
  const [ideCtx, setIdeCtx] = useState<IdeContext | null>(null);
  useEffect(() => {
    const tick = () => setIdeCtx(readIdeContextRaw());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Unified mouse-tracking lifecycle. Tracking is ON if EITHER a pet mini-game
  // is active (fetch needs to receive clicks) OR pane mode is on (dbt pane
  // wheel/click/scrollbar). Otherwise OFF, so the terminal handles wheel/select
  // natively (Claude Code-style). This replaces the per-callsite enable/disable
  // calls that were leaving the terminal stuck in inconsistent states.
  useEffect(() => {
    const want = activeGame !== null || paneMode;
    if (want === mouseTrackingOnRef.current) return;
    if (want) {
      void import('./mouse').then(m => {
        m.enableMouseTracking(process.stdout);
        mouseTrackingOnRef.current = true;
      });
    } else {
      disableMouseTracking(process.stdout);
      mouseTrackingOnRef.current = false;
    }
  }, [activeGame, paneMode]);

  // Re-evaluate the desired mouse-mode state whenever the pet flips between awake and
  // asleep. Polled once per second while the effect is active to catch natural wake-up
  // (sleeping_until elapses) without lifting the sleep timer into App-level reactivity.
  // Grace period: if the user has scrolled the dbt log pane in the last 3s we keep mouse
  // tracking ON even if the pet is "asleep" — otherwise tracking would flip off mid-scroll
  // and the next wheel tick would go to the terminal instead of the pane.
  const mouseTrackingOnRef = useRef(false);
  const lastPaneScrollAtRef = useRef(0);
  // Called on every dbt-pane scroll interaction (wheel or keyboard). Stamps the
  // grace-period ref so the mouse-tracking poll keeps tracking ON for ~3s after
  // the last scroll. (Previously this also put the pet to sleep — that was a
  // workaround for eye-tracking flicker, which the direct-stdout pet overlay
  // now handles. Auto-sleeping on scroll just disabled mouse tracking after 3s
  // and broke the user's ability to keep scrolling the pane with the mouse.)
  const markPaneScroll = useCallback(() => {
    lastPaneScrollAtRef.current = Date.now();
  }, []);
  // Mouse tracking is intentionally never enabled. Claude Code and other
  // well-behaved terminal apps don't capture the mouse, which lets VS Code's
  // terminal scrollback, native text selection, and wheel scroll keep working.
  // The cost: bk1's click-driven features (pet tap, [copy] click, scrollbar
  // drag) no longer fire — they all have keyboard equivalents (`/pet play`,
  // `Ctrl+Y` for copy, `PgUp/PgDn`/`Shift+↑↓` for pane scroll). Run a one-shot
  // disable in case a previous bk1 session left the terminal in mouse mode.
  useEffect(() => {
    disableMouseTracking(process.stdout);
    mouseTrackingOnRef.current = false;
  }, []);

  // Live mouse cursor position — drives the pet's eye-tracking. `null` means we haven't
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
      // While a mini-game is active it owns mouse input — its own handler parses
      // the same stdin chunk. Bail out so a single click doesn't fire both "throw
      // to fetch" AND "tap the StatusFooter pet" (which would credit happiness twice
      // and re-render the bottom bar mid-game).
      if (activeGameRef.current) return;
      const events = parseMouseEvents(data.toString('utf8'));
      // Maps a terminal row inside the scrollbar track onto scrollV. Top of track
      // = oldest content (max scrollV); bottom = newest (scrollV=0). Used by both
      // the initial press and motion-while-dragging branches below.
      const rowToScrollV = (row: number): number | null => {
        const b = dbtPaneBoundsRef.current;
        if (!b) return null;
        const paneHeight = b.trackBottom - b.trackTop + 1;
        const maxScrollV = Math.max(0, dbtLogsRef.current.length - paneHeight);
        const range = b.trackBottom - b.trackTop;
        if (range <= 0) return 0;
        const clamped = Math.max(b.trackTop, Math.min(b.trackBottom, row));
        const ratio = (clamped - b.trackTop) / range; // 0 at top, 1 at bottom
        return Math.round((1 - ratio) * maxScrollV);
      };
      // Horizontal twin of rowToScrollV — maps cursor col on the h-scrollbar
      // onto scrollH. Max scrollH = widest log line minus the pane's visible
      // content cols (border + padding + v-scrollbar = ~5 cols of chrome).
      const colToScrollH = (col: number): number | null => {
        const b = dbtPaneBoundsRef.current;
        if (!b) return null;
        const range = b.hbarRight - b.hbarLeft;
        if (range <= 0) return 0;
        const contentW = Math.max(1, (b.right - b.left + 1) - 5);
        // Strip ANSI escape codes so the max-scroll bound matches the actual
        // visible content width (not the raw string length, which is inflated
        // by color escapes and would let the user scroll into empty space).
        const stripAnsi = (s: string) => s.replace(/\x1b\[[\d;?]*[A-Za-z~]/g, '');
        const maxLine = dbtLogsRef.current.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
        const maxScrollH = Math.max(0, maxLine - contentW);
        const clamped = Math.max(b.hbarLeft, Math.min(b.hbarRight, col));
        const ratio = (clamped - b.hbarLeft) / range;
        return Math.round(ratio * maxScrollH);
      };
      for (const ev of events) {
        // Release event (any button): always clear an in-progress scrollbar drag so
        // the next motion event doesn't keep dragging without a held button.
        if (!ev.press && !ev.motion) {
          if (dbtDragRef.current) dbtDragRef.current = null;
          continue;
        }
        if (ev.motion) {
          // Scrollbar drag: dispatch on which bar the user grabbed.
          if (dbtDragRef.current === 'v') {
            const next = rowToScrollV(ev.row);
            if (next !== null) setDbtScrollV(next);
            continue;
          }
          if (dbtDragRef.current === 'h') {
            const next = colToScrollH(ev.col);
            if (next !== null) setDbtScrollH(next);
            continue;
          }
          // Eye tracking removed. PetSpritePanel falls through to the default
          // (forward-facing) sprite when petMousePos.col/row stay null, which
          // they do because nothing writes to them anymore. Trade-off: pet eyes
          // no longer follow the cursor, but we eliminate the dominant source
          // of awake-state Ink repaints — and reliable native text selection
          // matters more than the eye-tracking feature.
          continue;
        }
        // Wheel handling: if the dbt pane is visible, scroll it (vertical by
        // default, horizontal with Shift). If not visible, the wheel is just
        // ignored — bk1 no longer auto-puts the pet to sleep / releases mouse
        // tracking on wheel. That legacy "release for native scrollback"
        // shortcut kept breaking pane scroll on cursor-position edge cases.
        // To get the terminal's native scrollback now, use `/pet sleep`
        // explicitly — that's the single, predictable release path.
        if (ev.button === 'wheel-up' || ev.button === 'wheel-down') {
          if (dbtLogsRef.current.length > 0) {
            const step = 3;
            if (ev.shift) {
              setDbtScrollH(h => Math.max(0, h + (ev.button === 'wheel-up' ? -step : step)));
            } else {
              setDbtScrollV(v => Math.max(0, v + (ev.button === 'wheel-up' ? step : -step)));
            }
            markPaneScroll();
          }
          continue;
        }
        if (ev.button !== 'left' || !ev.press) continue;
        const b = dbtPaneBoundsRef.current;
        // Horizontal scrollbar press FIRST so it wins the (row=trackBottom,
        // col=scrollCol) overlap when the user clicks on the visible h-bar.
        // ±1 row tolerance absorbs the same off-by-one we hit with [copy].
        // Exclude clicks that land exactly inside the v-scrollbar track at its
        // dedicated column — those are intentional v-scrollbar clicks and
        // shouldn't be hijacked by the h-bar's tolerance band.
        if (b && Math.abs(ev.row - b.hbarRow) <= 1
            && ev.col >= b.hbarLeft && ev.col <= b.hbarRight
            && !((ev.col === b.scrollCol || ev.col === b.scrollCol + 1) && ev.row >= b.trackTop && ev.row <= b.trackBottom)) {
          dbtDragRef.current = 'h';
          const next = colToScrollH(ev.col);
          if (next !== null) setDbtScrollH(next);
          continue;
        }
        // Vertical scrollbar press.
        if (b && (ev.col === b.scrollCol || ev.col === b.scrollCol + 1) && ev.row >= b.trackTop && ev.row <= b.trackBottom) {
          dbtDragRef.current = 'v';
          const next = rowToScrollV(ev.row);
          if (next !== null) setDbtScrollV(next);
          continue;
        }
        // Copy-to-clipboard hit: [copy] text in DbtLogPane header.
        // - Hit box: ±1 row around copyRow (absorbs off-by-one in CHROME math),
        //   col from copyLeft-2 to right (the whole right portion of the header
        //   so click position doesn't have to be pixel-perfect on "[copy]").
        // - Spawn: node's spawnSync with `input` — synchronously pipes the text
        //   to pbcopy/xsel stdin. Replaces the earlier Bun.spawn calls which
        //   weren't reliably delivering stdin before the process exited.
        // - Strip ANSI so the clipboard gets plain text.
        if (b
            && ev.row >= b.copyRow - 2 && ev.row <= b.copyRow + 2
            && ev.col >= b.copyLeft - 2 && ev.col <= b.right) {
          const stripAnsi = (s: string) => s.replace(/\x1b\[[\d;?]*[A-Za-z~]/g, '');
          const text = dbtLogsRef.current.map(stripAnsi).join('\n');
          const argv: string[] = process.platform === 'darwin'
            ? ['pbcopy']
            : ['xsel', '--clipboard', '--input'];
          try {
            spawnSync(argv[0]!, argv.slice(1), { input: text });
          } catch { /* clipboard tool not on PATH; ignore silently */ }
          setCopyFlash(true);
          setTimeout(() => setCopyFlash(false), 800);
          continue;
        }
        // Click anywhere over the pane (other than [copy]) is absorbed so it doesn't
        // also register as a pet-tap in the StatusFooter band below.
        if (b && ev.col >= b.left && ev.col <= b.right && ev.row >= b.top && ev.row <= b.bottom) {
          continue;
        }
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

  const isModelPicker   = input.startsWith('/model');
  // /pet play (with or without trailing chars) → arrow-key game picker.
  // Matches "/pet play" exactly OR "/pet play <anything>" so partial typing
  // of a game id keeps the picker visible.
  const isPetPlayPicker = input === '/pet play' || input.startsWith('/pet play ');
  const isPetFeedPicker = input === '/pet feed' || input.startsWith('/pet feed ');

  const suggestions = useMemo(() => {
    if (isModelPicker || isPetPlayPicker || isPetFeedPicker) return [] as [string, typeof SKILLS[string]][];
    if (!input.startsWith('/')) return [] as [string, typeof SKILLS[string]][];
    const partial = input.slice(1).split(' ')[0]?.toLowerCase() ?? '';
    return Object.entries(SKILLS).filter(([cmd]) => cmd.startsWith(partial)) as [string, typeof SKILLS[string]][];
  }, [input, isModelPicker, isPetPlayPicker, isPetFeedPicker]);

  const submit = useCallback(async () => {
    let raw = inputRef.current.trim();
    if (!raw || isRunningRef.current) return;
    setConfirmPrompt(null);
    // Push to prompt history (shell-style, with HIST_IGNOREDUPS — skip if identical
    // to the most recent entry). Reset scrub index on every submit so the next
    // up-arrow press starts from the newest entry.
    const h = promptHistoryRef.current;
    if (h.length === 0 || h[h.length - 1] !== raw) h.push(raw);
    promptHistoryIdxRef.current = -1;

    // Admin key entry — intercept BEFORE all other handlers so the pasted key
    // isn't interpreted as a slash command or chat message.
    if (awaitingAdminKeyRef.current) {
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      setAwaitingAdminKey(false); awaitingAdminKeyRef.current = false;
      if (!isValidKeyShape(raw)) {
        setMessages(prev => [
          ...prev,
          { role: 'assistant', content: 'Invalid key — must start with "sk-ant-" and be at least 20 characters. Run /usage to try again.' },
        ]);
        return;
      }
      storeAdminKey(raw);
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Admin key saved. Opening usage graph…' },
      ]);
      setUsageGraphKey(raw);
      return;
    }

    // Terminal-mode routing. `!cmd` always shells out (one-shot from prompt
    // mode); in terminal mode, anything that isn't a `?`-prefixed agent query
    // or a `/`-prefixed skill shells out by default. Routed BEFORE local UI
    // commands so `/plan`, `/model`, etc. still work from terminal mode.
    const inTerm = terminalModeRef.current;
    if (raw.startsWith('!') || (inTerm && !raw.startsWith('?') && !raw.startsWith('/'))) {
      const cmd = (raw.startsWith('!') ? raw.slice(1) : raw).trim();
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      if (!cmd) return;
      if (shellProcRef.current) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'A shell command is still running. Press Esc to abort it, then re-submit.' }]);
        return;
      }
      setMessages(prev => [...prev, { role: 'user', content: (raw.startsWith('!') ? '!' : '') + cmd }]);
      void runInlineShell(cmd);
      return;
    }
    // In terminal mode, `?prompt` strips the prefix and falls through to the
    // normal agent flow.
    if (inTerm && raw.startsWith('?')) {
      const rest = raw.slice(1).trim();
      if (!rest) { setInput(''); inputRef.current = ''; setSuggestionIndex(-1); return; }
      raw = rest;
    }

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
    // /lint-deep — gate the (expensive) semantic pass on a local Y/N if a report
    // already exists in <project>/.bk1/lint-report.html. The check + prompt happen
    // entirely client-side; the LLM is only called if the user explicitly opts in.
    // `--force` bypasses the gate so a deliberate re-run never asks twice.
    if (raw === '/lint-deep' || (raw.startsWith('/lint-deep ') && !raw.includes('--force'))) {
      if (existsSync(LINT_REPORT_PATH)) {
        pendingConfirmActionRef.current = {
          onYes: () => {
            inputRef.current = '/lint-deep --force';
            void submit();
          },
          onNo: () => {
            setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
            setMessages(prev => [
              ...prev,
              { role: 'user', content: raw },
              { role: 'assistant', content: `Existing lint report: ${LINT_REPORT_PATH}\n\nOpen it in your browser, or run \`/lint-deep --force\` to overwrite with a fresh semantic pass.` },
            ]);
          },
        };
        setConfirmPrompt(`A lint report already exists at ${LINT_REPORT_PATH}. Re-run /lint-deep and overwrite it? (yes/no)`);
        return;
      }
    }
    if (raw === '/usage') {
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      const adminKey = getStoredAdminKey();
      if (!adminKey) {
        setAwaitingAdminKey(true); awaitingAdminKeyRef.current = true;
        setMessages(prev => [
          ...prev,
          { role: 'user',      content: raw },
          { role: 'assistant', content: `Enter your Claude Admin API key to fetch organization usage.\nGet one at console.anthropic.com/settings/admin-keys\n\nPaste your key and press Enter:` },
        ]);
        return;
      }
      setUsageGraphKey(adminKey);
      return;
    }
    if (raw === '/find' || raw.startsWith('/find ')) {
      // Highlight matching lines in the dbt log pane. /find with no argument
      // clears the highlight. Local — no LLM call.
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      const query = raw.slice('/find'.length).trim();
      setDbtSearchQuery(query);
      const matchCount = query
        ? dbtLogsRef.current.filter(l => l.toLowerCase().includes(query.toLowerCase())).length
        : 0;
      const note = query
        ? `Highlighting "${query}" in dbt logs (${matchCount} match${matchCount === 1 ? '' : 'es'}). Run /find with no argument to clear.`
        : `Cleared dbt log search.`;
      setMessages(prev => [
        ...prev,
        { role: 'user',      content: raw },
        { role: 'assistant', content: note },
      ]);
      return;
    }
    if (raw === '/review' || raw === '/scroll') {
      // Enter full-screen scrollable conversation view. The App's render path
      // short-circuits to <ReviewMode/> while `reviewMode` is true; Esc inside
      // ReviewMode calls onExit which flips it back to false.
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      setReviewMode(true);
      return;
    }
    if (raw === '/history') {
      // Snapshot the current conversation to a markdown file and open it in a
      // VS Code editor pane next to the terminal. Lets users review long agent
      // output (lint findings, analyses) in a fully scrollable, searchable,
      // copy-able editor view without fighting the terminal's mouse-tracking
      // selection limits. Snapshot is point-in-time; re-run /history for an
      // updated view.
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      const md: string[] = [`# bk1 session — ${new Date().toISOString()}`, ''];
      for (const msg of messagesRef.current) {
        if (msg.role === 'user') {
          md.push(`## > ${msg.content}`, '');
        } else {
          md.push(msg.content, '');
        }
      }
      const dir  = `${PROJECT_DIR}/.bk1`;
      const path = `${dir}/session-${Date.now()}.md`;
      let note: string;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, md.join('\n'));
        // Try `code <path>` first (VS Code's CLI). Falls back to just reporting
        // the path if `code` isn't on PATH.
        const r = spawnSync('code', [path], { stdio: 'ignore' });
        note = r.status === 0
          ? `Opened conversation log in VS Code: ${path}`
          : `Saved conversation log to: ${path}\n\nOpen it with:  code ${path}`;
      } catch (e) {
        note = `Failed to save history: ${e instanceof Error ? e.message : String(e)}`;
      }
      setMessages(prev => [
        ...prev,
        { role: 'user',      content: raw },
        { role: 'assistant', content: note },
      ]);
      return;
    }
    // Local greeting reply — short-circuits the LLM for boilerplate "hi" / "what
    // can you do" inputs. Not added to historyRef so the LLM never sees these
    // turns on subsequent prompts (no token cost now, no cache pollution later).
    if (isGreeting(raw)) {
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      setMessages(prev => [
        ...prev,
        { role: 'user',      content: raw },
        { role: 'assistant', content: GREETING_TEMPLATE },
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
        // Arg present → direct purchase (`/pet feed snack`). No arg → use the
        // FoodPicker's current selection. feed() returns {state, error?} —
        // surface the error verbatim (covers "not enough coins" and "unknown
        // food") and skip the success message.
        const ids = Object.keys(FOODS);
        let foodId: string | null;
        if (arg) {
          foodId = arg;
        } else {
          foodId = ids[petFeedIdxRef.current] ?? ids[0] ?? null;
        }
        if (!foodId) {
          note = 'No foods are registered.';
        } else {
          const result = feed(nextPet, foodId);
          nextPet = result.state;
          if (result.error) {
            note = result.error;
          } else {
            const food = FOODS[foodId]!;
            note = `You fed ${nextPet.name ?? 'your pet'} a ${food.label.toLowerCase()} (-${food.cost} 🪙 ).`;
          }
        }
      } else if (sub === 'play') {
        // Arg present → direct launch (`/pet play fetch`); arg invalid → error.
        // No arg → launch whatever the GamePicker is currently highlighting.
        // Happiness is credited inside each game's onExit (it accumulates
        // per-click), so launching does not tap stats by itself.
        if (arg && GAMES[arg]) {
          setActiveGame(arg);
          return;
        }
        if (arg) {
          const ids = Object.keys(GAMES).map(id => `/pet play ${id}`).join(' · ');
          note = `Unknown game "${arg}". Try: ${ids}`;
        } else {
          const ids = Object.keys(GAMES);
          const picked = ids[petPlayIdxRef.current] ?? ids[0];
          if (picked) {
            setActiveGame(picked);
            return;
          }
          note = 'No games are registered.';
        }
      } else if (sub === 'sleep') {
        nextPet = petSleep(nextPet);
        // Release the mouse synchronously, before the next render — otherwise the
        // user has to wait for the polling effect to re-run before scroll/select
        // works. Also update the ref so the effect's apply() doesn't re-enable.
        disableMouseTracking(process.stdout);
        mouseTrackingOnRef.current = false;
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

    // dbt passthrough — `dbt …` typed literally runs as a real subprocess.
    // No LLM call, no token spend; output streams to the right-side log pane.
    // Echo the command into the chat as a user message so the scrollback still
    // shows what the user ran (in order with surrounding prompts).
    if (/^dbt(\s|$)/.test(raw)) {
      setInput(''); inputRef.current = ''; setSuggestionIndex(-1);
      setMessages(prev => [...prev, { role: 'user', content: raw }]);
      void runShellCommand(raw);
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

    // If the bk1-context VS Code extension is installed and reporting fresh state,
    // prepend the IDE snapshot as a <system-reminder> so the model sees the active
    // file + selection alongside the user's prompt (same shape Claude Code uses).
    // displayText (rendered in chat) stays clean — only the LLM-bound history gets
    // the extra context, so it doesn't clutter the user's view of what they typed.
    const ideContext = readIdeContextBlock();
    const promptForLLM = ideContext ? `${ideContext}\n\n${promptText}` : promptText;

    setMessages(prev => [...prev, { role: 'user', content: displayText }]);
    historyRef.current.push({ role: 'user', content: promptForLLM });

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

            // Persist a row per LLM call to the global ~/.bk1/usage.db so the
            // Projects tab can break lifetime spend down by dbt project path.
            recordProjectUsage({
              projectPath: PROJECT_DIR,
              model,
              input:       u.inputTokens,
              output:      u.outputTokens,
              cacheRead:   u.cacheReadTokens,
              cacheWrite:  u.cacheWriteTokens,
              costUsd:     estimateCostUsd({
                input:      u.inputTokens,
                output:     u.outputTokens,
                cacheRead:  u.cacheReadTokens,
                cacheWrite: u.cacheWriteTokens,
              }, model),
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

  // dbt passthrough runner. Spawned via `bash -c` so the user's quoting + flags
  // (`-s tag:foo`, `--vars '{...}'`) round-trip the same way they would in a
  // real shell. FORCE_COLOR=1 makes dbt emit ANSI even though stdout is a pipe;
  // parseAnsi in DbtLogPane translates that to Ink-friendly spans.
  const DBT_LOG_CAP = 1000;
  const appendDbtLines = useCallback((lines: string[]) => {
    if (lines.length === 0) return;
    setDbtLogs(prev => {
      const next = prev.concat(lines);
      return next.length > DBT_LOG_CAP ? next.slice(next.length - DBT_LOG_CAP) : next;
    });
    // When the user is scrolled up (scrollV > 0), bump scrollV by the number of
    // newly appended lines so their visible window stays anchored on the same
    // content instead of sliding forward under them. When scrollV === 0 we're
    // auto-tailing — leave it alone so the next render shows the new tail.
    setDbtScrollV(v => v === 0 ? 0 : v + lines.length);
  }, []);
  const runShellCommand = useCallback(async (raw: string) => {
    // Each new run starts with a clean pane — prior output is dropped (still
    // available via the [copy] button before the user triggers another run).
    setDbtLogs([`$ ${raw}`]);
    setDbtScrollV(0);
    setDbtScrollH(0);
    setDbtRunning(true);
    try {
      const proc = Bun.spawn(['bash', '-c', raw], {
        cwd: PROJECT_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' },
      });
      dbtProcRef.current = proc;
      const decoder = new TextDecoder();
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          if (parts.length) appendDbtLines(parts);
        }
        if (buf) appendDbtLines([buf]);
      };
      await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>),
                         pump(proc.stderr as ReadableStream<Uint8Array>)]);
      const code = await proc.exited;
      appendDbtLines([`[exit ${code}]`, '']);
      // Award coins on successful run. Only `dbt run / build / test` count as
      // "real work"; arbitrary shell commands (`ls`, `git status`, etc.) routed
      // through here from terminal mode or `!`-escape do not.
      if (code === 0) {
        const tokens = raw.trim().split(/\s+/);
        if (tokens[0] === 'dbt') {
          const sub = tokens[1];
          if (sub === 'run' || sub === 'build') {
            emitCoinEvent({ type: 'dbt_run',  delta: COIN_REWARDS.dbtRun,  reason: `dbt ${sub}` });
          } else if (sub === 'test') {
            emitCoinEvent({ type: 'dbt_test', delta: COIN_REWARDS.dbtTest, reason: 'dbt test' });
          }
        }
      }
    } catch (err) {
      appendDbtLines([`error: ${err instanceof Error ? err.message : String(err)}`, '']);
    } finally {
      dbtProcRef.current = null;
      setDbtRunning(false);
    }
  }, [appendDbtLines]);

  // Inline shell runner — for `!cmd` escapes and terminal-mode lines. Streams
  // stdout+stderr through the live indicator block (so the user sees output
  // as it's produced) and commits the full result as an assistant message
  // when the process exits. The dbt log pane stays reserved for `dbt …` runs.
  //
  // 2>&1 in the bash invocation merges stderr into stdout so we only need to
  // pump one stream and ordering is preserved (interleaved reads of two
  // separate streams can race). PROJECT_DIR matches runShellCommand's cwd.
  const runInlineShell = useCallback(async (cmd: string) => {
    setLiveShellCmd(cmd);
    setLiveShellText('');
    let buffer = '';
    const ansi = /\x1b\[[\d;?]*[A-Za-z~]/g;
    try {
      const proc = Bun.spawn(['bash', '-c', `${cmd} 2>&1`], {
        cwd: PROJECT_DIR,
        stdout: 'pipe',
      });
      shellProcRef.current = proc;
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(ansi, '');
        setLiveShellText(buffer);
      }
      const code = await proc.exited;
      const out = buffer.replace(/\s+$/, '');
      const content = out
        ? (code === 0 ? out : `${out}\n[exit ${code}]`)
        : (code === 0 ? '(no output)' : `[exit ${code}]`);
      setMessages(prev => [...prev, { role: 'assistant', content }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `error: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      shellProcRef.current = null;
      setLiveShellCmd(null);
      setLiveShellText('');
    }
  }, []);

  useInput((inputChar, key) => {
    // When a pet mini-game is active, it owns input — bail out so App's
    // handlers (Enter→submit, ↑↓ history scroll, Shift+↑↓ dbt-pane scroll,
    // Ctrl+L clear, etc.) don't fire alongside the game's own useInput and
    // eat/duplicate its key events.
    if (activeGameRef.current) return;
    // SGR mouse-event residue (e.g. `[<64;10;20M` from a wheel tick) sometimes
    // leaks through Ink's keypress parser as "printable text" right after the
    // dedicated raw-stdin handler processes the same event. Drop it here so
    // none of the keypress handlers below — especially the wake-on-keypress
    // hook — react to what was actually a mouse event. Without this guard a
    // wheel scroll would put the pet to sleep and immediately wake it back up.
    if (inputChar && /\[<\d+;\d+;\d+[Mm]/.test(inputChar)) return;

    // Keyboard scroll for the dbt log pane. Lets users review log history with
    // the pet asleep (= mouse tracking off = selection works) — no mouse needed,
    // so there's no animation/repaint cost. PgUp/PgDn = page; Shift+↑/↓ = line.
    // Returns early so these keys don't trigger the wake-on-keypress hook below.
    if (dbtLogsRef.current.length > 0) {
      const paneHeight = Math.max(6, Math.floor((process.stdout.rows ?? 24) / 2));
      const maxScrollV = Math.max(0, dbtLogsRef.current.length - paneHeight);
      const pageStep   = Math.max(1, paneHeight - 1);
      // Ctrl+Y: copy the current logs to the system clipboard. Lets the user
      // copy without the mouse — important because mouse tracking is off while
      // the pet is asleep, and clicks don't reach bk1 to hit the [copy] button.
      if (key.ctrl && inputChar === 'y') {
        const stripAnsi = (s: string) => s.replace(/\x1b\[[\d;?]*[A-Za-z~]/g, '');
        const text = dbtLogsRef.current.map(stripAnsi).join('\n');
        const argv: string[] = process.platform === 'darwin'
          ? ['pbcopy']
          : ['xsel', '--clipboard', '--input'];
        try { spawnSync(argv[0]!, argv.slice(1), { input: text }); }
        catch { /* clipboard tool not on PATH; ignore */ }
        setCopyFlash(true);
        setTimeout(() => setCopyFlash(false), 800);
        return;
      }
      if (key.pageUp) {
        setDbtScrollV(v => Math.min(maxScrollV, v + pageStep));
        markPaneScroll();
        return;
      }
      if (key.pageDown) {
        setDbtScrollV(v => Math.max(0, v - pageStep));
        markPaneScroll();
        return;
      }
      if (key.shift && key.upArrow) {
        setDbtScrollV(v => Math.min(maxScrollV, v + 1));
        markPaneScroll();
        return;
      }
      if (key.shift && key.downArrow) {
        setDbtScrollV(v => Math.max(0, v - 1));
        markPaneScroll();
        return;
      }
      // Shift+←/→: horizontal scroll. Step by 4 cols per press. Bounded
      // loosely by the widest log line; if the user over-scrolls, lines just
      // appear blank and they can scroll back. No max enforcement here.
      if (key.shift && key.leftArrow) {
        setDbtScrollH(h => Math.max(0, h - 4));
        markPaneScroll();
        return;
      }
      if (key.shift && key.rightArrow) {
        // Use stripped (ANSI-free) line length so we don't allow scrolling
        // past where there's actually visible content.
        const stripAnsi = (s: string) => s.replace(/\x1b\[[\d;?]*[A-Za-z~]/g, '');
        const maxLine = dbtLogsRef.current.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
        setDbtScrollH(h => Math.min(Math.max(0, maxLine - 10), h + 4));
        markPaneScroll();
        return;
      }
      // Shift+Home (or just inputChar === '0' with Ctrl) — fast reset to col 0
      // when the user has scrolled right and wants to get back to the line
      // starts. Ink's Key type doesn't expose Home, so we use Ctrl+0.
      if (key.ctrl && inputChar === '0') {
        setDbtScrollH(0);
        markPaneScroll();
        return;
      }
    }

    // Any real keypress while the pet is asleep wakes it up — the closest natural
    // substitute to "click the pet to wake it" we can offer without re-enabling
    // mouse capture (which would re-break drag-selection and the wheel). The
    // wake happens before any other key handling so e.g. Esc/Ctrl+C still do
    // their job, but the pet is awake on the next render and mouse tracking
    // resumes for eye-following.
    if (isSleeping(petRef.current)) {
      const woke = wakePet(petRef.current);
      petRef.current = woke;
      setPet(woke);
      savePet(woke);
      // Mouse tracking is no longer enabled (see startup useEffect). Waking
      // the pet is now a pure visual/state change — no terminal mode flip.
    }
    // Ctrl+C always exits. ESC interrupts a running agent; when idle, ESC is a no-op
    // so users can't accidentally kill the app with one keystroke.
    if (key.ctrl && inputChar === 'c') process.exit(0);
    // Ctrl+L force-redraws the UI — recovery hatch when the terminal's cursor gets
    // out of sync with Ink (e.g. after a stray escape sequence from Option+key in
    // VS Code's xterm.js, or a window resize). Clears scrollback below the cursor
    // and resets to row 1 col 1; Ink's next paint fills it back in correctly.
    if (key.ctrl && inputChar === 'l') {
      process.stdout.write('\x1b[2J\x1b[H');
      return;
    }
    // Ctrl+P: toggle pane mode. The unified useEffect above watches paneMode
    // and enables/disables xterm mouse tracking accordingly.
    if (key.ctrl && inputChar === 'p') {
      setPaneMode(prev => !prev);
      return;
    }
    // Ctrl+T: toggle terminal mode (shell-passthrough at the prompt).
    if (key.ctrl && inputChar === 't') {
      terminalModeRef.current = !terminalModeRef.current;
      setTerminalMode(terminalModeRef.current);
      return;
    }
    if (key.escape) {
      // Remember when ESC fired. Option+<letter> in some terminals (notably VS Code's
      // xterm.js) gets split into two keypresses — ESC, then the letter — instead of
      // arriving as a single key.meta event. Without this guard the orphan letter
      // falls through to the printable-char branch and gets appended to the input
      // (that's the `Sonnet 4.et` glitch where typed letters bled into the model badge).
      lastEscapeAtRef.current = Date.now();
      if (isRunningRef.current) abortRef.current?.abort();
      if (dbtProcRef.current) { try { dbtProcRef.current.kill(); } catch { /* already exited */ } }
      if (shellProcRef.current) { try { shellProcRef.current.kill(); } catch { /* already exited */ } }
      // When nothing's running, Esc clears the input — dismisses any open
      // picker (/model, /pet play, /pet feed) and acts as a general
      // "cancel current entry" affordance.
      if (!isRunningRef.current && !dbtProcRef.current && inputRef.current.length > 0) {
        inputRef.current = '';
        setInput('');
        setSuggestionIndex(-1);
      }
      return;
    }
    if (isRunningRef.current) {
      if (inputChar === 't') setLiveExpanded(e => !e);
      return;
    }

    // Confirm bar — arrow keys navigate, Enter confirms, Y/N quick-select.
    // If a local deferred action is pending (e.g. `/lint-deep` overwrite gate),
    // its callbacks fire instead of forwarding yes/no to the agent.
    if (confirmPrompt !== null) {
      const resolve = (value: 'yes' | 'no') => {
        const action = pendingConfirmActionRef.current;
        if (action) {
          pendingConfirmActionRef.current = null;
          setConfirmPrompt(null);
          setConfirmSelected(0);
          if (value === 'yes') action.onYes();
          else                 action.onNo();
        } else {
          inputRef.current = value;
          void submit();
        }
      };
      if (key.leftArrow || key.upArrow)   { setConfirmSelected(0); return; }
      if (key.rightArrow || key.downArrow) { setConfirmSelected(1); return; }
      if (key.return) {
        resolve(CONFIRM_OPTIONS[confirmSelected]!.value as 'yes' | 'no');
        return;
      }
      if (inputChar === 'y' || inputChar === 'Y') resolve('yes');
      else if (inputChar === 'n' || inputChar === 'N') resolve('no');
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

    // /pet play arrow cycling — up/down navigate the games picker. ONLY swallow
    // up/down here; every other key (Enter, character input, backspace, Esc)
    // must fall through so the launch-on-Enter handler at key.return can fire
    // and so the user can still edit the input.
    if ((inputRef.current === '/pet play' || inputRef.current.startsWith('/pet play '))
        && (key.upArrow || key.downArrow)) {
      const total = Object.keys(GAMES).length;
      if (total > 0) {
        if (key.upArrow) setPetPlayIdx(i => (i - 1 + total) % total);
        else             setPetPlayIdx(i => (i + 1) % total);
      }
      return;
    }

    // /pet feed arrow cycling — mirror of /pet play. Up/down navigate the foods
    // picker; Enter falls through to submit() to actually purchase the food.
    if ((inputRef.current === '/pet feed' || inputRef.current.startsWith('/pet feed '))
        && (key.upArrow || key.downArrow)) {
      const total = Object.keys(FOODS).length;
      if (total > 0) {
        if (key.upArrow) setPetFeedIdx(i => (i - 1 + total) % total);
        else             setPetFeedIdx(i => (i + 1) % total);
      }
      return;
    }

    // History-scrub continuation — once we're actively scrubbing (idx !== -1),
    // up/down stay bound to history even if the recalled prompt happens to be a
    // slash command that lights up the Suggestions list. Without this, pressing
    // UP twice with a "/pet feed" in history would surface the /pet suggestions
    // on the second press and we'd never reach the older history entries.
    if (promptHistoryIdxRef.current !== -1 && (key.upArrow || key.downArrow)) {
      const hist = promptHistoryRef.current;
      if (key.upArrow) {
        const idx = Math.max(0, promptHistoryIdxRef.current - 1);
        promptHistoryIdxRef.current = idx;
        inputRef.current = hist[idx]!;
        setInput(hist[idx]!);
        return;
      }
      // downArrow
      const next = promptHistoryIdxRef.current + 1;
      if (next >= hist.length) {
        promptHistoryIdxRef.current = -1;
        inputRef.current = '';
        setInput('');
      } else {
        promptHistoryIdxRef.current = next;
        inputRef.current = hist[next]!;
        setInput(hist[next]!);
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

    // Prompt history scrub — up/down through previously submitted prompts when no
    // other modal (suggestions, /model picker, confirm) has claimed the arrow keys.
    // Up cycles toward older entries; down cycles toward newer; falling off the
    // newest end clears the input (matches shell behavior).
    if (key.upArrow) {
      const hist = promptHistoryRef.current;
      if (hist.length === 0) return;
      const cur = promptHistoryIdxRef.current;
      const idx = cur === -1 ? hist.length - 1 : Math.max(0, cur - 1);
      promptHistoryIdxRef.current = idx;
      inputRef.current = hist[idx]!;
      setInput(hist[idx]!);
      return;
    }
    if (key.downArrow) {
      const hist = promptHistoryRef.current;
      const cur = promptHistoryIdxRef.current;
      if (cur === -1) return;
      const next = cur + 1;
      if (next >= hist.length) {
        promptHistoryIdxRef.current = -1;
        inputRef.current = '';
        setInput('');
      } else {
        promptHistoryIdxRef.current = next;
        inputRef.current = hist[next]!;
        setInput(hist[next]!);
      }
      return;
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
      promptHistoryIdxRef.current = -1;
    } else if (inputChar && !key.ctrl && !key.meta) {
      // Drop characters arriving within a brief window after an ESC keypress — almost
      // always the orphan tail of an Option+<letter> sequence Ink split in two.
      if (Date.now() - lastEscapeAtRef.current < 50) return;
      // Ink's keypress parser strips the leading ESC from SGR mouse sequences but lets
      // the rest of the CSI through as printable text — e.g. a left-click leaks `[<0;8;40M`
      // into the input buffer. Strip any residual CSI-style escape sequence (numbers,
      // semicolons, `<`/`>`, then a letter or `~`) so nothing weird ever lands in input.
      const cleaned = inputChar.replace(/\[[\d;<>?]*[A-Za-z~]/g, '');
      if (!cleaned) return;
      const next = inputRef.current + cleaned;
      inputRef.current = next;
      setInput(next);
      setSuggestionIndex(-1);
      promptHistoryIdxRef.current = -1;
    }
  });

  // Active mini-game takes over the full screen — replaces welcome + conversation
  // views entirely. The game owns its own mouse/keyboard handling and signals exit
  // via onExit, which credits any happiness it earned through the standard play()
  // path so the existing decay/cap rules apply uniformly.
  if (activeGame && GAMES[activeGame]) {
    const GameComponent = GAMES[activeGame].component;
    const onGameExit = (result?: import('./games/types').GameResult) => {
      // Happiness → play() taps (canonical mutation; preserves the decay
      // semantics in pet.ts). Coins delta is applied directly via addCoins,
      // which clamps at zero so a punishing exam can't go negative.
      const taps = Math.max(0, Math.floor((result?.happiness ?? 0) / 2));
      let next = petRef.current;
      for (let i = 0; i < taps; i++) next = play(next);
      if (result?.coins) next = addCoins(next, result.coins);
      petRef.current = next;
      setPet(next);
      savePet(next);
      setActiveGame(null);
    };
    return <GameComponent pet={pet} onExit={onGameExit} />;
  }

  // /usage tabbed panel — fullscreen takeover. Same pattern as the mini-game
  // above: while open, the panel owns the screen and input. Closing (Esc
  // inside the panel) flips usageGraphKey back to null.
  if (usageGraphKey) {
    return (
      <UsagePanel
        adminKey={usageGraphKey}
        model={MODELS[modelIdx]!}
        mode={mode}
        paneMode={paneMode}
        terminalMode={terminalMode}
        usageState={usageStateRef.current}
        onExit={() => setUsageGraphKey(null)}
      />
    );
  }

  // Welcome screen
  if (messages.length === 0 && dbtLogs.length === 0) {
    return (
      <Box ref={containerRef} flexDirection="column" paddingTop={1}>
        <Box flexDirection="column" paddingX={2}>
          {WORDMARK.map((line, i) => (
            <WordmarkLine key={i} line={line} color="#B9FECF" />
          ))}
          <Box marginTop={1} flexDirection="column">
            <Box gap={1}>
              <Text bold color="#C0FAD2">bk1</Text>
              <Text color="#5A8060">v0.1.0</Text>
            </Box>
            <Text color="#5A8060"><Text color="#C0FAD2">{MODELS[modelIdx]!.label}</Text> · dbt Coding Agent by Mangrove Digital</Text>
            <Text color="#5A8060">{PROJECT_DIR}</Text>
          </Box>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {isModelPicker
            ? <ModelPicker currentIdx={modelIdx} />
            : isPetPlayPicker
              ? <GamePicker currentIdx={petPlayIdx} />
              : isPetFeedPicker
                ? <FoodPicker currentIdx={petFeedIdx} balance={pet.coins} />
                : <Suggestions suggestions={suggestions} selectedIndex={suggestionIndex} input={input} />
          }
          <HRule />
          <IdeContextBar ctx={ideCtx} />
          <InputBar input={input} isRunning={isRunning} mode={mode} modelLabel={MODELS[modelIdx]!.label} maskInput={awaitingAdminKey} terminalMode={terminalMode} />
          <HRule />
          <StatusFooter sessionUsd={sessionUsd} pet={pet} renderHeight={renderHeight} coinToast={coinToast} />
          <HRule />
          <HintBar isRunning={isRunning} paneMode={paneMode} terminalMode={terminalMode} />
        </Box>
      </Box>
    );
  }

  // Conversation view
  return (
    <Box ref={containerRef} flexDirection="column">
      {/* WORDMARK + intro block — pinned at the very top of scrollback via its own
          single-item <Static>. Rendered exactly once when the conversation view
          mounts so it never gets repainted on subsequent turns (and so it sits
          above the messages Static below, instead of inside the dynamic frame
          where it would otherwise appear *between* messages and the footer).
          Note: the model label captured here is the one current when this block
          first rendered; if the user later /model-switches, the live label is
          still visible in the InputBar. */}
      <Static items={HEADER_ITEMS}>
        {() => (
          <Box key="header" flexDirection="column" paddingX={2} paddingTop={1} paddingBottom={0}>
            {WORDMARK.map((line, i) => (
              <WordmarkLine key={i} line={line} color="#B9FECF" />
            ))}
            <Box marginTop={1} flexDirection="column">
              <Box gap={1}>
                <Text bold color="#C0FAD2">bk1</Text>
                <Text color="#5A8060">v0.1.0</Text>
              </Box>
              <Text color="#5A8060"><Text color="#C0FAD2">{MODELS[modelIdx]!.label}</Text> · dbt Coding Agent by Mangrove Digital</Text>
              <Text color="#5A8060">{PROJECT_DIR}</Text>
            </Box>
          </Box>
        )}
      </Static>

      {/* Past messages render through <Static>: each one is written to stdout exactly
          once when it appears in the items array and never touched by subsequent Ink
          renders. That's what makes drag-selection on assistant output actually stick —
          without this, the snore animation / input-bar redraws were repainting the
          message lines and wiping out the terminal's selection highlight. Padding has
          to be set per-item because <Static> children don't inherit parent box props. */}
      <Static items={messages}>
        {(msg, i) => (
          <Box key={i} flexDirection="column" marginBottom={1} paddingX={2} marginTop={i === 0 ? 1 : 0}>
            {msg.role === 'user' ? (() => {
              // Right-aligned bordered bubble so the user can visually distinguish
              // their own prompts from the agent's left-aligned plain output.
              const cols = process.stdout.columns ?? 80;
              const longest = Math.max(...msg.content.split('\n').map(l => l.length));
              const maxInner = Math.max(20, Math.floor(cols * 0.6));
              const innerW = Math.min(maxInner, longest);
              return (
                <Box justifyContent="flex-end">
                  <Box borderStyle="round" borderColor="#6B5E8C" paddingX={1} width={innerW + 4}>
                    <Text backgroundColor="#2E2940" color="#D8CFEF" wrap="wrap">{msg.content}</Text>
                  </Box>
                </Box>
              );
            })() : (
              <>
                <RichMessage text={msg.content} />
                {msg.tokens && <TokenBadge tokens={msg.tokens} />}
              </>
            )}
          </Box>
        )}
      </Static>

      {/* Live running indicator (left) + dbt log pane (right). Wrapped in a row
          so the pane sits alongside the live indicator in the dynamic frame.
          Input/footer/hint stay full-width below as siblings of this row. */}
      <Box flexDirection="row">
        <Box flexDirection="column" paddingX={2} flexGrow={1}>
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
          {liveShellCmd && (
            <Box flexDirection="column" marginBottom={1}>
              <Box gap={1}>
                <Text color="#7DD3FC">$</Text>
                <Text color="#BAE6FD" bold>{liveShellCmd}</Text>
                <Text color="#5A8060"><Spinner type="sand" /></Text>
                <Text color="#3D6650">Esc to abort</Text>
              </Box>
              {liveShellText && (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text wrap="wrap" color="#7AB890">
                    {liveShellText.trimEnd().split('\n').slice(-12).join('\n')}
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
        {(dbtLogs.length > 0 || dbtRunning) && (() => {
          const cols = process.stdout.columns ?? 80;
          const paneWidth  = Math.max(44, Math.min(88, Math.floor(cols * 0.55)));
          // Reserve room for input, footer, hints so the pane never pushes the
          // prompt off-screen on short terminals.
          const paneHeight = Math.max(6, Math.floor(terminalRows / 2));
          // Pane bounds for the raw mouse handler. Computed from `terminalRows`
          // assuming the dynamic frame is bottom-anchored (true once there's
          // any scrollback). CHROME = the rows BELOW the pane's bottom border:
          //   HRule(1) + InputBar(1) + StatusFooter(5) + HRule(1) + HintBar(2)
          // = 10. Earlier this was 9 because StatusFooter was miscounted as 4
          // rows (marginTop+content); the actual content is the full 4-row
          // sprite (3 body + 1 legs from withLegs) PLUS marginTop = 5. That
          // 1-row drift was why [copy] required a click one row below the
          // visible button.
          const CHROME   = 10;
          const right    = cols - 2;
          const left     = right - paneWidth + 1;
          // -1 for pane's bottom border row, -1 for the horizontal scrollbar
          // row that now sits just above the bottom border.
          const bottom   = terminalRows - CHROME - 2;
          const top      = bottom - paneHeight;             // header + log rows
          const copyText = '[copy]';
          const copyRow  = top;                            // header row sits at pane's top interior row
          const copyRight = right - 3;                     // -1 border, -2 for the 2-col scrollbar
          const copyLeft  = copyRight - copyText.length + 1;
          // Scrollbar column sits just inside the right border. Now 2 cols
          // wide; `scrollCol` is the LEFT edge of the bar and click checks
          // accept both `scrollCol` and `scrollCol + 1`. Track cells span
          // rows top+1 (one below the header) to top+paneHeight.
          const scrollCol   = right - 2;
          const trackTop    = top + 1;
          const trackBottom = top + paneHeight;
          // Horizontal scrollbar row: sits one row below the last log row
          // (between the log area and the pane's bottom border). Spans the
          // full width inside the borders (left+1 to right-1).
          const hbarRow   = bottom + 1;
          const hbarLeft  = left + 1;
          const hbarRight = right - 1;
          dbtPaneBoundsRef.current = {
            top, bottom, left, right,
            copyLeft, copyRight, copyRow,
            scrollCol, trackTop, trackBottom,
            hbarRow, hbarLeft, hbarRight,
          };
          return (
            <Box paddingRight={2}>
              <DbtLogPane
                logs={dbtLogs}
                running={dbtRunning}
                width={paneWidth}
                height={paneHeight}
                scrollV={dbtScrollV}
                scrollH={dbtScrollH}
                copyFlash={copyFlash}
                paneMode={paneMode}
                searchQuery={dbtSearchQuery}
              />
            </Box>
          );
        })()}
      </Box>

      {!confirmPrompt && (isModelPicker
        ? <ModelPicker currentIdx={modelIdx} />
        : isPetPlayPicker
          ? <GamePicker currentIdx={petPlayIdx} />
          : isPetFeedPicker
            ? <FoodPicker currentIdx={petFeedIdx} balance={pet.coins} />
            : <Suggestions suggestions={suggestions} selectedIndex={suggestionIndex} input={input} />
      )}
      <HRule />
      {!confirmPrompt && <IdeContextBar ctx={ideCtx} />}
      {confirmPrompt
        ? <ConfirmBar question={confirmPrompt} selectedIdx={confirmSelected} />
        : <InputBar input={input} isRunning={isRunning} mode={mode} modelLabel={MODELS[modelIdx]!.label} maskInput={awaitingAdminKey} terminalMode={terminalMode} />
      }
      {/* Eye-tracking anchor: `terminalRows - 5`. Once a conversation has enough
          Static scrollback to push the dynamic frame down, the cursor lands at the
          terminal bottom and this is exact. For short conversations on tall terminals
          it can be a bit off (eye is higher than the anchor), but that's the
          least-bad option given we can't measure absolute position with Static
          content present. terminalRows itself follows window resizes via the
          stdout.on('resize') listener at the top of App. */}
      <StatusFooter sessionUsd={sessionUsd} pet={pet} renderHeight={terminalRows} coinToast={coinToast} />
      <HRule />
      <HintBar isRunning={isRunning} paneMode={paneMode} terminalMode={terminalMode} />
    </Box>
  );
}

render(<AppShell />);
