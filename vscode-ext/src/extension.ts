import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureBk1 } from './bk1-loader';

const CONTEXT_DIR  = path.join(os.homedir(), '.bk1');
const CONTEXT_FILE = path.join(CONTEXT_DIR, 'ide-context.json');
const DEBOUNCE_MS  = 200;
const MAX_SELECTION_BYTES = 8_000;
const MAX_LOG_ENTRIES = 50;

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
// bk1 terminal (opens as an editor tab, like Claude Code)
// ---------------------------------------------------------------------------

let bk1Terminal: vscode.Terminal | undefined;
let openingBk1 = false;

async function openBk1(ctx: vscode.ExtensionContext) {
  if (bk1Terminal) {
    bk1Terminal.show();
    return;
  }
  // Guard against the user mashing the "Open bk1" button while the first-run
  // download is still in progress — withProgress doesn't queue, so we'd kick
  // off a second download into the same directory.
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

  // viewColumn: Beside opens bk1 in a new editor group to the side of the
  // currently active one (Claude Code-style split layout). Without this,
  // TerminalLocation.Editor alone would put bk1 as a tab in the active group,
  // forcing files and bk1 to share the same column.
  bk1Terminal = vscode.window.createTerminal({
    name: 'bk1',
    shellPath,
    cwd,
    iconPath: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg'),
    location: { viewColumn: vscode.ViewColumn.Beside },
  });

  openingBk1 = false;
  bk1Terminal.show();
}

function stopBk1() {
  bk1Terminal?.dispose();
  bk1Terminal = undefined;
}

// ---------------------------------------------------------------------------
// Status tree view
// ---------------------------------------------------------------------------

class StatusItem extends vscode.TreeItem {
  constructor(label: string, description: string, icon?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class StatusProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;
  private ctx: IdeContext | null = null;

  update(ctx: IdeContext) { this.ctx = ctx; this._onChange.fire(); }
  getTreeItem(el: StatusItem) { return el; }

  getChildren(): StatusItem[] {
    if (!this.ctx) return [];
    const items: StatusItem[] = [];
    const fp = this.ctx.file_path;
    if (fp) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const rel = ws ? path.relative(ws, fp) : path.basename(fp);
      const f = new StatusItem('File', rel, 'file');
      f.tooltip = fp;
      items.push(f);
      if (this.ctx.language) items.push(new StatusItem('Language', this.ctx.language, 'symbol-keyword'));
    } else {
      items.push(new StatusItem('File', 'none', 'file'));
    }
    if (this.ctx.has_selection && this.ctx.selection_start_line && this.ctx.selection_end_line) {
      const r = `L${this.ctx.selection_start_line}–${this.ctx.selection_end_line}`;
      items.push(new StatusItem('Selection', r + (this.ctx.selection_truncated ? ' (truncated)' : ''), 'selection'));
    }
    items.push(new StatusItem('Updated', timeAgo(this.ctx.updated_at), 'clock'));
    return items;
  }
}

// ---------------------------------------------------------------------------
// Activity log tree view
// ---------------------------------------------------------------------------

interface LogEntry { time: Date; event: string; detail: string }

class LogItem extends vscode.TreeItem {
  constructor(entry: LogEntry) {
    super(`${entry.time.toLocaleTimeString()}  ${entry.event}`, vscode.TreeItemCollapsibleState.None);
    this.description = entry.detail;
    this.iconPath = new vscode.ThemeIcon(
      entry.event === 'file opened' ? 'file' :
      entry.event === 'selection'   ? 'selection' :
      entry.event === 'file closed' ? 'close' : 'circle-outline'
    );
  }
}

class LogProvider implements vscode.TreeDataProvider<LogItem> {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;
  private entries: LogEntry[] = [];

  push(event: string, detail: string) {
    this.entries.unshift({ time: new Date(), event, detail });
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.length = MAX_LOG_ENTRIES;
    this._onChange.fire();
  }

  getTreeItem(el: LogItem) { return el; }
  getChildren(): LogItem[] { return this.entries.map(e => new LogItem(e)); }
}

// ---------------------------------------------------------------------------
// IDE context writer (streams to ~/.bk1/ide-context.json)
// ---------------------------------------------------------------------------

let writeTimer: NodeJS.Timeout | undefined;
let statusProvider: StatusProvider;
let logProvider: LogProvider;
let lastFilePath: string | null | undefined;
let lastSelKey: string | undefined;
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

function writeNow() {
  const ctx = snapshot();
  statusProvider.update(ctx);

  const fp = ctx.file_path;
  if (fp !== lastFilePath) {
    if (fp) logProvider.push('file opened', path.basename(fp));
    else if (lastFilePath) logProvider.push('file closed', path.basename(lastFilePath));
    lastFilePath = fp;
    lastSelKey = undefined;
  }
  if (ctx.has_selection && ctx.selection_start_line && ctx.selection_end_line) {
    const sk = `${ctx.selection_start_line}-${ctx.selection_end_line}`;
    if (sk !== lastSelKey) {
      logProvider.push('selection', `L${ctx.selection_start_line}–${ctx.selection_end_line}`);
      lastSelKey = sk;
    }
  }

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

function timeAgo(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 1000)      return 'just now';
  if (d < 60_000)    return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  statusProvider = new StatusProvider();
  logProvider    = new LogProvider();

  // Maintain a context key that's true exactly when bk1's terminal is the
  // active one. The Ctrl+T / Ctrl+L keybindings in package.json are gated on
  // this so they only intercept (and forward bytes 0x14 / 0x0C to bk1) when
  // the user is actually in the bk1 terminal — leaving every other terminal,
  // editor, and panel's Ctrl+T / Ctrl+L behavior unchanged.
  const setFocusContext = (focused: boolean) => {
    void vscode.commands.executeCommand('setContext', 'bk1.terminalFocused', focused);
  };
  setFocusContext(false);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('bk1.status', statusProvider),
    vscode.window.registerTreeDataProvider('bk1.log', logProvider),
    vscode.commands.registerCommand('bk1.open', () => openBk1(context)),
    vscode.commands.registerCommand('bk1.stop', () => stopBk1()),
    vscode.window.onDidCloseTerminal(t => {
      if (t === bk1Terminal) {
        bk1Terminal = undefined;
        setFocusContext(false);
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
}
