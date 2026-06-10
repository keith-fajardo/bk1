import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, statSync, openSync, readSync, closeSync, watch } from 'fs';
import { homedir } from 'os';
import { spawnSync } from 'node:child_process';
import { render, Box, Text, Static, useInput, measureElement, type DOMElement } from 'ink';
import Spinner from 'ink-spinner';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent, AgentAbortedError, resetAnthropicClient, rebuildSystemPrompt, summarizePrompt, type TokenUsage } from './agent';
import { getProjectDir, setProjectDir, isDbtProject, checkProjectAccess } from './project-dir';
import { lintReportPath, resetDb } from './state';
import { getRecentProjects, recordRecentProject } from './recent-projects';
import { bk1AssetsDir, BK1_HOME } from './bk1-home';
import { BK1_VERSION } from './version';
import { createSession, saveSessionMessages, loadSessionMessages, searchSessions, formatSessionLine, type SessionSearchHit, type StoredMessage } from './sessions';
import { readIdeContextBlock, readIdeContextRaw, type IdeContext } from './ide-context';
import { SKILLS, expandSkill } from './skills';
import { getStoredKey, storeKey, clearStoredKey, isValidKeyShape, authFilePath, getStoredAdminKey, storeAdminKey } from './auth';
import { estimateCostUsd, formatUsd } from './pricing';
import { recordProjectUsage, loadProjectTotals, recordTurnCost, updateTurnSummary, loadTurnHistory, type ProjectTotals, type TurnHistoryRow } from './project-usage';
import { createUsageState, recordUsage, buildReport, renderReport, classifyTurnLabel, getOrgUsage, getOrgUsageSeries, peekOrgUsageText, peekOrgUsageSeries, orgUsageFetchedAt, requestRefresh, type UsageState } from './usage';
import {
  loadPet, savePet, newPet, tickPet, petFace, petFaceEating,
  petSprite, petSpriteBlink, petSpriteSleep, petSpriteEating,
  petSpriteLookLeft, petSpriteLookRight, petSpriteLookUp, petSpriteLookDown,
  petSpriteLookUL, petSpriteLookUR, petSpriteLookDL, petSpriteLookDR,
  renderPetView, isSleeping, isEating,
  feed, play, petSleep, wakePet, rename, autoFeedFromActivity,
  FOODS, addCoins, addXp, levelInfo, petColorHex, PET_COLOR_NAMES, DEFAULT_PET_COLOR,
  type PetState,
} from './pet';
import { disableMouseTracking, parseMouseEvents, enableModifyOtherKeys, disableModifyOtherKeys, enableKittyKeyboard, disableKittyKeyboard, isNewlineKey, normalizeKittyKeys } from './mouse';
import { GAMES } from './games';

// Multiplayer games live inside the playroom modal (not in GAMES), but should
// still appear in the /pet play picker so users can discover them. Picking
// one opens the playroom in create mode; the actual game is launched from
// within the lobby via a key shortcut (j jakenpoy, r race, p long jump,
// s shot put, a artillery).
const MULTIPLAYER_GAMES = [
  { id: 'jakenpoy',  description: 'Filipino rock-paper-scissors — opens playroom' },
  { id: 'race',      description: 'Steeplechase — 3000m mash sprint with hurdles — opens playroom' },
  { id: 'longjump',  description: 'Long jump — mash to sprint, space to jump — opens playroom' },
  { id: 'shotput',   description: 'Shot put — aim angle, charge power, time the release — opens playroom' },
  { id: 'artillery', description: 'Turn-based artillery duel — opens playroom' },
] as const;
const MULTIPLAYER_GAME_IDS = new Set<string>(MULTIPLAYER_GAMES.map(g => g.id));
import { registerCoinEventHandler, emitCoinEvent, COIN_REWARDS, type CoinEvent } from './coin-events';
import { PlayroomLobby, type LobbyMode } from './playroom/room';
import { PetSpriteLine, PET_SPRITE_SENTINEL } from './playroom/pet-sprite-line';

// ---------------------------------------------------------------------------
// Chat event stream — written to ~/.bk1/chat-events.jsonl so the VS Code
// extension's webview panel can render a live conversation view.
// ---------------------------------------------------------------------------
const CHAT_EVENTS_FILE = `${BK1_HOME}/chat-events.jsonl`;

function emitChatEvent(event: Record<string, unknown>): void {
  try { appendFileSync(CHAT_EVENTS_FILE, JSON.stringify(event) + '\n'); } catch {}
}

// Tool inputs/results and thinking blocks can be large (whole-file reads,
// write_file bodies, lint dumps). Cap what we push to the webview channel — the
// full output stays in the engine; the chat view shows a preview it can expand.
const CHAT_IO_MAX = 2000;
function truncateForChat(s: string): string {
  return s.length > CHAT_IO_MAX ? `${s.slice(0, CHAT_IO_MAX)}\n… (+${s.length - CHAT_IO_MAX} more chars)` : s;
}
// One-line summary for the step header (mirrors what the tool acts on).
function describeToolInput(input: Record<string, unknown>): string {
  for (const k of ['path', 'command', 'query', 'model_name', 'name', 'action', 'select']) {
    const v = input[k];
    if (typeof v === 'string' && v) return v.length > 140 ? `${v.slice(0, 140)}…` : v;
  }
  const keys = Object.keys(input);
  return keys.length ? keys.join(', ') : '';
}
function formatToolInput(input: Record<string, unknown>): string {
  try { return truncateForChat(JSON.stringify(input, null, 2)); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Prompt input stream — the VS Code extension APPENDS one JSON line per prompt
// to ~/.bk1/prompt-input.jsonl; bk1 watches the dir and feeds each into submit().
// This is the inbound mirror of chat-events.jsonl, deliberately replacing the
// old terminal.sendText keystroke injection (which silently dropped prompts the
// moment the hosting terminal's process had exited). The extension owns the
// file (append-only); bk1 only ever reads + advances its own offset.
// ---------------------------------------------------------------------------
const PROMPT_INPUT_FILE = `${BK1_HOME}/prompt-input.jsonl`;
// On a fresh mount, ignore prompt lines older than this — a relaunch must pick
// up the prompt that triggered it (written ~ms earlier) but not replay stale
// lines left by a prior session that exited without consuming them.
const PROMPT_INPUT_FRESH_MS = 10_000;

interface PromptInputPayload {
  text?: string;
  model?: string;
  thinking?: boolean;
  ts?: number;
}

const MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-7',           label: 'Opus 4.7' },
  { id: 'claude-opus-4-8',           label: 'Opus 4.8' },
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
interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; }
interface Message { role: 'user' | 'assistant'; content: string; tools?: ToolEvent[]; tokens?: TokenTotals; info?: boolean; }

const CMD_COL_WIDTH = 16;

function HRule() {
  // columns - 4 for the paddingX={2}, minus 1 more so the rule never reaches the full
  // terminal width. A full-width rule wraps to a second physical row the instant the
  // window shrinks (the old rule is still painted at the old width), and that wrapped
  // row is what gets stranded as an orphan on resize. Leaving a 1-col margin guarantees
  // the rule stays a single physical row at any width.
  const cols = Math.max(0, (process.stdout.columns ?? 80) - 5);
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
  'claude-opus-4-7':           'Highly capable · previous flagship',
  'claude-opus-4-8':           'Most capable · best for complex analysis',
};

// Fullscreen-takeover picker for past conversations. Owns its own search input
// state and useInput hook because the search query is interactive (debounced
// FTS hit on each keystroke). Emits onSelect with a session id on Enter, or
// onCancel on Esc — App is responsible for hydrating the messages array from
// the chosen session.
function SessionPicker({ projectPath, onSelect, onCancel }: {
  projectPath: string;
  onSelect: (sessionId: number) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionSearchHit[]>(() => searchSessions(projectPath, ''));
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Debounce the search so FTS doesn't re-run on every keystroke (negligible
  // for small DBs but the right shape for when history grows).
  useEffect(() => {
    const t = setTimeout(() => {
      setResults(searchSessions(projectPath, query));
      setSelectedIdx(0);
    }, 80);
    return () => clearTimeout(t);
  }, [query, projectPath]);

  useInput((inputChar, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) {
      const hit = results[selectedIdx];
      if (hit) onSelect(hit.id);
      return;
    }
    if (key.upArrow)   { setSelectedIdx(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIdx(i => Math.min(results.length - 1, i + 1)); return; }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1));
      return;
    }
    if (inputChar && !key.ctrl && !key.meta) {
      const cleaned = inputChar.replace(/\[[\d;<>?]*[A-Za-z~]/g, '');
      if (cleaned) setQuery(q => q + cleaned);
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="#C0FAD2">Conversation history</Text>
        <Text color="#5A8060">  ·  {results.length} match{results.length === 1 ? '' : 'es'}</Text>
      </Box>
      <Box>
        <Text color="#9DD9BA">filter ▸ </Text>
        <Text color="#D8CFEF">{query}</Text>
        <Text color="#9DD9BA">█</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {results.length === 0 ? (
          <Text color="#5A8060">{query ? `No sessions match "${query}"` : 'No saved sessions yet — they start saving once you exchange messages.'}</Text>
        ) : (
          results.slice(0, 20).map((s, i) => {
            const active = i === selectedIdx;
            const line = formatSessionLine(s);
            return (
              <Box key={s.id} flexDirection="column">
                <Box>
                  <Text color={active ? '#C0FAD2' : '#7AB890'} bold={active}>{active ? '▸ ' : '  '}</Text>
                  <Text color={active ? '#C0FAD2' : '#7AB890'}>{line}</Text>
                </Box>
                {s.snippet && (
                  <Box paddingLeft={4}>
                    <Text color="#5A8060">in: {s.snippet}</Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text color="#5A8060">↑↓ navigate · Enter open · Esc cancel · type to filter</Text>
      </Box>
    </Box>
  );
}

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

// /project switcher. Lists recently-used dbt projects (arrow-select) and lets
// the user type/paste a path after "/project " to switch somewhere new. The
// current project is marked. `typed` is the text after the command, if any —
// when non-empty it takes precedence over the arrow selection on Enter.
function ProjectPicker({ recents, currentIdx, typed, current }: {
  recents: string[]; currentIdx: number; typed: string; current: string;
}) {
  return (
    <Box flexDirection="column" marginBottom={0}>
      {recents.length === 0 ? (
        <Box paddingX={2}><Text color="#5A8060">No recent projects — type a path: /project &lt;path&gt;</Text></Box>
      ) : recents.map((p, i) => {
        const active = i === currentIdx && !typed;
        const isCurrent = resolvePathEq(p, current);
        return (
          <Box key={p} paddingX={2} gap={1}>
            <Text color={active ? '#C0FAD2' : '#5A8060'} bold={active}>{active ? '●' : ' '}</Text>
            <Text color={active ? '#C0FAD2' : '#7AB890'}>{p}</Text>
            {isCurrent && <Text color="#3D6650">(current)</Text>}
          </Box>
        );
      })}
      <Box paddingX={2} marginTop={0}>
        <Text color="#5A8060">
          {typed ? `Enter to switch to: ${typed}` : '↑↓ navigate · Enter switch · or type a path after /project'}
        </Text>
      </Box>
    </Box>
  );
}

// Path-equality helper for marking the current project in the list (avoids a
// trailing-slash mismatch). Module-scope so ProjectPicker can use it.
function resolvePathEq(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '');
  return norm(a) === norm(b);
}

// The app hosting bk1, derived from $TERM_PROGRAM — this is the process macOS
// holds TCC decisions against, so it's the one the user must grant access. Used
// to name it in the Full Disk Access guidance instead of a vague "your terminal".
function hostTerminalName(): string {
  const tp = process.env.TERM_PROGRAM ?? '';
  return {
    Apple_Terminal: 'Terminal',
    'iTerm.app': 'iTerm',
    vscode: 'VS Code',
    WarpTerminal: 'Warp',
    WezTerm: 'WezTerm',
    ghostty: 'Ghostty',
    Hyper: 'Hyper',
    Tabby: 'Tabby',
  }[tp] ?? (tp || 'your terminal app');
}

// Deep-link straight to System Settings → Privacy & Security → Full Disk Access.
// macOS won't re-prompt a terminal once it's been denied, so the toggle is the
// only way back — this lands the user on the exact pane. Mirrors the spawnSync
// `code` launch used to open files in VS Code.
function openFullDiskAccessSettings(): void {
  spawnSync('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { stdio: 'ignore' });
}

// Playroom picker — shown when input starts with "/pet playroom". Mirrors the
// GamePicker shape so the input model is consistent across /pet * subcommands.
// Selected entry is dispatched on Enter via the /pet playroom submit branch.
const PLAYROOM_ACTIONS = [
  { id: 'create' as const, description: 'Create a new room — generates a pin you share with a friend' },
  { id: 'join'   as const, description: 'Join an existing room — paste the pin your friend sent you' },
] as const;
type PlayroomActionId = (typeof PLAYROOM_ACTIONS)[number]['id'];

function PlayroomPicker({ currentIdx }: { currentIdx: number }) {
  const labelWidth = Math.max(
    CMD_COL_WIDTH,
    ...PLAYROOM_ACTIONS.map(a => `/pet playroom ${a.id}`.length + 2),
  );
  return (
    <Box flexDirection="column" marginBottom={0}>
      {PLAYROOM_ACTIONS.map((a, i) => {
        const active = i === currentIdx;
        return (
          <Box key={a.id} paddingX={2} gap={1}>
            <Box width={labelWidth} flexShrink={0}>
              <Text color={active ? '#C0FAD2' : '#5A8060'} bold={active}>/pet playroom {a.id}</Text>
              <Text color="#B9FECF">{active ? ' ●' : '  '}</Text>
            </Box>
            <Text color={active ? '#7AB890' : '#3D6650'}>{a.description}</Text>
          </Box>
        );
      })}
      <Box paddingX={2} marginTop={0}>
        <Text color="#5A8060">↑↓ navigate · Enter open · Esc cancel</Text>
      </Box>
    </Box>
  );
}

// Mini-game picker — shown when input starts with "/pet play". Same shape as
// ModelPicker so the UX is consistent with /model. The selected entry is
// launched on Enter via the /pet play submit branch.
function GamePicker({ currentIdx }: { currentIdx: number }) {
  // Combined list: single-player games (from GAMES) followed by multiplayer
  // games. Single index space so the existing currentIdx cycle just works.
  const single = Object.values(GAMES).map(g => ({ id: g.id, description: g.description, multiplayer: false }));
  const multi = MULTIPLAYER_GAMES.map(g => ({ id: g.id, description: g.description, multiplayer: true }));
  const entries = [...single, ...multi];
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
            {g.multiplayer && (
              <Text color={active ? '#7AB890' : '#3D6650'}>2P</Text>
            )}
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
            <Text color={affordable ? '#FCD34D' : '#7A4747'}>💰  {f.cost}</Text>
            <Text color={active ? '#7AB890' : '#3D6650'}>{f.description}</Text>
          </Box>
        );
      })}
      <Box paddingX={2} marginTop={0}>
        <Text color="#5A8060">↑↓ navigate · Enter buy · Esc cancel · balance 💰  {balance}</Text>
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
  const rel = ctx.file_path.startsWith(getProjectDir() + '/')
    ? ctx.file_path.slice(getProjectDir().length + 1)
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

function HintBar({ isRunning, terminalMode }: { isRunning: boolean; terminalMode: boolean }) {
  return (
    <Box paddingX={2} paddingBottom={1}>
      {isRunning
        ? <Text color="#3D6650">t  toggle output   Esc  stop agent   Ctrl+C  exit</Text>
        : terminalMode
          ? <Text color="#7DD3FC">TERMINAL MODE — input runs as shell   ? prefix  ask agent   Ctrl+T  back to prompt   Ctrl+C exit</Text>
          : <Text color="#B9FECF">PROMPT MODE — input sent to agent   ! prefix  run shell   Opt+Enter  newline   Tab switch mode   /term  terminal mode   /clear  redraw   Ctrl+C exit</Text>
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
      {tokens.costUsd > 0 && (
        <><Text color={col}>·</Text><Text color={valCol}>{formatUsd(tokens.costUsd)}</Text></>
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

function InputBar({ input, cursorPos, isRunning, mode, modelLabel, maskInput, terminalMode, collapsed }: {
  input: string; cursorPos: number; isRunning: boolean; mode: Mode; modelLabel: string; maskInput?: boolean; terminalMode?: boolean;
  // While the window is actively resizing the caller passes collapsed so we
  // render a single borderless row — a multi-row bordered box would wrap-desync
  // mid-resize and strand orphan rows (see the resize-safety note below).
  collapsed?: boolean;
}) {
  const theme = MODE_THEME[mode];
  const termAccent = '#7DD3FC';
  // Typing `!` at the start of the input is the inline shell-escape — that
  // line will run as a bash command on submit, even outside terminal mode.
  // Surface that with the same cyan styling the persistent terminal mode
  // uses so users get visual confirmation BEFORE hitting Enter (e.g.
  // typing `! ls -lrt` flips the badge to TERM, prompt char to $, accent
  // to cyan). Submit clears the input and styling reverts on next render.
  const isBangShell = !isRunning && !maskInput && input.startsWith('!');
  const effectiveTerm = terminalMode || isBangShell;
  const accent = isRunning ? '#5A8060' : (effectiveTerm ? termAccent : theme.accent);
  const text   = isRunning ? '#5A8060' : (effectiveTerm ? termAccent : theme.text);
  const badgeColor = effectiveTerm ? termAccent : theme.badge;
  const badgeLabel = effectiveTerm ? 'TERM' : theme.label;
  const promptChar = effectiveTerm ? '$' : '>';
  const display = maskInput ? '*'.repeat(input.length) : input;
  // Cursor is a static block — no blink. Blinking would fire setState on an
  // interval, forcing Ink to repaint the dynamic frame and wiping any
  // in-progress terminal selection. Static cursor = no repaint pressure.
  //
  // The block is INSERTED into the string at cursorPos (left of the char you're
  // on), so it works mid-text — and crucially keeps each rendered row a single
  // string, preserving the border-render fix (multi-Text rows overflow the
  // border). split('\n') after insertion puts the block on the correct line.
  const c = Math.max(0, Math.min(cursorPos, display.length));
  const displayWithCursor = display.slice(0, c) + '█' + display.slice(c);

  // Claude-Code-style bordered prompt box. The input text (single- or
  // multi-line) lives inside a rounded border; the badge + model sit on a
  // status line below it (the key hints stay in the HintBar). The border color
  // follows the mode/state accent so it reinforces PROMPT vs TERM vs running.
  //
  // RESIZE SAFETY: the box width is capped to `columns - 5` (the same margin
  // HRule uses) so the border NEVER reaches full terminal width. A full-width
  // border wraps to an extra physical row on shrink while Ink counts it as one
  // logical line, stranding an orphan row — the exact resize-ghosting failure
  // mode this codebase fights. The caller already collapses to a borderless
  // frame while actively resizing (see the `resizing` branch in App), so this
  // multi-row box is only mounted once the window has settled.
  const lines = displayWithCursor.split('\n');
  const last = lines.length - 1;

  // Collapsed (resizing) form: a single borderless row. We show the first line
  // plus an ellipsis if multi-line, so the live frame stays exactly one row and
  // can't wrap or ghost while the terminal reflows. The cursor block is already
  // embedded in `lines` via displayWithCursor.
  if (collapsed) {
    const oneLine = lines.length > 1 ? `${lines[0]} …` : lines[0];
    return (
      <Box gap={1}>
        <Text color={badgeColor} bold>{badgeLabel}</Text>
        <Text color={accent}>{promptChar}</Text>
        <Text color={text}>{oneLine}</Text>
      </Box>
    );
  }

  const cols = process.stdout.columns ?? 80;
  // InputBar owns its own paddingX={2} (like the old inline form) so it aligns
  // under the HRules at every call site — the welcome view doesn't wrap it in a
  // padded container. The box width subtracts that 4-col padding plus a 1-col
  // safety margin so the border can't touch the edge and wrap on resize.
  const boxWidth = Math.max(20, cols - 4 - 1);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box width={boxWidth} borderStyle="round" borderColor={accent} paddingX={1} flexDirection="column">
        {lines.map((line, i) => {
          // One bare Text per row — the same structure as the user-message
          // bubble, which renders reliably inside a fixed-width border. The
          // prompt char ("> ") prefixes line 0; continuation rows get a matching
          // two-space indent so they align under the first line. The cursor
          // block is appended to the last row's string. `|| ' '` keeps an empty
          // row from collapsing (which would drop the cursor's line). Building a
          // single string per row — NOT multiple Text children in a per-row Box
          // — is what keeps content inside the border; the multi-child row Box
          // overflowed the frame and stranded the text and right edge.
          const prefix = i === 0 ? `${promptChar} ` : '  ';
          // The cursor block is already embedded in `line` (displayWithCursor).
          const body = prefix + line;
          return <Text key={i} color={text} wrap="wrap">{body || ' '}</Text>;
        })}
      </Box>
      <Box paddingX={1}>
        <Text color={badgeColor} bold>{badgeLabel}</Text>
        <Text color="#3D6650">   {modelLabel}</Text>
      </Box>
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
  const bodyColor = petColorHex(pet);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column">
        {sprite.map((line, i) => <PetSpriteLine key={i} line={line} bodyColor={bodyColor} />)}
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
          {(() => { const l = levelInfo(pet.xp); return <Text color="#A78BFA">⭐ Lv{l.level} {l.into}/{l.span}</Text>; })()}
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

// Default foreground for the agent's response body. Without an explicit color
// Ink falls through to the terminal's default white, which reads as stark/bright
// on a dark theme. A muted light-grey (à la Claude Code) is softer on the eyes
// while staying clearly readable. Headings/inline emphasis keep their own colors.
const BODY_FG = '#C5CDD3';

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
    <Text wrap="wrap" color={BODY_FG}>
      {spans.map((s, i) =>
        s.color || s.bold || s.italic
          ? <Text key={i} color={s.color} bold={!!s.bold} italic={!!s.italic}>{s.text}</Text>
          : <Text key={i} color={BODY_FG}>{s.text}</Text>
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
  adminKey, model, mode, terminalMode, usageState, onExit,
}: {
  adminKey: string;
  model: { id: string; label: string };
  mode: Mode;
  terminalMode: boolean;
  usageState: UsageState;
  onExit: () => void;
}) {
  const [tab, setTab] = useState<UsagePanelTab>('status');
  // Stats-tab state lives on the panel (not inside StatsTab) so the user's
  // granularity / metric choices survive flipping to another tab and back.
  const [granularity, setGranularity] = useState<import('./usage').UsageGranularity>('daily');
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  // Bumped by 'r' to force the active data tab to re-pull; refreshNotice carries
  // the local rate-limiter's rejection so the user sees why nothing happened.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const refreshable = tab === 'usage' || tab === 'stats';
  // Tracks whether the ProjectsTab prompts overlay is open (and at which level)
  // so this panel's own useInput can yield control to the overlay.
  const [promptsView, setPromptsView] = useState<null | 'list' | 'detail'>(null);

  useInput((inputChar, key) => {
    if (key.escape) { onExit(); return; }
    if (key.tab && key.shift) {
      setRefreshNotice(null);
      setTab(t => USAGE_TAB_ORDER[(USAGE_TAB_ORDER.indexOf(t) - 1 + USAGE_TAB_ORDER.length) % USAGE_TAB_ORDER.length]!);
      return;
    }
    if (key.tab) {
      setRefreshNotice(null);
      setTab(t => USAGE_TAB_ORDER[(USAGE_TAB_ORDER.indexOf(t) + 1) % USAGE_TAB_ORDER.length]!);
      return;
    }
    if ((inputChar === 'r' || inputChar === 'R') && refreshable) {
      const gate = requestRefresh();
      if (gate.ok) { setRefreshNotice(null); setRefreshNonce(n => n + 1); }
      else setRefreshNotice(`Too many refreshes — wait ${gate.retryInSec}s and try again.`);
      return;
    }
    if (tab === 'stats') {
      if (inputChar === 't') setMetric('tokens');
      else if (inputChar === '$' || inputChar === 'c') setMetric('cost');
      else if (inputChar === 'm') setGranularity('monthly');
      else if (inputChar === 'd') setGranularity('daily');
      else if (inputChar === 'h') setGranularity('hourly');
    }
  }, { isActive: promptsView === null });

  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <UsagePanelTabsHeader active={tab} />
      <Box marginTop={1} flexDirection="column">
        {tab === 'status'  && <StatusTab model={model} mode={mode} terminalMode={terminalMode} adminKey={adminKey} />}
        {tab === 'usage'   && <UsageTab adminKey={adminKey} refreshNonce={refreshNonce} />}
        {tab === 'stats'    && <StatsTab adminKey={adminKey} granularity={granularity} metric={metric} refreshNonce={refreshNonce} />}
        {tab === 'projects' && <ProjectsTab onViewChange={setPromptsView} />}
        {tab === 'session'  && <SessionTab usageState={usageState} />}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="#3D6650">
          {promptsView === 'detail'
            ? 'Esc back to list'
            : promptsView === 'list'
              ? '↑↓ navigate · Enter open · Esc back'
              : `Tab next · Shift+Tab prev · Esc close${refreshable ? ' · r refresh' : ''}${tab === 'stats' ? ' · m/d/h granularity · t/$ metric' : ''}${tab === 'projects' ? ' · p recent prompts' : ''}`}
        </Text>
        {refreshNotice && <Text color="#E0A060">{refreshNotice}</Text>}
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
  model, mode, terminalMode, adminKey,
}: {
  model: { id: string; label: string };
  mode: Mode;
  terminalMode: boolean;
  adminKey: string;
}) {
  // One-shot git branch lookup. Spawned synchronously via spawnSync (already
  // imported above) on mount. If git isn't available or the dir isn't a repo,
  // we fall back to "—" rather than surfacing an error here.
  const [branch, setBranch] = useState<string>('…');
  useEffect(() => {
    // Truncate chat events file so the VS Code webview panel starts fresh each session.
    try { writeFileSync(CHAT_EVENTS_FILE, ''); } catch {}
  }, []);

  useEffect(() => {
    try {
      const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: getProjectDir(), encoding: 'utf-8' });
      setBranch(res.status === 0 ? (res.stdout?.trim() || '—') : '—');
    } catch { setBranch('—'); }
  }, []);

  // Presence only — no fingerprint, no last-N chars. The admin key never
  // appears on screen so an over-the-shoulder reader / screenshot / screen
  // share can't recover any part of it.
  const keyHint = adminKey ? 'stored' : 'not stored';
  const lintBuilt = existsSync(`${bk1AssetsDir()}/bk1-lint`);
  const dbtProject = `${getProjectDir()}/dbt_project.yml`;
  const dbtPresent = existsSync(dbtProject);

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Version',       value: <Text color="#C0FAD2">bk1 v{BK1_VERSION}</Text> },
    { label: 'Project',       value: <Text color="#C0FAD2">{getProjectDir()}</Text> },
    { label: 'Branch',        value: <Text color="#C0FAD2">{branch}</Text> },
    { label: 'Model',         value: <Text color="#C0FAD2">{model.label}  <Text color="#5A8060">({model.id})</Text></Text> },
    { label: 'Mode',          value: <Text color="#C0FAD2">{mode}</Text> },
    { label: 'Admin API key', value: <Text color={adminKey ? '#C0FAD2' : '#E08080'}>{keyHint}</Text> },
    { label: 'Terminal mode', value: <Text color="#C0FAD2">{terminalMode ? 'on' : 'off'}</Text> },
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

function UsageTab({ adminKey, refreshNonce }: { adminKey: string; refreshNonce: number }) {
  // Text-summary view (per-model rollup, daily avg, projection, cache
  // efficiency). Seeds from the process-lifetime cache so reopening /usage
  // doesn't re-hit the Admin endpoint; the user presses 'r' to re-pull.
  const [text, setText] = useState<string | null>(() => peekOrgUsageText(adminKey));
  const [loading, setLoading] = useState(text === null);
  // A mount is not a refresh (seed the ref to the live nonce); only a nonce
  // change while mounted forces a re-pull. Otherwise returning to this tab
  // after pressing 'r' elsewhere would spuriously re-fetch.
  const lastNonce = useRef(refreshNonce);

  useEffect(() => {
    const force = refreshNonce !== lastNonce.current;
    lastNonce.current = refreshNonce;
    if (!force && peekOrgUsageText(adminKey) !== null) return;
    let cancelled = false;
    setLoading(true);
    getOrgUsage(adminKey, force).then(t => {
      if (cancelled) return;
      setText(t); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [adminKey, refreshNonce]);

  if (loading) return <Text color="#5A8060">Loading organization usage…</Text>;
  return (
    <Box flexDirection="column">
      {(text ?? '').split('\n').map((line, i) => (
        <UsageLine key={i} line={line} />
      ))}
    </Box>
  );
}

// Splits a `Label: value` line into muted-label / bright-value spans so the
// eye can lock onto the numbers. Section headers, model-name sub-headers,
// and prose sentences (no `label: value` pair) fall through as default green.
// The regex requires a multi-word-capable label followed by `:`, whitespace,
// then a single non-whitespace value token — anything after the value (e.g.
// parenthetical context like "(27 days of data)") stays muted.
function UsageLine({ line }: { line: string }) {
  if (!line) return <Text> </Text>;
  const re = /([A-Za-z][\w-]*(?:[ -][\w-]+)*):(\s+)(\S+)/g;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIdx) {
      parts.push(<Text key={key++} color="#C0FAD2">{line.slice(lastIdx, m.index)}</Text>);
    }
    parts.push(<Text key={key++} color="#5A8060">{m[1]}:{m[2]}</Text>);
    parts.push(<Text key={key++} color="#FFFFFF" bold>{m[3]}</Text>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < line.length) {
    parts.push(<Text key={key++} color="#C0FAD2">{line.slice(lastIdx)}</Text>);
  }
  return <Text>{parts}</Text>;
}

function StatsTab({
  adminKey, granularity, metric, refreshNonce,
}: {
  adminKey: string;
  granularity: import('./usage').UsageGranularity;
  metric: 'cost' | 'tokens';
  refreshNonce: number;
}) {
  // Stacked-bar time series across three granularities. Seeds each from the
  // process-lifetime cache and only fetches the ones still missing, so a warm
  // reopen of /usage costs zero Admin calls (the monthly view alone is 6).
  // 'r' forces a re-pull of all three.
  type G = import('./usage').UsageGranularity;
  const GRANS: G[] = ['hourly', 'daily', 'monthly'];
  const [cache, setCache]     = useState<Partial<Record<G, import('./usage').UsageSeries>>>(() => {
    const c: Partial<Record<G, import('./usage').UsageSeries>> = {};
    for (const g of GRANS) { const v = peekOrgUsageSeries(adminKey, g); if (v) c[g] = v; }
    return c;
  });
  const [errors, setErrors]   = useState<Partial<Record<G, string>>>({});
  const [pending, setPending] = useState<Set<G>>(() => new Set(GRANS.filter(g => peekOrgUsageSeries(adminKey, g) === null)));
  const lastNonce = useRef(refreshNonce);

  useEffect(() => {
    const force = refreshNonce !== lastNonce.current;
    lastNonce.current = refreshNonce;
    const toFetch = force ? GRANS : GRANS.filter(g => peekOrgUsageSeries(adminKey, g) === null);
    if (toFetch.length === 0) return;
    let cancelled = false;
    setErrors({});
    setPending(new Set(toFetch));
    for (const g of toFetch) {
      (async () => {
        const result = await getOrgUsageSeries(adminKey, g, force);
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
  }, [adminKey, refreshNonce]);

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

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

function ProjectsTab({ onViewChange }: { onViewChange: (v: null | 'list' | 'detail') => void }) {
  const [rows, setRows]       = useState<ProjectTotals[] | null>(null);
  const [history, setHistory] = useState<TurnHistoryRow[] | null>(null);
  const [view, setView]       = useState<null | 'list' | 'detail'>(null);
  const [selIdx, setSelIdx]   = useState(0);

  useEffect(() => {
    setRows(loadProjectTotals());
    const hist = loadTurnHistory(30);
    setHistory(hist);

    const unsummarized = hist.filter(h => !h.summary && h.promptText);
    if (unsummarized.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const row of unsummarized) {
        if (cancelled) break;
        const summary = await summarizePrompt(row.promptText);
        if (cancelled || !summary) continue;
        updateTurnSummary(row.ts, row.projectPath, summary);
        setHistory(prev => prev
          ? prev.map(h => h.ts === row.ts && h.projectPath === row.projectPath
              ? { ...h, summary }
              : h)
          : prev,
        );
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const navigate = (v: null | 'list' | 'detail') => { setView(v); onViewChange(v); };

  useInput((inputChar, key) => {
    const len = history?.length ?? 0;
    if (view === null) {
      if (inputChar === 'p' && len > 0) { setSelIdx(0); navigate('list'); }
      return;
    }
    if (view === 'list') {
      if (key.upArrow)   { setSelIdx(i => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSelIdx(i => Math.min(len - 1, i + 1)); return; }
      if (key.return)    { navigate('detail'); return; }
      if (key.escape)    { navigate(null); return; }
      return;
    }
    if (view === 'detail') {
      if (key.escape) { navigate('list'); return; }
    }
  });

  if (rows === null) return <Text color="#5A8060">Loading…</Text>;

  const home    = process.env.HOME ?? '';
  const display = (p: string) => home && p.startsWith(home) ? '~' + p.slice(home.length) : p;

  // ── FULL DETAIL VIEW ────────────────────────────────────────────────────────
  if (view === 'detail') {
    const h = history?.[selIdx];
    if (!h) return null;
    const model = h.primaryModel.replace(/^claude-/, '');
    return (
      <Box flexDirection="column">
        <Box gap={2}>
          <Text color="#7AB890" bold>{h.turnLabel}</Text>
          <Text color="#3D6650">·</Text>
          <Text color="#5A8060">{model}</Text>
          <Text color="#3D6650">·</Text>
          <Text color="#3D6650">{relTime(h.ts)}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column" gap={0}>
          <Box gap={2}>
            <Text color="#5A8060">Cost</Text>
            <Text color="#C0FAD2">{formatUsd(h.costUsd)}</Text>
          </Box>
          <Box gap={2}>
            <Text color="#5A8060">Tokens</Text>
            <Text color="#C0FAD2">↑ {fmtTokens(h.inputTokens)}  ↓ {fmtTokens(h.outputTokens)}</Text>
          </Box>
        </Box>
        {h.summary && (
          <Box marginTop={1} flexDirection="column">
            <Text color="#5A8060">Summary</Text>
            <Text color="#C0FAD2">{h.summary}</Text>
          </Box>
        )}
        <Box marginTop={1} flexDirection="column">
          <Text color="#5A8060">Prompt</Text>
          <Text color="#C0FAD2">{h.promptText}</Text>
        </Box>
      </Box>
    );
  }

  // ── LIST + DETAIL PANE VIEW ──────────────────────────────────────────────────
  if (view === 'list') {
    const cols     = process.stdout.columns ?? 80;
    const listW    = 44;
    const detailW  = Math.max(20, cols - listW - 7); // 7 = paddingX(2)*2 + separator(3)
    const snippet  = (h: TurnHistoryRow) => {
      const src = h.summary || h.promptText;
      return src.length > 28 ? src.slice(0, 27) + '…' : src;
    };
    const sel = history?.[selIdx];
    return (
      <Box flexDirection="row" gap={1}>
        {/* Left: list */}
        <Box flexDirection="column" width={listW} flexShrink={0}>
          {(history ?? []).map((h, i) => {
            const active = i === selIdx;
            return (
              <Box key={i} gap={1}>
                <Text color={active ? '#C0FAD2' : '#3D6650'}>{active ? '▶' : ' '}</Text>
                <Box width={8} flexShrink={0}>
                  <Text color={active ? '#7AB890' : '#3D6650'}>{relTime(h.ts)}</Text>
                </Box>
                <Box width={7} flexShrink={0}>
                  <Text color={active ? '#C0FAD2' : '#5A8060'}>{formatUsd(h.costUsd)}</Text>
                </Box>
                <Text color={active ? '#C0FAD2' : '#5A8060'}>{snippet(h)}</Text>
              </Box>
            );
          })}
        </Box>
        {/* Separator */}
        <Box flexDirection="column">
          {(history ?? []).map((_, i) => (
            <Text key={i} color="#3D6650">│</Text>
          ))}
        </Box>
        {/* Right: details of selected turn */}
        <Box flexDirection="column" width={detailW}>
          {sel ? (
            <>
              <Box gap={1} flexWrap="wrap">
                <Text color="#7AB890">{sel.turnLabel}</Text>
                <Text color="#3D6650">·</Text>
                <Text color="#5A8060">{sel.primaryModel.replace(/^claude-/, '')}</Text>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Box gap={1}>
                  <Text color="#5A8060">Cost</Text>
                  <Text color="#C0FAD2">{formatUsd(sel.costUsd)}</Text>
                </Box>
                <Box gap={1}>
                  <Text color="#5A8060">↑</Text><Text color="#C0FAD2">{fmtTokens(sel.inputTokens)}</Text>
                  <Text color="#5A8060">↓</Text><Text color="#C0FAD2">{fmtTokens(sel.outputTokens)}</Text>
                </Box>
              </Box>
              {(sel.summary || sel.promptText) && (
                <Box marginTop={1} flexDirection="column">
                  <Text color="#5A8060">{sel.summary ? 'Summary' : 'Prompt'}</Text>
                  <Box width={detailW}>
                    <Text color="#C0FAD2" wrap="wrap">{sel.summary || sel.promptText}</Text>
                  </Box>
                </Box>
              )}
            </>
          ) : null}
        </Box>
      </Box>
    );
  }

  // ── NORMAL (project bars) VIEW ───────────────────────────────────────────────
  const maxCost   = Math.max(0.000001, ...rows.map(r => r.costUsd));
  const totalUsd  = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalTok  = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCall = rows.reduce((s, r) => s + r.callCount, 0);
  const pathW     = Math.max(8, ...rows.map(r => display(r.projectPath).length));
  const barW      = 18;

  return (
    <Box flexDirection="column">
      <Text color="#5A8060">bk1-tracked sessions only · lifetime · sorted by cost</Text>
      {rows.length === 0 ? (
        <Text color="#3D6650">No data yet — come back after a session or two.</Text>
      ) : (
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
      )}
      <Box marginTop={1} flexDirection="column">
        <Box gap={2}>
          <Text color="#5A8060">Total:</Text>
          <Text color="#C0FAD2">{formatUsd(totalUsd)}</Text>
          <Text color="#5A8060">·</Text>
          <Text color="#C0FAD2">{fmtTokens(totalTok)} tok</Text>
          <Text color="#5A8060">·</Text>
          <Text color="#C0FAD2">{totalCall} calls</Text>
        </Box>
        <Text color="#3D6650">Locally tracked. Anthropic Admin totals may be higher if other tools share the org.</Text>
      </Box>
      {history && history.length > 0 && (
        <Box marginTop={1}>
          <Text color="#5A8060">Recent Prompts </Text>
          <Text color="#3D6650">· press </Text>
          <Text color="#7AB890">p</Text>
          <Text color="#3D6650"> to browse</Text>
        </Box>
      )}
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
  // Bars are scaled to one row shorter than the chart so the tallest bar
  // always leaves an empty row above its tip for its value label.
  const barMaxH   = chartH - 1;
  const yLabelW   = 9;
  const cols      = process.stdout.columns ?? 80;
  const availW    = Math.max(20, cols - yLabelW - 6);
  // Each bucket gets at least 2 cells so even single-color bars are visible
  // as bars and not vertical hairlines. Cap at 4 so 6-bucket monthly views
  // don't stretch into giant blocks.
  const colW      = Math.max(2, Math.min(4, Math.floor(availW / Math.max(1, series.buckets.length))));
  // One blank column between bars. bucketW is the full slot width per bucket;
  // colW is the bar's own width within that slot.
  const bucketW   = colW + 1;

  const bars = series.buckets.map(b => {
    const value = metric === 'cost' ? b.totalUsd : b.totalTokens;
    const rawFilled = Math.round((value / maxVal) * barMaxH);
    // Non-zero buckets get at least one row so a small day next to a huge
    // day doesn't vanish (same reasoning as the old horizontal version).
    const filled = value > 0 ? Math.max(1, Math.min(barMaxH, rawFilled)) : 0;
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
  const stride = Math.max(1, Math.ceil((maxLabel + 1) / bucketW));

  // Build a per-cell plan for each row. Cells are either part of a bar
  // (backgroundColor = family) or empty/text. Value labels go into empty
  // cells one row above each bar's tip; if a label is wider than `colW`
  // it spills into the adjacent empty cell to the right. Bar cells always
  // win over label cells, so a label on a short bar can't ever overlay a
  // taller bar's column.
  type RowCell = { bg: string | null; ch: string };
  const buildRow = (row: number): RowCell[] => {
    // Extra 4 cells on the right so the last bar's value label can overflow
    // without being clipped.
    const totalCols = bars.length * bucketW + 4;
    const cells: RowCell[] = Array.from({ length: totalCols }, () => ({ bg: null, ch: ' ' }));
    // Bars
    bars.forEach((_, col) => {
      const fam = cellAt(col, row);
      if (!fam) return;
      const color = USAGE_FAMILY_COLOR[fam];
      if (!color) return;
      for (let i = 0; i < colW; i++) cells[col * bucketW + i] = { bg: color, ch: ' ' };
    });
    // Value labels — one row above each non-zero bar's tip
    bars.forEach((b, col) => {
      if (b.value === 0) return;
      const labelRow = Math.max(0, chartH - b.filled - 1);
      if (labelRow !== row) return;
      const label = compactVal(b.value);
      for (let i = 0; i < label.length; i++) {
        const idx = col * bucketW + i;
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
            const slotW = bucketW * stride;
            // For the last visible label, only pad up to the end of the chart
            // so we don't print stray spaces past the right edge.
            const remaining = (bars.length - col) * bucketW;
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
    const restore = () => {
      disableMouseTracking(process.stdout);
      disableModifyOtherKeys(process.stdout);
      disableKittyKeyboard(process.stdout);
    };
    // Exit when the controlling terminal goes away. Under the VS Code extension
    // bk1 runs as the shell of a pty the extension owns; if the extension host
    // dies without disposing the terminal (a crash, a hard window kill, a
    // reload), the pty's master end closes but nothing tells us to stop — and we
    // linger as an orphan holding the whole React tree + SQLite in memory. Those
    // orphans stack across reloads into real memory pressure. The extension's
    // deactivate()/dispose() can't be relied on (a crashed host never runs it),
    // so we detect the dead terminal ourselves and exit. The signals: EOF on
    // stdin ('end'), an EIO read error on stdin, SIGHUP, and a failed stdout
    // frame write all mean there is no terminal left to talk to.
    const die = () => { restore(); process.exit(0); };
    const onStreamErr = (err: NodeJS.ErrnoException) => {
      if (err && (err.code === 'EIO' || err.code === 'EPIPE' || err.code === 'ENXIO' || err.code === 'EBADF')) die();
    };
    process.on('exit', restore);
    process.on('SIGINT', die);
    process.on('SIGTERM', die);
    process.on('SIGHUP', die);
    process.stdin.on('end', die);
    process.stdin.on('error', onStreamErr);
    process.stdout.on('error', onStreamErr);
    return () => {
      restore();
      process.off('exit', restore);
      process.off('SIGINT', die);
      process.off('SIGTERM', die);
      process.off('SIGHUP', die);
      process.stdin.off('end', die);
      process.stdin.off('error', onStreamErr);
      process.stdout.off('error', onStreamErr);
    };
  }, []);

  // Enable both xterm modifyOtherKeys mode 2 AND kitty keyboard protocol level
  // 1 so the terminal reports Shift+Enter as a distinct escape sequence. We
  // need both because no single mode covers every terminal:
  //   - iTerm2 / Apple Terminal honor modifyOtherKeys (CSI 27;2;13~)
  //   - VS Code's xterm.js honors kitty CSI u (CSI 13;2u) but not
  //     modifyOtherKeys for Enter specifically
  // The detector accepts either form, so whichever the terminal emits wins.
  // Unsupported terminals ignore both enable sequences and Shift+Enter
  // degrades gracefully to plain Enter (submits the buffer).
  useEffect(() => {
    enableModifyOtherKeys(process.stdout);
    enableKittyKeyboard(process.stdout);
    // kitty disambiguate mode re-encodes Escape and Shift+Tab into CSI u
    // sequences Ink can't parse. Intercept stdin's data emission and rewrite
    // them to legacy bytes so every useInput handler (model picker, abort,
    // /usage panel, …) sees key.escape / key.shift+key.tab again. Only the two
    // affected sequences are touched; everything else (incl. mouse SGR) passes
    // through untouched, and a non-matching chunk keeps its original Buffer.
    // kitty CSI-u normalization (Escape, Shift+Tab, Ctrl+letter) AND the
    // split-ESC rejoin both live in App's single stdin.emit interceptor (see the
    // effect further down), so this effect only owns the mode enable/disable
    // lifecycle. Keeping all stdin rewriting in one place avoids a layering
    // dependency between two competing emit wrappers (which is what previously
    // let split-Escape slip through unnormalized).
    return () => {
      disableModifyOtherKeys(process.stdout);
      disableKittyKeyboard(process.stdout);
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
  // Cursor position: index into `input`, 0..input.length. Left/Right move it,
  // typing inserts at it, backspace deletes before it. Mirrored to a ref for the
  // []-deps key handler (same pattern as inputRef). Keep the two in lockstep —
  // always update via setInputAndCursor below rather than touching either alone.
  const [cursorPos, setCursorPos] = useState(0);
  const cursorPosRef = useRef(0);
  const [liveText, setLiveText] = useState('');
  const [activeTool, setActiveTool] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [liveExpanded, setLiveExpanded] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [mode, setMode] = useState<Mode>('plan');
  const [modelIdx, setModelIdx] = useState(DEFAULT_MODEL_IDX);
  const [projectIdx, setProjectIdx] = useState(0);
  const [petPlayIdx, setPetPlayIdx] = useState(0);
  const [petFeedIdx, setPetFeedIdx] = useState(0);
  const [petPlayroomIdx, setPetPlayroomIdx] = useState(0);
  const [semanticProgress, setSemanticProgress] = useState<SemanticProgress | null>(null);
  const [lintProgress, setLintProgress] = useState<LintProgress | null>(null);
  const [confirmPrompt, setConfirmPrompt] = useState<string | null>(null);
  const [confirmSelected, setConfirmSelected] = useState(0);
  const [liveTokens, setLiveTokens] = useState<TokenTotals | null>(null);
  // Mirror messages into a ref so callbacks with empty deps (e.g. submit's
  // /history handler) read the live state instead of the empty array captured
  // at mount.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Persist conversation to ~/.bk1/sessions.db. A session row is created at
  // mount; every messages change schedules a debounced replace-all save.
  // Failures are swallowed (matching usage.db's best-effort pattern) so a
  // disk-full or DB-locked condition never blocks the chat.
  useEffect(() => {
    if (currentSessionIdRef.current !== null) return;
    try {
      currentSessionIdRef.current = createSession(getProjectDir(), MODELS[DEFAULT_MODEL_IDX]!.id);
    } catch { /* DB unavailable — history will be a no-op for this session */ }
    // Seed the recents list with the launch dir so the very first /project
    // switch already has somewhere to go back to.
    recordRecentProject(getProjectDir());
  }, []);
  useEffect(() => {
    if (currentSessionIdRef.current === null || messages.length === 0) return;
    const sessionId = currentSessionIdRef.current;
    const t = setTimeout(() => {
      const stored: StoredMessage[] = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content, info: m.info }));
      try { saveSessionMessages(sessionId, stored); } catch { /* best-effort */ }
    }, 500);
    return () => clearTimeout(t);
  }, [messages]);

  const inputRef = useRef('');
  // Set the input string AND cursor position together (keeps state + refs in
  // lockstep). cursor defaults to end-of-string — correct for clears (''→0),
  // history recall, and slash-completion. Editing handlers pass an explicit
  // cursor. Clamped to [0, value.length].
  const setInputAndCursor = useCallback((value: string, cursor: number = value.length) => {
    const c = Math.max(0, Math.min(cursor, value.length));
    inputRef.current = value;
    cursorPosRef.current = c;
    setInput(value);
    setCursorPos(c);
  }, []);
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
  // Stamped when the raw-stdin handler inserts a newline for Opt+Enter (`\x1b\r`).
  // The same chunk also reaches Ink's useInput, which decodes the trailing `\r`
  // as key.return and would otherwise submit. The key.return branch checks this
  // timestamp and skips submit if a newline was just inserted (~50ms window),
  // so Opt+Enter inserts a newline instead of sending the prompt.
  const newlineJustInsertedRef = useRef<number>(0);
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
  // True while the window is actively being resized. The live frame collapses to a
  // minimal height (input + one status line, no pet sprite / rules / hints) while
  // this is set — see the resize handling note below.
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    // Resize ghosting fix, Claude-Code style. The root bug: bk1's live (repainted)
    // frame is ~10 rows tall (pet sprite, footer, rules, hints, input). On resize the
    // terminal reflows those rows into a different physical-row count, which desyncs
    // Ink's log-update line tracking and leaves stale copies stacked in scrollback as
    // ghosts. No amount of post-hoc clearing fixes it cleanly (logical vs physical
    // line counts can't be resynced), and we must never wipe the <Static> history.
    //
    // The robust fix is to keep the live frame SMALL so it can't wrap-scroll and ghost.
    // We can't permanently drop the pet sprite, so instead we collapse the live frame
    // to a minimal height only WHILE resizing: set `resizing` on the first resize tick,
    // clear it on a trailing debounce once the drag settles.
    //
    // We deliberately do NOT manually clear Ink's output here. Ink's clear() writes
    // eraseLines(previousLineCount), and previousLineCount is a LOGICAL line count while
    // the terminal reflows PHYSICAL rows — calling it mid-resize corrupts Ink's counter
    // against the reflowed buffer and strands orphan rows (the stray HRule lines we saw).
    // Letting Ink's own log() do the erase on each render keeps the counter self-consistent.
    // The other half of the fix is that HRule never spans the full width (see HRule), so no
    // live-frame row wraps to a second physical row — the divergence that makes the upward
    // erase fall short.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      setTerminalRows(process.stdout.rows ?? 24);
      setResizing(true);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => setResizing(false), 300);
    };
    process.stdout.on('resize', onResize);
    return () => {
      if (settleTimer) clearTimeout(settleTimer);
      process.stdout.off('resize', onResize);
    };
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
  const petPlayroomIdxRef = useRef(0);
  const projectIdxRef = useRef(0);
  useEffect(() => { modelIdxRef.current = modelIdx; }, [modelIdx]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { petPlayIdxRef.current = petPlayIdx; }, [petPlayIdx]);
  useEffect(() => { petFeedIdxRef.current = petFeedIdx; }, [petFeedIdx]);
  useEffect(() => { petPlayroomIdxRef.current = petPlayroomIdx; }, [petPlayroomIdx]);
  useEffect(() => { projectIdxRef.current = projectIdx; }, [projectIdx]);
  // Lint phase tracking refs — readable inside the memoised submit callback
  const lintProgressRef = useRef<LintProgress | null>(null);
  const lastModelStateActionRef = useRef<string | null>(null);
  useEffect(() => { lintProgressRef.current = lintProgress; }, [lintProgress]);
  const tokenAccRef = useRef<TokenTotals>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });

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
  const currentTurnLabelRef    = useRef<string>('chat');
  const currentUserPromptRef   = useRef<string>('');
  const currentPrimaryModelRef = useRef<string>('');

  // Pet — persistent Tamagotchi state at ~/.bk1/pet.json. Lazy-init on first render:
  // if no file exists, hatch a fresh egg. tickPet() runs immediately so the StatusFooter
  // shows the correct mood reflecting any time elapsed since last launch.
  const [pet, setPet] = useState<PetState>(() => {
    const loaded = loadPet();
    const initial = loaded ? tickPet(loaded) : newPet();
    savePet(initial);
    return initial;
  });
  // Session alias — overrides pet.name when sending hello messages in the
  // playroom so peers/spectators see "Keith" rather than "Motchi". Lives
  // only in process memory; resets on bk1 launch and on /pet release.
  const [sessionAlias, setSessionAlias] = useState<string | null>(null);
  // Mirror the latest pet in a ref so the closure in onUsage (registered once) can read
  // the freshest value without re-creating callbacks every render.
  const petRef = useRef(pet);
  useEffect(() => { petRef.current = pet; }, [pet]);

  // Transient toast surfaced when a coin event fires (lint fix, push, etc.).
  // Auto-clears after a few seconds so it doesn't linger past the moment.
  const [coinToast, setCoinToast] = useState<{ delta: number; reason: string } | null>(null);

  // Register the coin-event handler once at mount. State.ts (lint pipeline)
  // and future emitters (git poll, dbt tool wrappers) call emitCoinEvent;
  // this handler applies the delta to the pet and shows a transient toast.
  // Every event pays its full delta — there is no per-session cap. (A passive
  // cap on model add/update events was removed; coins now mirror XP, awarding
  // in full for every action.)
  useEffect(() => {
    registerCoinEventHandler((event: CoinEvent) => {
      const delta = event.delta;
      // XP earns from positive deltas only (it ignores penalties and never
      // decreases); coins take the delta directly (addCoins floors at zero).
      let next = addCoins(petRef.current, delta);
      if (delta > 0) next = addXp(next, delta);
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
  // When set, the render path swaps the conversation view for the multiplayer
  // playroom lobby. `null` means closed. Driven by `/pet playroom create|join`.
  const [playroom, setPlayroom] = useState<LobbyMode | null>(null);
  // Persistent conversation history. A new session is created per bk1 launch
  // (or rolled into an existing one when /history selects a past session to
  // resume). Messages are debounce-saved to ~/.bk1/sessions.db as the chat
  // progresses; the SessionPicker reads from the same store to surface past
  // conversations for review/resume. See src/sessions.ts.
  const currentSessionIdRef = useRef<number | null>(null);
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  // Terminal mode toggle. When ON, lines submitted at the prompt run as shell
  // commands via runInlineShell (no LLM, no tokens) — prefix with `?` to ask
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

  // Unified mouse-tracking lifecycle. Tracking is ON only while a pet mini-game
  // is active (fetch needs to receive clicks). Otherwise OFF, so the terminal
  // handles wheel/select natively — VS Code's terminal scrollback, native text
  // selection, and wheel scroll keep working.
  const mouseTrackingOnRef = useRef(false);
  useEffect(() => {
    const want = activeGame !== null;
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
  }, [activeGame]);
  // One-shot disable in case a previous bk1 session left the terminal in mouse mode.
  useEffect(() => {
    disableMouseTracking(process.stdout);
    mouseTrackingOnRef.current = false;
  }, []);

  // Opt+Enter / Shift+Enter → insert a newline into the prompt instead of
  // submitting. Handled by re-wrapping stdin.emit (layered on top of AppShell's
  // wrapper) because this runs before ANY 'data' listener — including Ink's,
  // which is registered first and would otherwise decode the trailing `\r` as
  // key.return and submit before a plain stdin listener could intervene. On a
  // match we update the input here (this effect lives in App, which owns the
  // input state) and SWALLOW the chunk so Ink never sees it.
  useEffect(() => {
    const stdin = process.stdin as NodeJS.ReadStream & { read: (size?: number) => unknown };
    // Ink reads input via stdin.read() inside a 'readable' listener (see
    // node_modules/ink/build/components/App.js) — NOT the 'data' event. So the
    // ONLY way to transform what Ink's useInput sees is to wrap read() itself.
    // (An earlier emit('data') wrapper was a no-op whenever stdin was in paused/
    // readable mode, which is why ESC silently failed in the extension.)
    //
    // Here we:
    //  - normalize kitty CSI-u sequences to the legacy bytes Ink decodes:
    //    Escape \x1b[27u → \x1b, Shift+Tab \x1b[9;2u → \x1b[Z, Ctrl+<letter>
    //    \x1b[<c>;5u → control byte. Without this, Escape/Ctrl+C/Shift+Tab arrive
    //    as un-decodable text in kitty terminals (VS Code's xterm.js) and no-op.
    //  - turn a newline-insert key (Opt/Shift+Enter) into an actual \n inserted
    //    at the cursor, and hide it from Ink so it doesn't submit.
    const realRead = stdin.read.bind(stdin);
    stdin.read = ((size?: number) => {
      const chunk = realRead(size);
      if (chunk === null || chunk === undefined) return chunk;
      let s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      // Newline-insert key: append \n to the prompt and hand Ink an empty read
      // so it never sees a key.return for it. Only at the prompt (not running /
      // not entering the admin key), matching the previous guard.
      if (!isRunningRef.current && !awaitingAdminKeyRef.current && isNewlineKey(s)) {
        // Insert the newline at the cursor (not just append), advancing past it.
        const cur = inputRef.current;
        const pos = cursorPosRef.current;
        setInputAndCursor(cur.slice(0, pos) + '\n' + cur.slice(pos), pos + 1);
        setSuggestionIndex(-1);
        return Buffer.alloc(0);
      }
      if (s.includes('\x1b[27u') || s.includes('\x1b[9;2u') || /\x1b\[\d+;5u/.test(s)) {
        s = normalizeKittyKeys(s);
        return Buffer.from(s, 'utf8');
      }
      return chunk;
    }) as typeof stdin.read;
    return () => { stdin.read = realRead; };
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
      const str = data.toString('utf8');
      const events = parseMouseEvents(str);
      for (const ev of events) {
        if (!ev.press || ev.motion) continue;
        if (ev.button !== 'left') continue;
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
  // /pet playroom (with or without trailing chars) → Create / Join picker.
  // The startsWith check uses a trailing space so `/pet play` doesn't get
  // misclassified as a playroom intent while the user is still typing.
  const isPetPlayroomPicker = input === '/pet playroom' || input.startsWith('/pet playroom ');
  // /project (with or without a trailing path) → recents picker. Trailing space
  // so a future command sharing the prefix isn't misclassified mid-type.
  const isProjectPicker = input === '/project' || input.startsWith('/project ');
  // The text typed after "/project " — when non-empty, Enter switches to this
  // path instead of the arrow-selected recent.
  const projectTyped = isProjectPicker ? input.replace(/^\/project\s*/, '').trim() : '';
  const projectRecents = useMemo(() => getRecentProjects(), [isProjectPicker]);

  const suggestions = useMemo(() => {
    if (isModelPicker || isPetPlayPicker || isPetFeedPicker || isPetPlayroomPicker || isProjectPicker) return [] as [string, typeof SKILLS[string]][];
    if (!input.startsWith('/')) return [] as [string, typeof SKILLS[string]][];
    const partial = input.slice(1).split(' ')[0]?.toLowerCase() ?? '';
    return Object.entries(SKILLS).filter(([cmd]) => cmd.startsWith(partial)) as [string, typeof SKILLS[string]][];
  }, [input, isModelPicker, isPetPlayPicker, isPetFeedPicker, isPetPlayroomPicker, isProjectPicker]);

  // Switch the active dbt project mid-session (the /project picker calls this).
  // Keeps the conversation on screen but re-points everything project-keyed:
  // the dir getter, the state DB connection, the agent's system prompt, and the
  // session log. A "Switched project" info line demarcates the kept history.
  // Returns an error string on failure (bad path) so the caller can surface it
  // without anything having been torn down. The macOS permission case is handled
  // in-place (guided Full Disk Access flow) and returns null so the caller adds
  // nothing further. Never switches mid-agent-run.
  const changeProject = useCallback((rawPath: string): string | null => {
    if (isRunningRef.current) return 'Cannot switch project while the agent is running.';
    const target = rawPath.trim();
    if (!target) return 'No path given.';
    if (!isDbtProject(target)) return `Not a dbt project (no dbt_project.yml): ${target}`;
    // dbt_project.yml exists but may be unreadable (macOS TCC on ~/Desktop etc.).
    // Probe here rather than half-switching into a session whose system prompt and
    // file reads would all hit EPERM.
    const access = checkProjectAccess(target);
    if (!access.ok) {
      // On macOS a denial is almost always TCC: the host terminal lacks Full Disk
      // Access for the gated folder. Name it and offer a one-key jump to the exact
      // Settings pane — macOS won't re-prompt once denied, so this is the way back.
      if (access.denied && process.platform === 'darwin') {
        const app = hostTerminalName();
        setMessages(prev => [...prev, { role: 'assistant', info: true, content:
          `macOS is blocking ${app} from reading files in ${target}.\n\n` +
          `This is macOS Privacy (TCC) — the Desktop, Documents and Downloads folders are gated per app. ` +
          `Grant ${app} Full Disk Access, fully quit and relaunch it, then retry /project ${target}.\n\n` +
          `(Or move the project out of those three folders — anywhere else isn't gated.)` }]);
        pendingConfirmActionRef.current = {
          onYes: () => {
            openFullDiskAccessSettings();
            setMessages(prev => [...prev, { role: 'assistant', info: true, content:
              `Opened System Settings → Full Disk Access. Enable ${app}, quit and relaunch it, then retry /project.` }]);
          },
          onNo: () => {},
        };
        setConfirmPrompt(`Open System Settings → Full Disk Access for ${app} now? (yes/no)`);
        return null;
      }
      return access.message;
    }
    let resolved: string;
    try { resolved = setProjectDir(target); }
    catch (err) { return err instanceof Error ? err.message : String(err); }
    // Re-point per-project state. Order doesn't matter between these three; all
    // read the now-updated getProjectDir() lazily.
    resetDb();
    rebuildSystemPrompt();
    // Start a fresh session row for the new project so history is filed under
    // the right project; keep the on-screen messages (user chose "keep chat").
    try { currentSessionIdRef.current = createSession(resolved, MODELS[modelIdxRef.current]!.id); }
    catch { currentSessionIdRef.current = null; }
    recordRecentProject(resolved);
    setMessages(prev => [...prev, { role: 'assistant', info: true, content: `Switched project to ${resolved}` }]);
    return null;
  }, []);

  // Prompt-input channel (see PROMPT_INPUT_FILE). promptReadPosRef tracks how far
  // we've consumed the append-only file; pendingPromptsRef holds prompts that
  // arrived while a turn was running; runPromptRef breaks the submit ⇄ runPrompt
  // cycle so submit's finally can launch the next queued prompt.
  const promptReadPosRef = useRef(0);
  const pendingPromptsRef = useRef<PromptInputPayload[]>([]);
  const runPromptRef = useRef<(p: PromptInputPayload) => void>(() => {});

  const submit = useCallback(async () => {
    // Normalize line breaks before anything reads the buffer: a stray \r (from
    // Opt+Enter's \x1b\r) renders as a cursor-return in the history bubble,
    // pushing lines outside the border. Collapse \r\n and lone \r to \n, then
    // drop any other control bytes, so the stored message + everything sent to
    // the agent contains only clean newlines.
    let raw = inputRef.current
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x09\x0b-\x1f]/g, '')  // controls except \n (0x0a)
      .trim();
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
      setInputAndCursor(''); setSuggestionIndex(-1);
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
      setInputAndCursor(''); setSuggestionIndex(-1);
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
      if (!rest) { setInputAndCursor(''); setSuggestionIndex(-1); return; }
      raw = rest;
    }

    // Local UI commands — handled here, never sent to the agent
    if (raw === '/plan' || raw === '/build' || raw === '/auto') {
      const next = raw.slice(1) as Mode;
      setMode(next); modeRef.current = next;
      setInputAndCursor(''); setSuggestionIndex(-1);
      return;
    }
    // /term and /clear are slash-command equivalents of Ctrl+T and Ctrl+L.
    // VS Code's editor terminal intercepts a number of Ctrl+<letter> combos
    // (varies by version and user keybindings), so Ctrl+T / Ctrl+L
    // unreliably reach bk1 there. Slash commands always work because they're
    // just typed text submitted via Enter.
    if (raw === '/term' || raw === '/shell') {
      terminalModeRef.current = !terminalModeRef.current;
      setTerminalMode(terminalModeRef.current);
      setInputAndCursor(''); setSuggestionIndex(-1);
      return;
    }
    if (raw === '/clear') {
      process.stdout.write('\x1b[3J\x1b[H\x1b[2J');
      setInputAndCursor(''); setSuggestionIndex(-1);
      return;
    }
    if (raw.startsWith('/model')) {
      // Tab already cycled the selection — Enter just closes the picker
      setInputAndCursor(''); setSuggestionIndex(-1);
      return;
    }
    if (raw === '/project' || raw.startsWith('/project ')) {
      // Switch the active dbt project. A typed path (after "/project ") wins;
      // otherwise use the arrow-selected recent. changeProject re-points all
      // project-keyed state and pushes a "Switched project" line; on failure it
      // returns an error string we surface in the chat.
      setInputAndCursor(''); setSuggestionIndex(-1);
      // Read recents + selection fresh (this callback has [] deps; the captured
      // state would be stale — mirror the petPlay/feed picker ref pattern).
      const typed = raw.replace(/^\/project\s*/, '').trim();
      const recents = getRecentProjects();
      const target = typed || recents[projectIdxRef.current] || '';
      if (!target) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Usage: /project <path>, or pick from recents (arrow keys).' }]);
        return;
      }
      const err = changeProject(target);
      if (err) setMessages(prev => [...prev, { role: 'assistant', content: err }]);
      setProjectIdx(0); projectIdxRef.current = 0;
      return;
    }
    if (raw === '/logout') {
      // Intercept before expandSkill — /logout is a UI-state transition, not a prompt
      // for the agent. AppShell handles clearing the key and re-rendering the login
      // screen; we just clear input and trigger.
      setInputAndCursor(''); setSuggestionIndex(-1);
      onLogout();
      return;
    }
    // /lint-deep — gate the (expensive) semantic pass on a local Y/N if a report
    // already exists in <project>/.bk1/lint-report.html. The check + prompt happen
    // entirely client-side; the LLM is only called if the user explicitly opts in.
    // `--force` bypasses the gate so a deliberate re-run never asks twice.
    if (raw === '/lint-deep' || (raw.startsWith('/lint-deep ') && !raw.includes('--force'))) {
      if (existsSync(lintReportPath())) {
        pendingConfirmActionRef.current = {
          onYes: () => {
            setInputAndCursor('/lint-deep --force');
            void submit();
          },
          onNo: () => {
            setInputAndCursor(''); setSuggestionIndex(-1);
            setMessages(prev => [
              ...prev,
              { role: 'user', content: raw },
              { role: 'assistant', content: `Existing lint report: ${lintReportPath()}\n\nOpen it in your browser, or run \`/lint-deep --force\` to overwrite with a fresh semantic pass.` },
            ]);
          },
        };
        setConfirmPrompt(`A lint report already exists at ${lintReportPath()}. Re-run /lint-deep and overwrite it? (yes/no)`);
        return;
      }
    }
    if (raw === '/usage') {
      setInputAndCursor(''); setSuggestionIndex(-1);
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
    if (raw === '/review' || raw === '/scroll') {
      // Enter full-screen scrollable conversation view. The App's render path
      // short-circuits to <ReviewMode/> while `reviewMode` is true; Esc inside
      // ReviewMode calls onExit which flips it back to false.
      setInputAndCursor(''); setSuggestionIndex(-1);
      setReviewMode(true);
      return;
    }
    if (raw === '/history') {
      // Open the cross-session picker — type to filter by title or message
      // content (FTS5), Enter to load a past session into the current view.
      // Replaces the earlier "snapshot to markdown" behavior, which was
      // current-session-only and lost on bk1 close. The old behavior is
      // still reachable as /export below.
      setInputAndCursor(''); setSuggestionIndex(-1);
      setHistoryPickerOpen(true);
      return;
    }
    if (raw === '/export') {
      // Old /history behavior: snapshot the current conversation to a markdown
      // file and open it in VS Code. Useful when you want to share a session
      // out-of-band (paste into a PR description, archive elsewhere).
      setInputAndCursor(''); setSuggestionIndex(-1);
      const md: string[] = [`# bk1 session — ${new Date().toISOString()}`, ''];
      for (const msg of messagesRef.current) {
        if (msg.role === 'user') {
          md.push(`## > ${msg.content}`, '');
        } else {
          md.push(msg.content, '');
        }
      }
      const dir  = `${getProjectDir()}/.bk1`;
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
      setInputAndCursor(''); setSuggestionIndex(-1);
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
      setInputAndCursor(''); setSuggestionIndex(-1);
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
            note = `You fed ${nextPet.name ?? 'your pet'} a ${food.label.toLowerCase()} (-${food.cost} 💰 ).`;
          }
        }
      } else if (sub === 'play') {
        // Arg present → direct launch (`/pet play fetch`); arg invalid → error.
        // No arg → launch whatever the GamePicker is currently highlighting.
        // Happiness is credited inside each game's onExit (it accumulates
        // per-click), so launching does not tap stats by itself.
        if (MULTIPLAYER_GAME_IDS.has(arg)) {
          // Multiplayer games live inside the playroom modal. Opening the
          // lobby in create mode drops the user into the share-address flow;
          // once their peer joins, the chosen game can be launched with its
          // key shortcut (j for jakenpoy, r for race, a for artillery).
          setPlayroom({ kind: 'create' });
          return;
        } else if (arg === 'space-impact') {
          note = `space-impact was replaced by artillery. Try /pet play artillery instead.`;
        } else if (arg && GAMES[arg]) {
          setActiveGame(arg);
          return;
        } else if (arg) {
          const all = [...Object.keys(GAMES), ...MULTIPLAYER_GAMES.map(g => g.id)].map(id => `/pet play ${id}`).join(' · ');
          note = `Unknown game "${arg}". Try: ${all}`;
        } else {
          // No-arg submit from the picker — `petPlayIdxRef.current` indexes
          // into the combined [single, ...multi] list rendered by GamePicker.
          const singleIds = Object.keys(GAMES);
          const multiIds = MULTIPLAYER_GAMES.map(g => g.id);
          const allIds = [...singleIds, ...multiIds];
          const picked = allIds[petPlayIdxRef.current] ?? allIds[0];
          if (picked) {
            if (MULTIPLAYER_GAME_IDS.has(picked)) {
              setPlayroom({ kind: 'create' });
            } else {
              setActiveGame(picked);
            }
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
        // newPet() assigns a fresh random color, so the released pet's color is
        // re-rolled automatically. The session alias lives separately, so we
        // clear it explicitly here.
        setSessionAlias(null);
        note = `You released ${farewellName} back into the mangroves. A new egg appears.`;
      } else if (sub === 'playroom') {
        // /pet playroom <create|join [<pin>]|leave>. Opens the fullscreen lobby
        // and returns immediately — the render path swaps to <PlayroomLobby> via
        // the `playroom` state gate above. No pet state change.
        const [action, ...joinRest] = rest;
        const joinPin = joinRest.join(' ').trim().toUpperCase();
        if (!action) {
          // No-arg submit from the picker — `petPlayroomIdxRef.current` is the
          // highlighted entry in PLAYROOM_ACTIONS.
          const picked: PlayroomActionId = PLAYROOM_ACTIONS[petPlayroomIdxRef.current]?.id ?? 'create';
          setPlayroom(picked === 'create' ? { kind: 'create' } : { kind: 'join' });
          return;
        }
        if (action === 'create') {
          setPlayroom({ kind: 'create' });
        } else if (action === 'join') {
          setPlayroom(joinPin ? { kind: 'join', pin: joinPin } : { kind: 'join' });
        } else if (action === 'leave') {
          setPlayroom(null);
        } else {
          note = `Usage: /pet playroom · /pet playroom create · /pet playroom join [<pin>] · /pet playroom leave`;
        }
        if (!note) return;
      } else {
        note = `Unknown /pet subcommand "${sub}". Try: /pet · /pet feed · /pet play · /pet sleep · /pet name <name> · /pet playroom · /pet release`;
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
    currentTurnLabelRef.current    = classifyTurnLabel(raw);
    currentUserPromptRef.current   = raw;
    currentPrimaryModelRef.current = MODELS[modelIdxRef.current]!.id;

    const skill = expandSkill(raw);
    const displayText = skill ? skill.display : raw;
    const promptText = skill ? skill.prompt : raw;

    setInputAndCursor('');
    setSuggestionIndex(-1);
    isRunningRef.current = true;
    setIsRunning(true);
    setLiveExpanded(false);
    setLiveText('');
    setSemanticProgress(null);
    tokenAccRef.current = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
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
    emitChatEvent({ type: 'user', text: displayText, ts: Date.now() });

    const controller = new AbortController();
    abortRef.current = controller;

    let fullText = '';
    const toolLog: ToolEvent[] = [];

    try {
      const updated = await runAgent(
        historyRef.current,
        {
          onText: (chunk) => {
            fullText += chunk;
            setLiveText(fullText);
            emitChatEvent({ type: 'text', chunk, ts: Date.now() });
          },
          onThinking: (text) => {
            emitChatEvent({ type: 'thinking', text: truncateForChat(text), ts: Date.now() });
          },
          onToolStart: (name, input) => {
            setActiveTool(name);
            toolLog.push({ name });
            emitChatEvent({ type: 'tool_start', name, desc: describeToolInput(input), input: formatToolInput(input), ts: Date.now() });

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
          onModelRoute: (model: string, classification: string) => {
            const label = MODELS.find(m => m.id === model)?.label ?? model;
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: `↳ Auto-routed to ${label} (${classification})`,
              info: true,
            }]);
          },
          onUsage: (u: TokenUsage, model: string, subAgentLabel?: string) => {
            const acc = tokenAccRef.current;
            const callCost = estimateCostUsd({
              input:      u.inputTokens,
              output:     u.outputTokens,
              cacheRead:  u.cacheReadTokens,
              cacheWrite: u.cacheWriteTokens,
            }, model);
            const next = {
              input:      acc.input      + u.inputTokens,
              output:     acc.output     + u.outputTokens,
              cacheRead:  acc.cacheRead  + u.cacheReadTokens,
              cacheWrite: acc.cacheWrite + u.cacheWriteTokens,
              costUsd:    acc.costUsd    + callCost,
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
              projectPath: getProjectDir(),
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
            emitChatEvent({ type: 'tool_end', name, result: truncateForChat(result), ts: Date.now() });
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
      emitChatEvent({ type: 'done', ts: Date.now() });
      // One row per user turn in turn_costs so the Projects tab can show per-prompt history.
      if (finalTokens.costUsd > 0) {
        recordTurnCost({
          projectPath:  getProjectDir(),
          turnLabel:    currentTurnLabelRef.current,
          primaryModel: currentPrimaryModelRef.current,
          promptText:   currentUserPromptRef.current,
          costUsd:      finalTokens.costUsd,
          input:        finalTokens.input,
          output:       finalTokens.output,
          cacheRead:    finalTokens.cacheRead,
          cacheWrite:   finalTokens.cacheWrite,
        });
      }
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
        emitChatEvent({ type: 'done', cancelled: true, ts: Date.now() });
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }]);
        emitChatEvent({ type: 'done', error: err instanceof Error ? err.message : String(err), ts: Date.now() });
      }
    } finally {
      abortRef.current = null;
      setLiveText('');
      setActiveTool('');
      setIsRunning(false);
      setLintProgress(null);
      isRunningRef.current = false;
      // Drain one prompt that arrived (via the prompt-input channel) mid-turn,
      // preserving order. queueMicrotask so this turn's state settles first.
      const queued = pendingPromptsRef.current.shift();
      if (queued) queueMicrotask(() => runPromptRef.current(queued));
    }
  }, []);

  // Prompt-input channel: apply one payload — switch model if requested, then
  // route the text through the normal submit() path. If a turn is already
  // running, queue it (drained in submit's finally, preserving order).
  const runPromptPayload = useCallback((payload: PromptInputPayload) => {
    if (isRunningRef.current) { pendingPromptsRef.current.push(payload); return; }
    if (typeof payload.model === 'string') {
      const idx = MODELS.findIndex(m => m.id === payload.model);
      if (idx >= 0) { modelIdxRef.current = idx; setModelIdx(idx); }
    }
    const text = (payload.text ?? '').replace(/\r\n?/g, '\n');
    if (!text.trim()) return;
    setInputAndCursor(text);
    void submit();
  }, [submit, setInputAndCursor]);
  useEffect(() => { runPromptRef.current = runPromptPayload; }, [runPromptPayload]);

  // Read newly-appended prompt lines and run them. Mirrors the extension's
  // flushChatEvents (offset-tracked, truncation-safe). On the first drain
  // (mount) stale lines are skipped via PROMPT_INPUT_FRESH_MS but still consumed
  // so the offset advances past them.
  const drainPromptInput = useCallback((firstDrain: boolean) => {
    let size: number;
    try { size = statSync(PROMPT_INPUT_FILE).size; } catch { return; }
    let pos = promptReadPosRef.current;
    if (size < pos) pos = 0;            // file shrank / rotated
    if (size === pos) return;
    const buf = Buffer.alloc(size - pos);
    let fd: number | undefined;
    try {
      fd = openSync(PROMPT_INPUT_FILE, 'r');
      readSync(fd, buf, 0, buf.length, pos);
    } catch { return; }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
    const chunk = buf.toString('utf8');
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) return;          // no complete line yet — keep offset, wait for more
    const complete = chunk.slice(0, lastNl);
    promptReadPosRef.current = pos + Buffer.byteLength(complete, 'utf8') + 1;  // +1 for the \n
    const now = Date.now();
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      let payload: PromptInputPayload;
      try { payload = JSON.parse(line) as PromptInputPayload; } catch { continue; }
      if (firstDrain && typeof payload.ts === 'number' && now - payload.ts > PROMPT_INPUT_FRESH_MS) continue;
      runPromptRef.current(payload);
    }
  }, []);

  // Watch BK1_HOME (the dir, so it works before the file exists) for prompt lines
  // from the VS Code extension. Drain the tail on mount to catch a prompt written
  // just before a relaunch (the extension writes first, then relaunches bk1).
  useEffect(() => {
    drainPromptInput(true);
    let w: ReturnType<typeof watch> | undefined;
    try {
      w = watch(BK1_HOME, (_e, name) => { if (name === 'prompt-input.jsonl') drainPromptInput(false); });
    } catch { /* dir unwatchable — extension prompts won't arrive, but no crash */ }
    return () => { try { w?.close(); } catch {} };
  }, [drainPromptInput]);

  // Inline shell runner — for `!cmd` escapes and terminal-mode lines. Streams
  // stdout+stderr through the live indicator block (so the user sees output
  // as it's produced) and commits the full result as an assistant message
  // when the process exits.
  //
  // 2>&1 in the bash invocation merges stderr into stdout so we only need to
  // pump one stream and ordering is preserved (interleaved reads of two
  // separate streams can race).
  const runInlineShell = useCallback(async (cmd: string) => {
    setLiveShellCmd(cmd);
    setLiveShellText('');
    let buffer = '';
    const ansi = /\x1b\[[\d;?]*[A-Za-z~]/g;
    try {
      const proc = Bun.spawn(['bash', '-c', `${cmd} 2>&1`], {
        cwd: getProjectDir(),
        stdout: 'pipe',
        // Put bash in its own process group so Esc can signal the whole group
        // (bash + dbt + any adapter subprocesses) instead of just bash, which
        // otherwise swallows SIGTERM without forwarding it to its children.
        detached: true,
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
      // Award coins for successful `dbt run/build/test` invocations. Arbitrary
      // shell commands (`ls`, `git status`, etc.) don't count as "real work".
      if (code === 0) {
        const tokens = cmd.trim().split(/\s+/);
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
    // VS Code's xterm.js, or a window resize).
    if (key.ctrl && inputChar === 'l') {
      // Force a full redraw via Ink's own resize path: re-emitting 'resize' makes Ink
      // recalculate layout and reprint (clearTerminal + fullStaticOutput + output when
      // content is taller than the screen), so the conversation history is rewritten
      // rather than left blanked. A bare \x1b[2J would clear the visible frame without
      // telling Ink to repaint, leaving an empty screen until the next state change.
      process.stdout.emit('resize');
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
      if (shellProcRef.current) {
        const pid = shellProcRef.current.pid;
        try { process.kill(-pid, 'SIGINT'); } catch {
          try { shellProcRef.current.kill(); } catch { /* already exited */ }
        }
      }
      // When nothing's running, Esc clears the input — dismisses any open
      // picker (/model, /pet play, /pet feed) and acts as a general
      // "cancel current entry" affordance.
      if (!isRunningRef.current && inputRef.current.length > 0) {
        setInputAndCursor('');
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
          setInputAndCursor(value);
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
      const total = Object.keys(GAMES).length + MULTIPLAYER_GAMES.length;
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

    // /pet playroom arrow cycling — Create / Join entries.
    if ((inputRef.current === '/pet playroom' || inputRef.current.startsWith('/pet playroom '))
        && (key.upArrow || key.downArrow)) {
      const total = PLAYROOM_ACTIONS.length;
      if (key.upArrow) setPetPlayroomIdx(i => (i - 1 + total) % total);
      else             setPetPlayroomIdx(i => (i + 1) % total);
      return;
    }

    // /project arrow cycling — navigate the recents list. Only swallow up/down;
    // Enter falls through to submit() which performs the switch. No-op if the
    // user is typing a path (no recents to cycle in that case is fine).
    if ((inputRef.current === '/project' || inputRef.current.startsWith('/project '))
        && (key.upArrow || key.downArrow)) {
      const total = projectRecents.length;
      if (total > 0) {
        if (key.upArrow) setProjectIdx(i => (i - 1 + total) % total);
        else             setProjectIdx(i => (i + 1) % total);
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
        setInputAndCursor(hist[idx]!);  // cursor → end of recalled prompt
        return;
      }
      // downArrow
      const next = promptHistoryIdxRef.current + 1;
      if (next >= hist.length) {
        promptHistoryIdxRef.current = -1;
        setInputAndCursor('');
      } else {
        promptHistoryIdxRef.current = next;
        setInputAndCursor(hist[next]!);
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
      if (key.tab && !key.shift) {
        const idx = suggestionIndex >= 0 ? suggestionIndex : (suggestions.length === 1 ? 0 : -1);
        if (idx >= 0 && suggestions[idx]) {
          const [cmd, skill] = suggestions[idx]!;
          const needsArg = skill.usage.includes('<');
          setInputAndCursor(`/${cmd}${needsArg ? ' ' : ''}`);  // cursor → end
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
      setInputAndCursor(hist[idx]!);  // cursor → end of recalled prompt
      return;
    }
    if (key.downArrow) {
      const hist = promptHistoryRef.current;
      const cur = promptHistoryIdxRef.current;
      if (cur === -1) return;
      const next = cur + 1;
      if (next >= hist.length) {
        promptHistoryIdxRef.current = -1;
        setInputAndCursor('');
      } else {
        promptHistoryIdxRef.current = next;
        setInputAndCursor(hist[next]!);
      }
      return;
    }

    // Shift+Tab → cycle model (mirror of /model picker, without opening it)
    if (key.tab && key.shift) {
      const next = (modelIdxRef.current + 1) % MODELS.length;
      setModelIdx(next); modelIdxRef.current = next;
      return;
    }

    // Tab with no slash-completion in flight → cycle agent mode
    if (key.tab) {
      const next = nextMode(modeRef.current);
      setMode(next); modeRef.current = next;
      return;
    }

    // Newline insertion (Opt+Enter / Shift+Enter) is handled upstream in the
    // stdin.emit interceptor (see App's setup effect): it appends `\n` to the
    // input and swallows the chunk before Ink sees it, so no key.return arrives
    // here for those keys and they never submit. Plain Enter still submits below.
    // Cursor movement (left/right/home/end + emacs Ctrl-A/E). Bounded to the
    // input; no-op past the edges. These come before the edit branches so an
    // arrow never falls through to character insertion.
    if (key.leftArrow)  { setCursorPos(p => { const n = Math.max(0, p - 1); cursorPosRef.current = n; return n; }); return; }
    if (key.rightArrow) { setCursorPos(p => { const n = Math.min(inputRef.current.length, p + 1); cursorPosRef.current = n; return n; }); return; }
    if (key.ctrl && inputChar === 'a') { cursorPosRef.current = 0; setCursorPos(0); return; }
    if (key.ctrl && inputChar === 'e') { const n = inputRef.current.length; cursorPosRef.current = n; setCursorPos(n); return; }

    if (key.return) {
      if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
        const [cmd, skill] = suggestions[suggestionIndex]!;
        const needsArg = skill.usage.includes('<');
        setInputAndCursor(`/${cmd}${needsArg ? ' ' : ''}`);  // cursor → end
        setSuggestionIndex(-1);
      } else {
        void submit();
      }
    } else if (key.backspace || key.delete) {
      // Delete the char immediately before the cursor; cursor retreats by one.
      const cur = inputRef.current;
      const pos = cursorPosRef.current;
      if (pos === 0) return;
      setInputAndCursor(cur.slice(0, pos - 1) + cur.slice(pos), pos - 1);
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
      let cleaned = inputChar.replace(/\[[\d;<>?]*[A-Za-z~]/g, '');
      // A chunk that is ONLY line-break bytes is an orphan Enter / Opt+Enter tail
      // (Opt+Enter is \x1b\r and the interceptor above already inserted the \n;
      // the trailing \r can still arrive here split off). Drop it — converting it
      // to a newline is what produced the DOUBLE newline on Opt+Enter.
      if (/^[\r\n]+$/.test(cleaned)) return;
      // Otherwise this is typed text or a PASTE. Keep internal line breaks as real
      // newlines (\r\n and lone \r → \n) so multi-line pastes stay multi-line, and
      // strip every other control byte (a literal \r would break the box border).
      cleaned = cleaned
        .replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x09\x0b-\x1f]/g, '');  // controls except \n (0x0a)
      if (!cleaned) return;
      // Insert at the cursor (not just append) and advance past what we inserted.
      const cur = inputRef.current;
      const pos = cursorPosRef.current;
      setInputAndCursor(cur.slice(0, pos) + cleaned + cur.slice(pos), pos + cleaned.length);
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

  // /history picker — fullscreen takeover, same pattern as /usage below.
  // Selecting a session hydrates messages + LLM history from sessions.db and
  // closes the picker. The hydrated session becomes the active session, so
  // subsequent prompts append to it and the LLM sees full prior context.
  if (historyPickerOpen) {
    return (
      <SessionPicker
        projectPath={getProjectDir()}
        onCancel={() => setHistoryPickerOpen(false)}
        onSelect={(sessionId) => {
          try {
            const loaded = loadSessionMessages(sessionId);
            const hydrated: Message[] = loaded.map(m => ({ role: m.role, content: m.content, info: m.info }));
            setMessages(hydrated);
            messagesRef.current = hydrated;
            // Rebuild the LLM-bound history so the next prompt resumes with
            // full prior context. Skips messages flagged info (status lines
            // that aren't real conversation) and the local-greeting reply.
            historyRef.current = hydrated
              .filter(m => !m.info)
              .map(m => ({ role: m.role, content: m.content }));
            currentSessionIdRef.current = sessionId;
          } catch (err) {
            setMessages(prev => [...prev, { role: 'assistant', content: `Failed to load session: ${err instanceof Error ? err.message : String(err)}`, info: true }]);
          }
          setHistoryPickerOpen(false);
        }}
      />
    );
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
        terminalMode={terminalMode}
        usageState={usageStateRef.current}
        onExit={() => setUsageGraphKey(null)}
      />
    );
  }

  // /pet playroom lobby — fullscreen takeover, same pattern as /usage above.
  // The lobby owns the screen + input while open; esc inside the lobby flips
  // `playroom` back to null.
  if (playroom) {
    return (
      <PlayroomLobby
        mode={playroom}
        pet={pet}
        sessionAlias={sessionAlias}
        onSetAlias={setSessionAlias}
        onExit={() => setPlayroom(null)}
        onCycleColor={() => {
          // Cycle through the palette. color now persists (writePetTo keeps
          // it), so the cycled color sticks across launches — savePet writes
          // it through like any other field.
          const current = pet.color ?? DEFAULT_PET_COLOR;
          const idx = PET_COLOR_NAMES.indexOf(current);
          const next = PET_COLOR_NAMES[(idx + 1) % PET_COLOR_NAMES.length]!;
          const updated = { ...pet, color: next };
          petRef.current = updated;
          setPet(updated);
          savePet(updated);
        }}
      />
    );
  }

  // Welcome screen
  if (messages.length === 0) {
    return (
      <Box ref={containerRef} flexDirection="column" paddingTop={1}>
        <Box flexDirection="column" paddingX={2}>
          {WORDMARK.map((line, i) => (
            <WordmarkLine key={i} line={line} color="#B9FECF" />
          ))}
          <Box marginTop={1} flexDirection="column">
            <Box gap={1}>
              <Text bold color="#C0FAD2">bk1</Text>
              <Text color="#5A8060">v{BK1_VERSION}</Text>
            </Box>
            <Text color="#5A8060"><Text color="#C0FAD2">{MODELS[modelIdx]!.label}</Text> · dbt Coding Agent by Keith Fajardo @ Mangrove Digital</Text>
            <Text color="#5A8060">{getProjectDir()}</Text>
          </Box>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {isModelPicker
            ? <ModelPicker currentIdx={modelIdx} />
            : isProjectPicker
              ? <ProjectPicker recents={projectRecents} currentIdx={projectIdx} typed={projectTyped} current={getProjectDir()} />
            : isPetPlayroomPicker
              ? <PlayroomPicker currentIdx={petPlayroomIdx} />
              : isPetPlayPicker
                ? <GamePicker currentIdx={petPlayIdx} />
                : isPetFeedPicker
                  ? <FoodPicker currentIdx={petFeedIdx} balance={pet.coins} />
                  : <Suggestions suggestions={suggestions} selectedIndex={suggestionIndex} input={input} />
          }
          <HRule />
          <IdeContextBar ctx={ideCtx} />
          <InputBar input={input} cursorPos={cursorPos} isRunning={isRunning} mode={mode} modelLabel={MODELS[modelIdx]!.label} maskInput={awaitingAdminKey} terminalMode={terminalMode} />
          <HRule />
          <StatusFooter sessionUsd={sessionUsd} pet={pet} renderHeight={renderHeight} coinToast={coinToast} />
          <HRule />
          <HintBar isRunning={isRunning} terminalMode={terminalMode} />
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
                <Text color="#5A8060">v{BK1_VERSION}</Text>
              </Box>
              <Text color="#5A8060"><Text color="#C0FAD2">{MODELS[modelIdx]!.label}</Text> · dbt Coding Agent by Keith Fajardo @ Mangrove Digital</Text>
              <Text color="#5A8060">{getProjectDir()}</Text>
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
              // Bordered bubble (distinct background) so the user can visually
              // distinguish their own prompts from the agent's left-aligned plain
              // output. Each newline-separated line renders as its own Text inside
              // a column-direction Box. Ink's wrap="wrap" on a single Text element
              // with embedded \n sometimes collapses the newlines when the
              // parent Box has a fixed width — splitting + flexDirection=column
              // sidesteps that path entirely.
              //
              // Width matches the input box (InputBar): cols-5, the same
              // resize-safe margin HRule uses, so the prompt history and the live
              // input box line up at one consistent width. Both sit inside a
              // paddingX={2} wrapper, so cols-5 spans identically. (No longer
              // right-aligned — at full width that's a no-op.) Lines longer than
              // the box wrap inside it.
              const cols = process.stdout.columns ?? 80;
              const bubbleLines = msg.content.split('\n');
              const boxWidth = Math.max(20, cols - 5);
              return (
                <Box borderStyle="round" borderColor="#6B5E8C" paddingX={1} width={boxWidth} flexDirection="column">
                  {bubbleLines.map((line, j) => (
                    <Text key={j} backgroundColor="#2E2940" color="#D8CFEF" wrap="wrap">{line || ' '}</Text>
                  ))}
                </Box>
              );
            })() : msg.info ? (
              <Text color="#5A8060">{msg.content}</Text>
            ) : (
              <>
                <RichMessage text={msg.content} />
                {msg.tokens && <TokenBadge tokens={msg.tokens} />}
              </>
            )}
          </Box>
        )}
      </Static>

      {/* While the window is being resized, collapse the live frame to two rows
          (input + compact status). A tall live frame is what ghosts on resize: the
          terminal reflows its rows and Ink's line tracking desyncs. Two rows can't
          wrap-scroll, so there's nothing to ghost. The full frame (pet sprite, rules,
          hints, live-stream) repaints once `resizing` clears on settle. */}
      {resizing ? (
        <Box flexDirection="column" paddingX={2}>
          <InputBar input={input} cursorPos={cursorPos} isRunning={isRunning} mode={mode} modelLabel={MODELS[modelIdx]!.label} maskInput={awaitingAdminKey} terminalMode={terminalMode} collapsed />
          <Text color="#5A8060">resizing…</Text>
        </Box>
      ) : (
        <>
          <Box flexDirection="column" paddingX={2}>
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

          {!confirmPrompt && (isModelPicker
            ? <ModelPicker currentIdx={modelIdx} />
            : isProjectPicker
              ? <ProjectPicker recents={projectRecents} currentIdx={projectIdx} typed={projectTyped} current={getProjectDir()} />
            : isPetPlayroomPicker
              ? <PlayroomPicker currentIdx={petPlayroomIdx} />
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
            : <InputBar input={input} cursorPos={cursorPos} isRunning={isRunning} mode={mode} modelLabel={MODELS[modelIdx]!.label} maskInput={awaitingAdminKey} terminalMode={terminalMode} />
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
          <HintBar isRunning={isRunning} terminalMode={terminalMode} />
        </>
      )}
    </Box>
  );
}

// Backstop for a pty that breaks mid-frame. When the terminal is yanked out
// from under us a write can fault before the stdin-EOF / SIGHUP handlers above
// get a turn — surfacing as an EIO/EPIPE stream error or the null-deref Ink
// throws writing to a dead stdout. Either way the terminal is already gone, so
// swallow it and exit cleanly: no crash report, no orphan. Genuine logic errors
// (terminal still live) crash as usual so bugs stay visible. The 'exit' handler
// registered in AppShell restores the terminal modes on the way out.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  const code = err?.code;
  const terminalGone = process.stdin.readable === false || process.stdout.destroyed || process.stdout.writableEnded;
  if (terminalGone || code === 'EIO' || code === 'EPIPE' || code === 'ENXIO' || code === 'EBADF') {
    process.exit(0);
  }
  throw err;
});

render(<AppShell />);
