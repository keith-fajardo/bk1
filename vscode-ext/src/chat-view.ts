import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const PET_FILE = path.join(os.homedir(), '.bk1', 'pet.json');

interface PetState {
  name: string | null;
  color?: string;
  hunger: number;
  happiness: number;
  energy: number;
  coins: number;
  xp: number;
  sleeping_until?: string;
  eating_until?: string;
  born_at: string;
}

function readPetState(): PetState | null {
  try {
    return JSON.parse(fs.readFileSync(PET_FILE, 'utf8')) as PetState;
  } catch {
    return null;
  }
}

function petColorHex(pet: PetState): string {
  const palette: Record<string, string> = {
    green: '#9FE749', pink: '#FF8FB1', blue: '#6FCFFF',
    yellow: '#FFD93D', purple: '#C77DFF', orange: '#FF9A3C',
  };
  return palette[pet.color ?? 'green'] ?? '#9FE749';
}

function petMood(pet: PetState, now: Date): string {
  if (pet.sleeping_until && new Date(pet.sleeping_until) > now) return 'sleeping';
  if (pet.hunger >= 80) return 'hungry';
  if (pet.happiness <= 30) return 'sad';
  if (pet.energy <= 30) return 'sleepy';
  return 'happy';
}

function nonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// WebviewViewProvider
// ---------------------------------------------------------------------------

export class Bk1ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'bk1.chat';

  private view?: vscode.WebviewView;
  private pollTimer?: NodeJS.Timeout;
  private getTerminal: () => vscode.Terminal | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    getTerminal: () => vscode.Terminal | undefined,
  ) {
    this.getTerminal = getTerminal;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));

    // Send initial pet state and then poll every 2s
    this.sendPetState();
    this.pollTimer = setInterval(() => this.sendPetState(), 2000);

    webviewView.onDidDispose(() => {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    });
  }

  private sendPetState() {
    if (!this.view) return;
    const pet = readPetState();
    if (!pet) return;
    const now = new Date();
    const color = petColorHex(pet);
    const mood = petMood(pet, now);
    const isSleeping = mood === 'sleeping';
    const isEating = !!pet.eating_until && new Date(pet.eating_until) > now;
    void this.view.webview.postMessage({ type: 'petState', color, mood, isSleeping, isEating, pet });
  }

  // Signal the webview that bk1 has finished responding.
  signalDone() {
    void this.view?.webview.postMessage({ type: 'done' });
  }

  private handleMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'submit': {
        const text = (msg.text as string) ?? '';
        const files = (msg.files as { name: string; content: string; fileType: string }[]) ?? [];
        const model = (msg.model as string) ?? '';
        const thinking = (msg.thinking as boolean) ?? false;
        this.submit(text, files, model, thinking);
        break;
      }
      case 'modelChange':
        // Inform user to change model in the bk1 terminal; could wire key sequence in future.
        break;
      case 'openTerminal':
        void vscode.commands.executeCommand('bk1.open');
        break;
    }
  }

  private submit(
    text: string,
    files: { name: string; content: string; fileType: string }[],
    _model: string,
    _thinking: boolean,
  ) {
    const terminal = this.getTerminal();
    if (!terminal) {
      void vscode.window.showWarningMessage('bk1: open the terminal first (click "Open bk1" in the Status panel).');
      void this.view?.webview.postMessage({ type: 'error', message: 'bk1 terminal is not open. Click "Open bk1" first.' });
      return;
    }

    // Build the full message: prepend attached file contents.
    const parts: string[] = [];
    for (const f of files) {
      if (f.fileType.startsWith('image/')) {
        // Write image to temp file and reference it
        const tmpDir = os.tmpdir();
        const tmpPath = path.join(tmpDir, `bk1-upload-${Date.now()}-${f.name}`);
        try {
          const base64 = f.content.replace(/^data:[^,]+,/, '');
          fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
          parts.push(`[Attached image: ${tmpPath}]`);
        } catch {
          parts.push(`[Image attachment failed: ${f.name}]`);
        }
      } else {
        parts.push(`[Attached file: ${f.name}]\n${f.content}`);
      }
    }
    if (text.trim()) parts.push(text.trim());

    const fullMessage = parts.join('\n\n');
    if (!fullMessage) return;

    // sendText(text, true) appends Enter — submit the message.
    terminal.sendText(fullMessage, true);
    terminal.show(true); // reveal without stealing focus from panel
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const n = nonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
      `img-src data:`,
    ].join('; ');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0; padding: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--vscode-sideBar-background, #1e1e1e);
    color: var(--vscode-foreground, #cccccc);
    font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: 13px;
    overflow: hidden;
  }

  /* ── Message list ─────────────────────────────────────────────── */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 10px 10px 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    scroll-behavior: smooth;
  }

  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, #424242);
    border-radius: 2px;
  }

  .msg {
    max-width: 88%;
    padding: 7px 11px;
    border-radius: 10px;
    line-height: 1.45;
    word-break: break-word;
    white-space: pre-wrap;
    font-size: 12.5px;
  }

  .msg-user {
    align-self: flex-end;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    border-bottom-right-radius: 3px;
  }

  .msg-system {
    align-self: flex-start;
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--vscode-descriptionForeground, #9d9d9d);
    border-bottom-left-radius: 3px;
    font-style: italic;
    font-size: 11.5px;
  }

  .msg-error {
    align-self: center;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-inputValidation-errorForeground, #f48771);
    border-radius: 6px;
    font-size: 11.5px;
    text-align: center;
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground, #666);
    gap: 6px;
    text-align: center;
    padding: 24px 16px;
  }

  .empty-icon {
    font-size: 28px;
    margin-bottom: 4px;
  }

  .empty-hint {
    font-size: 11px;
    opacity: 0.7;
  }

  /* ── Input area ───────────────────────────────────────────────── */
  #input-area {
    border-top: 1px solid var(--vscode-panel-border, #2d2d2d);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--vscode-sideBar-background, #1e1e1e);
  }

  /* Row: pet sprite + textarea */
  #input-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }

  #pet-wrap {
    flex-shrink: 0;
    display: flex;
    align-items: flex-end;
    padding-bottom: 2px;
  }

  #pet-canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }

  .textarea-box {
    flex: 1;
    position: relative;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 8px;
    background: var(--vscode-input-background, #2d2d2d);
    transition: border-color 0.15s;
    overflow: hidden;
  }

  .textarea-box:focus-within {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  #input {
    width: 100%;
    min-height: 36px;
    max-height: 180px;
    padding: 8px 36px 8px 11px;
    background: transparent;
    color: var(--vscode-input-foreground, #cccccc);
    border: none;
    outline: none;
    resize: none;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.45;
    overflow-y: auto;
    display: block;
  }

  #input::placeholder {
    color: var(--vscode-input-placeholderForeground, #5a5a5a);
  }

  #input::-webkit-scrollbar { width: 3px; }
  #input::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, #424242);
    border-radius: 2px;
  }

  #attach-btn {
    position: absolute;
    right: 7px;
    bottom: 7px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 3px;
    opacity: 0.5;
    line-height: 1;
    color: var(--vscode-foreground, #ccc);
    transition: opacity 0.15s;
  }

  #attach-btn:hover { opacity: 1; }

  #file-input { display: none; }

  /* Row: toolbar */
  #toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  #model-select {
    background: var(--vscode-dropdown-background, #2d2d2d);
    color: var(--vscode-dropdown-foreground, #cccccc);
    border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
    border-radius: 4px;
    padding: 3px 5px;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
  }

  #thinking-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
  }

  #thinking-label input { cursor: pointer; margin: 0; }

  #attached-list {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    min-width: 0;
  }

  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--vscode-badge-background, #3a3d41);
    color: var(--vscode-badge-foreground, #cccccc);
    border-radius: 10px;
    padding: 1px 8px 1px 8px;
    font-size: 10.5px;
    max-width: 120px;
    overflow: hidden;
  }

  .file-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-chip button {
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    font-size: 11px;
    padding: 0 0 0 2px;
    opacity: 0.65;
    line-height: 1;
    flex-shrink: 0;
  }

  .file-chip button:hover { opacity: 1; }

  #submit-btn {
    margin-left: auto;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    border: none;
    border-radius: 5px;
    padding: 4px 12px;
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.12s;
  }

  #submit-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  #submit-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  /* Spinner shown while waiting for bk1 */
  .dots::after {
    content: '';
    animation: dots 1.4s steps(4, end) infinite;
  }
  @keyframes dots {
    0%   { content: ''; }
    25%  { content: '.'; }
    50%  { content: '..'; }
    75%  { content: '...'; }
    100% { content: ''; }
  }
</style>
</head>
<body>

<div id="messages">
  <div class="empty-state" id="empty">
    <div class="empty-icon">🌿</div>
    <div>Chat with bk1</div>
    <div class="empty-hint">Messages are sent to the bk1 terminal.<br>Open a dbt project first.</div>
  </div>
</div>

<div id="input-area">
  <div id="input-row">
    <div id="pet-wrap">
      <canvas id="pet-canvas" width="72" height="24" title="Motchi"></canvas>
    </div>
    <div class="textarea-box">
      <textarea id="input"
        placeholder="Message bk1… (Enter to send · Shift+Enter for newline)"
        rows="1"
        spellcheck="false"
      ></textarea>
      <button id="attach-btn" title="Attach file or image">📎</button>
      <input type="file" id="file-input" multiple
        accept=".sql,.yml,.yaml,.md,.txt,.json,.py,.csv,.png,.jpg,.jpeg,.gif,.webp">
    </div>
  </div>

  <div id="toolbar">
    <select id="model-select" title="Model (also change in bk1 terminal with the model picker)">
      <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
      <option value="claude-sonnet-4-6" selected>Sonnet 4.6</option>
      <option value="claude-opus-4-8">Opus 4.8</option>
    </select>
    <label id="thinking-label" title="Extended thinking (toggle in bk1 with /adaptive)">
      <input type="checkbox" id="thinking-toggle">
      thinking
    </label>
    <div id="attached-list"></div>
    <button id="submit-btn">Send ↵</button>
  </div>
</div>

<script nonce="${n}">
(function () {
  'use strict';

  const vscode    = acquireVsCodeApi();
  const messages  = document.getElementById('messages');
  const empty     = document.getElementById('empty');
  const inputEl   = document.getElementById('input');
  const submitBtn = document.getElementById('submit-btn');
  const fileInput = document.getElementById('file-input');
  const attachBtn = document.getElementById('attach-btn');
  const modelSel  = document.getElementById('model-select');
  const thinkChk  = document.getElementById('thinking-toggle');
  const chipList  = document.getElementById('attached-list');
  const canvas    = document.getElementById('pet-canvas');
  const ctx       = canvas.getContext('2d');

  // ── State ────────────────────────────────────────────────────────
  let pendingFiles = [];   // { name, content, fileType }
  let responding   = false;

  // ── Auto-resize textarea ─────────────────────────────────────────
  function resizeInput() {
    inputEl.style.height = 'auto';
    const h = Math.min(inputEl.scrollHeight, 180);
    inputEl.style.height = h + 'px';
  }
  inputEl.addEventListener('input', resizeInput);

  // ── Key handling ─────────────────────────────────────────────────
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
    // Shift+Enter inserts newline naturally (default textarea behaviour).
    // Arrow keys and cursor movement work natively in textarea.
  });

  // ── Submit ───────────────────────────────────────────────────────
  submitBtn.addEventListener('click', doSubmit);

  function doSubmit() {
    const text = inputEl.value;
    if (!text.trim() && pendingFiles.length === 0) return;
    if (responding) return;

    // Echo user message
    removeEmpty();
    addMessage('user', text.trim() || '[files attached]');
    addMessage('system', '​responding', true); // zero-width space prefix flags it

    vscode.postMessage({
      type:     'submit',
      text:     text,
      model:    modelSel.value,
      thinking: thinkChk.checked,
      files:    pendingFiles.slice(),
    });

    inputEl.value = '';
    resizeInput();
    clearFiles();
    responding = true;
    submitBtn.disabled = true;
  }

  // ── Messages ─────────────────────────────────────────────────────
  function removeEmpty() {
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
  }

  function addMessage(cls, text, spinner) {
    const d = document.createElement('div');
    d.className = 'msg msg-' + cls;
    d.textContent = text;
    if (spinner) d.classList.add('dots');
    messages.appendChild(d);
    messages.scrollTop = messages.scrollHeight;
    return d;
  }

  // ── Messages from extension ───────────────────────────────────────
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.type === 'done') {
      // Remove the "responding…" bubble
      const spinner = messages.querySelector('.dots');
      if (spinner) spinner.parentNode.removeChild(spinner);
      responding = false;
      submitBtn.disabled = false;
    } else if (msg.type === 'error') {
      const spinner = messages.querySelector('.dots');
      if (spinner) spinner.parentNode.removeChild(spinner);
      addMessage('error', msg.message);
      responding = false;
      submitBtn.disabled = false;
    } else if (msg.type === 'petState') {
      drawPet(msg);
    }
  });

  // ── File attachment ───────────────────────────────────────────────
  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    for (const f of files) {
      const content = await readFile(f);
      pendingFiles.push({ name: f.name, content, fileType: f.type });
    }
    fileInput.value = '';
    renderChips();
  });

  function readFile(f) {
    return new Promise((resolve) => {
      const r = new FileReader();
      if (f.type.startsWith('image/')) {
        r.onload = (e) => resolve(e.target.result);
        r.readAsDataURL(f);
      } else {
        r.onload = (e) => resolve(e.target.result);
        r.readAsText(f);
      }
    });
  }

  function renderChips() {
    chipList.innerHTML = '';
    pendingFiles.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      const sp = document.createElement('span');
      sp.textContent = f.name;
      const btn = document.createElement('button');
      btn.textContent = '×';
      btn.title = 'Remove';
      btn.addEventListener('click', () => {
        pendingFiles.splice(i, 1);
        renderChips();
      });
      chip.appendChild(sp);
      chip.appendChild(btn);
      chipList.appendChild(chip);
    });
  }

  function clearFiles() {
    pendingFiles = [];
    renderChips();
  }

  // ── Model change ─────────────────────────────────────────────────
  modelSel.addEventListener('change', () => {
    vscode.postMessage({ type: 'modelChange', model: modelSel.value });
  });

  // ── Pet sprite ───────────────────────────────────────────────────
  // Sprite format: 9-col × 3-row terminal cells mapped to canvas.
  // Each terminal cell → CELL_W × CELL_H px canvas rect.
  const CELL_W = 8, CELL_H = 8;

  // Cell type → { top: color|null, bottom: color|null }
  // null = transparent (skip fill)
  const EYE  = '#000000';
  const BLINK = '#FCD34D';

  function cellColors(ch, body) {
    switch (ch) {
      case 'B': return { top: body,  bot: body  };
      case 'V': return { top: EYE,   bot: body  }; // eye top half
      case 'M': return { top: body,  bot: EYE   }; // eye bottom half
      case 'Y': return { top: BLINK, bot: body  }; // blink eye
      case 'H': return { top: body,  bot: body, line: true }; // closed-eye dash
      case 'L': return { top: null,  bot: body  };
      case 'U': return { top: body,  bot: null  };
      case ' ': return { top: null,  bot: null  };
      default:  return { top: body,  bot: body  }; // W, T, ), S, etc.
    }
  }

  function drawFrame(rows, body) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    rows.forEach((row, ri) => {
      [...row].forEach((ch, ci) => {
        const x = ci * CELL_W;
        const y = ri * CELL_H;
        const { top, bot, line } = cellColors(ch, body);
        const half = CELL_H / 2;
        if (top)  { ctx.fillStyle = top; ctx.fillRect(x, y, CELL_W, half); }
        if (bot)  { ctx.fillStyle = bot; ctx.fillRect(x, y + half, CELL_W, half); }
        if (line) {
          // Thin 1px horizontal closed-eye line centred in cell
          ctx.fillStyle = EYE;
          ctx.fillRect(x, y + half - 1, CELL_W, 2);
        }
      });
    });
  }

  // Sprite rows (stripped sentinels, stripped V-cell eyes so we can pick variant)
  const NORMAL = ['BBBBBBBBB', 'BBVBBBVBB', 'BBBBBBBBB'];
  const SLEEP  = ['BBBBBBBBB', 'BHHBBBHHB', 'BBBBBBBBB'];
  const EAT_A  = ['BBBBBBBBB', 'BBVBBBVBB', 'BBB)WBBBB'];
  const EAT_B  = ['BBBBBBBBB', 'BBVBBBVBB', 'BBB)TBBBB'];
  const LOOK_L = ['BBBBBBBBB', 'BVBBBVBBB', 'BBBBBBBBB'];
  const LOOK_R = ['BBBBBBBBB', 'BBBVBBBVB', 'BBBBBBBBB'];
  const LOOK_U = ['BBMBBBMBB', 'BBBBBBBBB', 'BBBBBBBBB'];
  const LOOK_D = ['BBBBBBBBB', 'BBMBBBMBB', 'BBBBBBBBB'];

  let currentBody = '#9FE749';
  let eatFrame    = 0;
  let eatTimer    = null;
  let eyeDir      = 'normal';

  // Mouse tracking — eyes follow the cursor over the canvas
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const w  = rect.width, h = rect.height;
    const dx = cx - w / 2, dy = cy - h / 2;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx < 4 && ady < 4)     eyeDir = 'normal';
    else if (ady > adx * 1.5)   eyeDir = dy < 0 ? 'up'   : 'down';
    else if (adx > ady * 1.5)   eyeDir = dx < 0 ? 'left' : 'right';
    else if (dx < 0 && dy < 0)  eyeDir = 'up';
    else if (dx > 0 && dy < 0)  eyeDir = 'up';
    else                         eyeDir = 'down';
    refresh();
  });

  canvas.addEventListener('mouseleave', () => { eyeDir = 'normal'; refresh(); });

  function spriteFor(mood, eating) {
    if (mood === 'sleeping') return SLEEP;
    if (eating) return eatFrame % 2 === 0 ? EAT_A : EAT_B;
    switch (eyeDir) {
      case 'left':  return LOOK_L;
      case 'right': return LOOK_R;
      case 'up':    return LOOK_U;
      case 'down':  return LOOK_D;
      default:      return NORMAL;
    }
  }

  let currentMood    = 'happy';
  let currentEating  = false;

  function refresh() {
    drawFrame(spriteFor(currentMood, currentEating), currentBody);
  }

  function drawPet(msg) {
    currentBody   = msg.color || '#9FE749';
    currentMood   = msg.mood  || 'happy';
    currentEating = !!msg.isEating;

    if (eatTimer) { clearInterval(eatTimer); eatTimer = null; }
    if (currentEating) {
      eatTimer = setInterval(() => { eatFrame++; refresh(); }, 300);
    }
    refresh();
  }

  // Initial render with default color
  drawFrame(NORMAL, '#9FE749');

  // Focus input on load
  inputEl.focus();
})();
</script>
</body>
</html>`;
  }
}
