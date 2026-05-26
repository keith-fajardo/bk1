// Companion to the bk1-context VS Code extension. Reads the file the extension
// streams to ~/.bk1/ide-context.json and formats it as a <system-reminder> block
// for injection into the user's prompt — same shape Claude Code uses for its
// <ide_opened_file> / <ide_selection> tags so the model recognises them as
// ambient editor context rather than instructions.
//
// Freshness: we only inject if the file's mtime is within IDE_CONTEXT_TTL_MS.
// Otherwise the user is probably running bk1 standalone (extension not
// installed, or VS Code closed) and the snapshot is stale or irrelevant.

import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const IDE_CONTEXT_PATH   = join(homedir(), '.bk1', 'ide-context.json');
const IDE_CONTEXT_TTL_MS        = 15_000;

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

export function readIdeContextBlock(now: Date = new Date()): string | null {
  if (!existsSync(IDE_CONTEXT_PATH)) return null;
  let ctx: IdeContext;
  try {
    const stat = statSync(IDE_CONTEXT_PATH);
    if (now.getTime() - stat.mtimeMs > IDE_CONTEXT_TTL_MS) return null;
    ctx = JSON.parse(readFileSync(IDE_CONTEXT_PATH, 'utf-8')) as IdeContext;
  } catch {
    return null;
  }

  const parts: string[] = [];
  if (ctx.file_path) {
    parts.push(
      `<ide_opened_file>The user opened the file ${ctx.file_path} in the IDE. This may or may not be related to the current task.</ide_opened_file>`,
    );
  }
  if (ctx.has_selection && ctx.selection_text && ctx.file_path && ctx.selection_start_line && ctx.selection_end_line) {
    const truncNote = ctx.selection_truncated ? ' (selection truncated)' : '';
    parts.push(
      `<ide_selection>The user selected lines ${ctx.selection_start_line} to ${ctx.selection_end_line} from ${ctx.file_path}${truncNote}:\n${ctx.selection_text}\n\nThis may or may not be related to the current task.</ide_selection>`,
    );
  }
  if (parts.length === 0) return null;
  return `<system-reminder>\n${parts.join('\n')}\n</system-reminder>`;
}
