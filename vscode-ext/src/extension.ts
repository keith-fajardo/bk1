// bk1 IDE Context — companion VS Code extension.
//
// Watches the active editor and the user's selection inside it, and writes a
// debounced snapshot to ~/.bk1/ide-context.json on every change. The bk1 TUI
// reads that file at the start of each turn and (if recent) injects the file
// path + selection as a <system-reminder> in the user message, mirroring the
// way Claude Code surfaces <ide_opened_file> / <ide_selection> tags.
//
// Design notes:
//   - The handshake is intentionally a flat JSON file, not an IPC socket.
//     File-on-disk is the lowest-friction protocol that survives editor
//     reloads, terminal restarts, and crashed processes — there's nothing to
//     reconnect to.
//   - Writes are debounced ~200 ms so dragging a selection doesn't flood disk
//     I/O. The bk1 side checks mtime to decide whether the snapshot is fresh
//     enough to inject (currently a 10 s window), so we don't need a separate
//     "stale" marker.
//   - The file is rewritten atomically (temp + rename) so a partial read on
//     the bk1 side never sees a half-written JSON blob.
//   - Untitled / non-file documents (output panes, scratch buffers) are
//     reported with file_path = null so bk1 can distinguish "no useful
//     context" from "stale snapshot."

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONTEXT_DIR  = path.join(os.homedir(), '.bk1');
const CONTEXT_FILE = path.join(CONTEXT_DIR, 'ide-context.json');
const DEBOUNCE_MS  = 200;
// Cap the selection payload — pasting a 10MB document into the prompt would
// blow up bk1's context window for no benefit. Truncated selections are still
// useful as a "user is looking at roughly here" signal.
const MAX_SELECTION_BYTES = 8_000;

interface IdeContext {
  file_path:            string | null;
  language:             string | null;
  has_selection:        boolean;
  selection_start_line: number | null;   // 1-indexed, inclusive
  selection_end_line:   number | null;   // 1-indexed, inclusive
  selection_text:       string | null;
  selection_truncated:  boolean;
  updated_at:           string;          // ISO 8601
}

let writeTimer: NodeJS.Timeout | undefined;

function snapshot(): IdeContext {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return {
      file_path:            null,
      language:             null,
      has_selection:        false,
      selection_start_line: null,
      selection_end_line:   null,
      selection_text:       null,
      selection_truncated:  false,
      updated_at:           new Date().toISOString(),
    };
  }
  const doc        = editor.document;
  const sel        = editor.selection;
  const hasSel     = !sel.isEmpty;
  const rawText    = hasSel ? doc.getText(sel) : null;
  const truncated  = rawText !== null && rawText.length > MAX_SELECTION_BYTES;
  const text       = truncated ? rawText!.slice(0, MAX_SELECTION_BYTES) : rawText;
  return {
    file_path:            doc.uri.scheme === 'file' ? doc.uri.fsPath : null,
    language:             doc.languageId,
    has_selection:        hasSel,
    selection_start_line: hasSel ? sel.start.line + 1 : null,
    selection_end_line:   hasSel ? sel.end.line   + 1 : null,
    selection_text:       text,
    selection_truncated:  truncated,
    updated_at:           new Date().toISOString(),
  };
}

function writeNow() {
  const ctx = snapshot();
  try {
    fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    // Atomic write: stage to a sibling temp file, then rename. fs.renameSync
    // is atomic on the same filesystem on macOS and Linux.
    const tmp = `${CONTEXT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ctx, null, 2), 'utf8');
    fs.renameSync(tmp, CONTEXT_FILE);
  } catch (err) {
    // Best-effort — never disrupt the editor if the disk write fails.
    console.error('[bk1-context] failed to write ide-context.json:', err);
  }
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(writeNow, DEBOUNCE_MS);
}

export function activate(context: vscode.ExtensionContext) {
  // Seed the file immediately so bk1 has *something* to read on first turn,
  // even if the user hasn't interacted with the editor yet.
  writeNow();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(scheduleWrite),
    vscode.window.onDidChangeTextEditorSelection(scheduleWrite),
    // When the user closes every editor, snapshot() returns the "no editor"
    // shape — bk1 then knows there's no file context to inject.
    vscode.workspace.onDidCloseTextDocument(scheduleWrite),
  );
}

export function deactivate() {
  if (writeTimer) clearTimeout(writeTimer);
  // One final flush so the next bk1 turn sees the latest state if the user
  // reloads the window or disables the extension.
  writeNow();
}
