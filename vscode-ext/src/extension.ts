import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureBk1 } from './bk1-loader';
import { recordTerminal, forgetTerminal, reapOrphans, isAlive } from './process-registry';
import { Bk1ChatPanel } from './chat-view';

const CONTEXT_DIR        = path.join(os.homedir(), '.bk1');
const CONTEXT_FILE       = path.join(CONTEXT_DIR, 'ide-context.json');
const CHAT_EVENTS_FILE   = path.join(CONTEXT_DIR, 'chat-events.jsonl');
const PROMPT_INPUT_FILE  = path.join(CONTEXT_DIR, 'prompt-input.jsonl');
const DEBOUNCE_MS        = 200;
const MAX_SELECTION_BYTES = 8_000;

// ---------------------------------------------------------------------------
// Chat event file watcher — reads new lines from chat-events.jsonl and
// forwards them to the chat panel webview.
// ---------------------------------------------------------------------------
let chatEventsReadPos = 0;
let chatEventsWatcher: fs.FSWatcher | undefined;

function startChatEventsWatcher() {
  if (chatEventsWatcher) return;
  try {
    // Watch the directory rather than the file so setup succeeds even before
    // bk1 creates chat-events.jsonl (fs.watch on a missing file throws).
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    chatEventsWatcher = fs.watch(CONTEXT_DIR, (_event, filename) => {
      if (filename === 'chat-events.jsonl') flushChatEvents();
    });
  } catch {
    // CONTEXT_DIR inaccessible — events won't forward but won't crash.
  }
}

function flushChatEvents() {
  try {
    const stat = fs.statSync(CHAT_EVENTS_FILE);
    if (stat.size < chatEventsReadPos) chatEventsReadPos = 0; // file was truncated (new session)
    if (stat.size === chatEventsReadPos) return;

    const buf = Buffer.alloc(stat.size - chatEventsReadPos);
    const fd  = fs.openSync(CHAT_EVENTS_FILE, 'r');
    fs.readSync(fd, buf, 0, buf.length, chatEventsReadPos);
    fs.closeSync(fd);
    chatEventsReadPos = stat.size;

    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        chatPanel.sendEvent(event);
      } catch { /* malformed line */ }
    }
  } catch { /* file gone or unreadable */ }
}

interface IdeContext {
  file_path:            string | null;
  language:             string | null;
  has_selection:        boolean;
  selection_start_line: number | null;
  selection_end_line:   number | null;
  selection_text:       string | null;
  selection_truncated:  boolean;
  updated_at:           string;
}

// ---------------------------------------------------------------------------
// bk1 process (runs in the integrated terminal panel at the bottom)
// ---------------------------------------------------------------------------

let bk1Terminal: vscode.Terminal | undefined;
let bk1Pid: number | undefined;
let openingBk1 = false;

// chatPanel is the primary UI — a wide WebviewPanel (editor tab).
// Constructed in activate() before any watcher fires, so never undefined
// when sendEvent/notifyTerminalStatus are reached.
let chatPanel: Bk1ChatPanel;

// True only when the bk1 child PROCESS is actually alive. onDidCloseTerminal
// fires on tab disposal, NOT on process exit, so a crashed/exited bk1 leaves
// bk1Terminal as a live-looking but DEAD handle — the root of the "prompt does
// nothing / spawns a terminal session" bug (sendText to a dead shellPath
// terminal relaunches it). exitStatus flips when the process exits even with the
// tab still open; the PID probe is a belt-and-suspenders check.
function bk1Alive(): boolean {
  if (!bk1Terminal) return false;
  if (bk1Terminal.exitStatus !== undefined) return false;
  if (bk1Pid !== undefined && !isAlive(bk1Pid)) return false;
  return true;
}

// Clear a dead terminal handle (and its tab) so the next openBk1 launches fresh.
function disposeDeadTerminal() {
  if (bk1Pid !== undefined) { forgetTerminal(bk1Pid); bk1Pid = undefined; }
  bk1Terminal?.dispose();
  bk1Terminal = undefined;
}

// Deliver a prompt to bk1 via the append-only prompt-input channel — NOT keystroke
// injection. Write first (so the prompt is durable), then ensure bk1 is running: a
// live bk1's fs.watch drains it; a dead/absent bk1 is relaunched and drains the
// just-written tail on mount (PROMPT_INPUT_FRESH_MS in app.tsx covers the race).
async function deliverPrompt(ctx: vscode.ExtensionContext, line: string) {
  try {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    fs.appendFileSync(PROMPT_INPUT_FILE, line + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`bk1: failed to write prompt — ${msg}`);
    return;
  }
  if (bk1Alive()) return;
  if (bk1Terminal) disposeDeadTerminal();
  await ensureBk1Running(ctx);
}

// Open the wide chat panel (editor tab) and ensure the engine is running.
function revealBk1(ctx: vscode.ExtensionContext) {
  chatPanel.reveal();          // create/reveal the panel; its pre-warm hook also calls ensureBk1Running
  void ensureBk1Running(ctx);
}

// Ensure the bk1 child PROCESS is alive. bk1 is a PTY/TUI app, so it still needs
// a terminal to run — but we create it with hideFromUser, so there's NO visible
// tab or dropdown entry. The webview panel is the only UI; `bk1.show` reveals
// the terminal on demand for debugging. This is UI-free (no panel reveal) so the
// panel's pre-warm hook can call it without looping back into revealBk1.
async function ensureBk1Running(ctx: vscode.ExtensionContext) {
  if (bk1Alive()) {
    chatPanel.notifyTerminalStatus(true);
    return;
  }
  // A lingering dead terminal (process exited, tab not closed) must be cleared
  // before relaunch, or we'd stack a zombie tab and keep a dead handle.
  if (bk1Terminal) disposeDeadTerminal();

  if (openingBk1) return;
  openingBk1 = true;

  let shellPath: string;
  try {
    shellPath = await ensureBk1(ctx);
  } catch (err) {
    openingBk1 = false;
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`bk1: ${msg}`);
    return;
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

  // hideFromUser keeps the engine fully in the background — no terminal tab, no
  // dropdown entry. The user interacts only with the webview panel.
  bk1Terminal = vscode.window.createTerminal({
    name: 'bk1',
    shellPath,
    cwd,
    hideFromUser: true,
    iconPath: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg'),
  });

  openingBk1 = false;
  const term = bk1Terminal;

  void term.processId.then((pid) => {
    if (pid !== undefined && bk1Terminal === term) {
      bk1Pid = pid;
      recordTerminal(pid);
      chatPanel.notifyTerminalStatus(true);
    }
  });
}

// Debug aid: reveal the hidden bk1 terminal so the user can see raw engine output.
function showBk1Terminal() {
  if (bk1Terminal) bk1Terminal.show();
  else void vscode.window.showInformationMessage('bk1 is not running — open bk1 first.');
}

function stopBk1() {
  // Don't trust dispose() alone to take the child down — explicitly signal the
  // tracked PID too. bk1 exits on SIGTERM (see src/app.tsx).
  if (bk1Pid !== undefined) {
    try { process.kill(bk1Pid, 'SIGTERM'); } catch { /* already exited */ }
    forgetTerminal(bk1Pid);
    bk1Pid = undefined;
  }
  bk1Terminal?.dispose();
  bk1Terminal = undefined;
}

// ---------------------------------------------------------------------------
// IDE context writer (streams to ~/.bk1/ide-context.json)
// ---------------------------------------------------------------------------

let writeTimer: NodeJS.Timeout | undefined;
// Tracks the most recent active editor so we can fall back to it when focus
// moves to a non-editor surface (terminal, panel, webview). Without this,
// clicking into the bk1 terminal makes activeTextEditor undefined and the
// snapshot goes null — even though the user's file is still visible on screen.
let lastActiveEditor: vscode.TextEditor | undefined;

function snapshot(): IdeContext {
  const active = vscode.window.activeTextEditor;
  if (active) lastActiveEditor = active;
  // Fall back to the last active editor only if it's still visible (the file
  // tab hasn't been closed). If they closed the file, we genuinely have no
  // editor context — write the null state so stale snapshots don't linger.
  const editor = active
    ?? (lastActiveEditor && vscode.window.visibleTextEditors.includes(lastActiveEditor)
      ? lastActiveEditor
      : undefined);
  if (!editor) {
    lastActiveEditor = undefined;
    return {
      file_path: null, language: null, has_selection: false,
      selection_start_line: null, selection_end_line: null,
      selection_text: null, selection_truncated: false,
      updated_at: new Date().toISOString(),
    };
  }
  const doc     = editor.document;
  const sel     = editor.selection;
  const hasSel  = !sel.isEmpty;
  const rawText = hasSel ? doc.getText(sel) : null;
  const trunc   = rawText !== null && rawText.length > MAX_SELECTION_BYTES;
  const text    = trunc ? rawText!.slice(0, MAX_SELECTION_BYTES) : rawText;
  return {
    file_path:            doc.uri.scheme === 'file' ? doc.uri.fsPath : null,
    language:             doc.languageId,
    has_selection:        hasSel,
    selection_start_line: hasSel ? sel.start.line + 1 : null,
    selection_end_line:   hasSel ? sel.end.line   + 1 : null,
    selection_text:       text,
    selection_truncated:  trunc,
    updated_at:           new Date().toISOString(),
  };
}

// Stream the active file + selection to ~/.bk1/ide-context.json — bk1 reads
// this each turn and injects it as a <system-reminder> (mirrors Claude Code's
// <ide_opened_file>). The chat lives in the webview now; this file is the only
// surface that consumes the snapshot.
function writeNow() {
  const ctx = snapshot();
  try {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    const tmp = `${CONTEXT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ctx, null, 2), 'utf8');
    fs.renameSync(tmp, CONTEXT_FILE);
  } catch (err) {
    console.error('[bk1-context] write failed:', err);
  }
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(writeNow, DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  // Construct the chat panel before the events watcher so a fast first event
  // always has somewhere to land (it buffers until the panel is created).
  // The 4th arg pre-warms bk1: the panel calls it on reveal so bk1 is already
  // mounted and watching prompt-input.jsonl before the user submits — sidesteps
  // the lazy-launch / freshness-gate race that left a prompt undrained and the
  // webview stuck on a silent spinner. It's the UI-free ensureBk1Running (not
  // revealBk1) so the pre-warm hook doesn't loop back into opening the panel.
  chatPanel = new Bk1ChatPanel(
    context,
    () => bk1Terminal,
    (line) => deliverPrompt(context, line),
    () => { void ensureBk1Running(context); },
  );

  // Start the chat-events watcher early so it's ready before the first bk1 session.
  startChatEventsWatcher();

  // Maintain a context key that's true exactly when bk1's terminal is the
  // active one. The Ctrl+T / Ctrl+L keybindings in package.json are gated on
  // this so they only intercept (and forward bytes 0x14 / 0x0C to bk1) when
  // the user is actually in the bk1 terminal — leaving every other terminal,
  // editor, and panel's Ctrl+T / Ctrl+L behavior unchanged.
  const setFocusContext = (focused: boolean) => {
    void vscode.commands.executeCommand('setContext', 'bk1.terminalFocused', focused);
  };
  setFocusContext(false);

  // Kill any bk1 left behind by a prior host that crashed before disposing its
  // terminal. Safe with multiple windows: only PIDs whose owning host is gone
  // (dead, or its PID reused) are reaped (see process-registry.ts).
  void reapOrphans();

  // The activity-bar icon needs a view to attach to. bk1.home is an empty tree
  // (its viewsWelcome shows an "Open bk1" button); when it becomes visible we
  // open the wide editor panel — so clicking the icon lands you straight in bk1.
  const homeProvider: vscode.TreeDataProvider<never> = {
    getTreeItem: el => el,
    getChildren: () => [],
  };
  const homeView = vscode.window.createTreeView('bk1.home', { treeDataProvider: homeProvider });

  context.subscriptions.push(
    homeView,
    homeView.onDidChangeVisibility(e => { if (e.visible) revealBk1(context); }),
    vscode.commands.registerCommand('bk1.open', () => revealBk1(context)),
    vscode.commands.registerCommand('bk1.stop', () => stopBk1()),
    vscode.commands.registerCommand('bk1.show', () => showBk1Terminal()),
    vscode.window.onDidCloseTerminal(t => {
      if (t === bk1Terminal) {
        if (bk1Pid !== undefined) { forgetTerminal(bk1Pid); bk1Pid = undefined; }
        bk1Terminal = undefined;
        setFocusContext(false);
        chatPanel.notifyTerminalStatus(false);
      }
    }),
    vscode.window.onDidChangeActiveTerminal(t => {
      setFocusContext(t !== undefined && t === bk1Terminal);
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      // Active editor changes mean the focus left whatever terminal was
      // active. Clear the bk1-focused state so Ctrl+T / Ctrl+L revert to
      // their default behavior in editors and other panels.
      if (editor) setFocusContext(false);
      scheduleWrite();
    }),
    vscode.window.onDidChangeTextEditorSelection(scheduleWrite),
    vscode.workspace.onDidCloseTextDocument(scheduleWrite),
  );

  writeNow();
}

export function deactivate() {
  if (writeTimer) clearTimeout(writeTimer);
  writeNow();
  stopBk1();
  chatEventsWatcher?.close();
  chatEventsWatcher = undefined;
}
