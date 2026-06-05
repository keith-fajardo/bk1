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

function makeNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Shared HTML generator (used by both the editor panel and the sidebar view)
// ---------------------------------------------------------------------------

function buildHtml(
  webview: vscode.Webview,
  mode: 'panel' | 'sidebar',
): string {
  const n = makeNonce();
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `img-src data:`,
  ].join('; ');

  // In panel (editor) mode the sprite and layout can breathe a bit more.
  const cellPx  = mode === 'panel' ? 10 : 8;
  const canvasW  = 9 * cellPx;   // 9 cols
  const canvasH  = 3 * cellPx;   // 3 rows
  const msgPad   = mode === 'panel' ? '12px 14px 8px' : '10px 10px 6px';
  const inputPad = mode === 'panel' ? '10px' : '8px';

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
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-foreground, #cccccc);
    font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: 13px;
    overflow: hidden;
  }

  /* ── Message list ────────────────────────────────────────── */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: ${msgPad};
    display: flex;
    flex-direction: column;
    gap: 8px;
    scroll-behavior: smooth;
  }

  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, #424242);
    border-radius: 2px;
  }

  .msg {
    max-width: 82%;
    padding: 8px 13px;
    border-radius: 12px;
    line-height: 1.5;
    word-break: break-word;
    white-space: pre-wrap;
    font-size: 13px;
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
    font-size: 12px;
    font-style: italic;
  }

  .msg-error {
    align-self: center;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-inputValidation-errorForeground, #f48771);
    border-radius: 8px;
    font-size: 12px;
    text-align: center;
    padding: 6px 12px;
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground, #555);
    gap: 8px;
    text-align: center;
    padding: 32px 20px;
    user-select: none;
  }

  .empty-icon { font-size: 32px; margin-bottom: 2px; }
  .empty-title { font-size: 14px; font-weight: 500; }
  .empty-hint { font-size: 12px; opacity: 0.65; line-height: 1.5; }

  /* ── Floating input area ─────────────────────────────────── */
  #input-area {
    padding: ${inputPad};
    display: flex;
    flex-direction: column;
    gap: 6px;
    /* Floating card style */
    margin: 0 ${mode === 'panel' ? '10px' : '6px'} ${mode === 'panel' ? '10px' : '6px'};
    background: var(--vscode-input-background, #2d2d2d);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.35);
  }

  /* Sprite + textarea row */
  #input-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }

  #pet-wrap {
    flex-shrink: 0;
    padding-bottom: 1px;
  }

  #pet-canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }

  #input {
    flex: 1;
    min-height: 38px;
    max-height: 200px;
    padding: 9px 36px 9px 0;
    background: transparent;
    color: var(--vscode-input-foreground, #cccccc);
    border: none;
    outline: none;
    resize: none;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    overflow-y: auto;
    display: block;
  }

  #input::placeholder { color: var(--vscode-input-placeholderForeground, #555); }
  #input::-webkit-scrollbar { width: 3px; }
  #input::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, #424242);
    border-radius: 2px;
  }

  /* Attach button floated to the right of textarea */
  .input-right {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    padding-bottom: 2px;
  }

  #attach-btn, #submit-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 6px;
    line-height: 1;
    transition: background 0.12s;
  }

  #attach-btn {
    font-size: 15px;
    opacity: 0.5;
    color: var(--vscode-foreground, #ccc);
  }
  #attach-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.07)); }

  #submit-btn {
    font-size: 15px;
    opacity: 0.8;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
  }
  #submit-btn:hover { opacity: 1; filter: brightness(1.1); }
  #submit-btn:disabled { opacity: 0.3; cursor: not-allowed; filter: none; }

  #file-input { display: none; }

  /* Toolbar row */
  #toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
    border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
  }

  #model-select {
    background: transparent;
    color: var(--vscode-descriptionForeground, #888);
    border: none;
    outline: none;
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    padding: 2px 2px;
    -webkit-appearance: none;
    appearance: none;
  }
  #model-select:hover { color: var(--vscode-foreground, #ccc); }

  #thinking-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground, #888);
    cursor: pointer;
    user-select: none;
  }
  #thinking-label:hover { color: var(--vscode-foreground, #ccc); }
  #thinking-label input { cursor: pointer; margin: 0; }

  #attached-list {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }

  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: var(--vscode-badge-background, rgba(255,255,255,0.1));
    color: var(--vscode-badge-foreground, #cccccc);
    border-radius: 8px;
    padding: 1px 8px;
    font-size: 11px;
    max-width: 120px;
  }
  .file-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-chip button {
    background: none; border: none; cursor: pointer; color: inherit;
    font-size: 11px; padding: 0 0 0 2px; opacity: 0.6; line-height: 1;
  }
  .file-chip button:hover { opacity: 1; }

  /* dots animation for the "responding" message */
  .dots::after {
    content: '';
    animation: dotanim 1.2s steps(4, end) infinite;
  }
  @keyframes dotanim {
    0%  { content: ''; }
    25% { content: '.'; }
    50% { content: '..'; }
    75% { content: '...'; }
  }

  /* terminal hint banner */
  #terminal-hint {
    text-align: center;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #555);
    padding: 4px 8px 0;
    user-select: none;
  }
  #terminal-hint a {
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    text-decoration: none;
  }
  #terminal-hint a:hover { text-decoration: underline; }
</style>
</head>
<body>

<div id="messages">
  <div class="empty-state" id="empty">
    <div class="empty-icon">🌿</div>
    <div class="empty-title">Chat with bk1</div>
    <div class="empty-hint">Open a dbt project, then type below.<br>Responses appear in the bk1 terminal.</div>
  </div>
</div>

<div id="terminal-hint">
  bk1 terminal not open — <a id="open-terminal-link">click to open</a>
</div>

<div id="input-area">
  <div id="input-row">
    <div id="pet-wrap">
      <canvas id="pet-canvas"
        width="${canvasW}" height="${canvasH}"
        title="Motchi"></canvas>
    </div>

    <textarea id="input"
      placeholder="Message bk1… (Enter to send · Shift+Enter for newline)"
      rows="1"
      spellcheck="false"
    ></textarea>

    <div class="input-right">
      <button id="attach-btn" title="Attach file or image">📎</button>
      <button id="submit-btn" title="Send (Enter)">↑</button>
    </div>
    <input type="file" id="file-input" multiple
      accept=".sql,.yml,.yaml,.md,.txt,.json,.py,.csv,.png,.jpg,.jpeg,.gif,.webp">
  </div>

  <div id="toolbar">
    <select id="model-select" title="Model">
      <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
      <option value="claude-sonnet-4-6" selected>Sonnet 4.6</option>
      <option value="claude-opus-4-8">Opus 4.8</option>
    </select>
    <label id="thinking-label" title="Extended thinking (/adaptive in bk1)">
      <input type="checkbox" id="thinking-toggle"> thinking
    </label>
    <div id="attached-list"></div>
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
  const termHint  = document.getElementById('terminal-hint');
  const openLink  = document.getElementById('open-terminal-link');
  const ctx2d     = canvas.getContext('2d');

  const CELL_W = ${cellPx}, CELL_H = ${cellPx};
  const EYE = '#000000', BLINK = '#FCD34D';

  let pendingFiles  = [];
  let responding    = false;
  let terminalOpen  = false;

  // ── Terminal hint visibility ──────────────────────────────────
  function setTerminalOpen(open) {
    terminalOpen = open;
    termHint.style.display = open ? 'none' : 'block';
  }
  setTerminalOpen(false);

  openLink.addEventListener('click', () => {
    vscode.postMessage({ type: 'openTerminal' });
  });

  // ── Auto-resize textarea ──────────────────────────────────────
  function resizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }
  inputEl.addEventListener('input', resizeInput);

  // ── Key handling ──────────────────────────────────────────────
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSubmit(); }
    if (e.key === 'Escape' && responding)  { e.preventDefault(); doCancel(); }
  });

  // ESC anywhere in the panel cancels while responding
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && responding) { e.preventDefault(); doCancel(); }
  });

  submitBtn.addEventListener('click', () => {
    if (responding) doCancel();
    else doSubmit();
  });

  // ── Submit ────────────────────────────────────────────────────
  function doSubmit() {
    const text = inputEl.value;
    if (!text.trim() && pendingFiles.length === 0) return;
    if (responding) return;

    removeEmpty();
    addMessage('user', text.trim() || '[files attached]');

    vscode.postMessage({
      type:     'submit',
      text,
      model:    modelSel.value,
      thinking: thinkChk.checked,
      files:    pendingFiles.slice(),
    });

    inputEl.value = '';
    resizeInput();
    clearFiles();
    responding = true;
    submitBtn.disabled = false;
    submitBtn.textContent = '■';
    submitBtn.title = 'Cancel (Esc)';
    submitBtn.style.background = 'var(--vscode-inputValidation-errorBackground, #5a1d1d)';
  }

  // ── Cancel ────────────────────────────────────────────────────
  function doCancel() {
    if (!responding) return;
    vscode.postMessage({ type: 'cancel' });
    responding = false;
    submitBtn.textContent = '↑';
    submitBtn.title = 'Send (Enter)';
    submitBtn.style.background = '';
    addMessage('system', 'cancelled');
  }

  // ── Message helpers ───────────────────────────────────────────
  function removeEmpty() {
    if (empty && empty.parentNode) empty.remove();
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

  // ── Messages from extension ───────────────────────────────────
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'done':
        responding = false;
        submitBtn.textContent = '↑';
        submitBtn.title = 'Send (Enter)';
        submitBtn.style.background = '';
        break;
      case 'error':
        addMessage('error', msg.message);
        responding = false;
        submitBtn.textContent = '↑';
        submitBtn.title = 'Send (Enter)';
        submitBtn.style.background = '';
        break;
      case 'petState':
        drawPet(msg);
        break;
      case 'terminalStatus':
        setTerminalOpen(msg.open);
        break;
    }
  });

  // ── File attachment ───────────────────────────────────────────
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const f of Array.from(fileInput.files || [])) {
      const content = await readFile(f);
      pendingFiles.push({ name: f.name, content, fileType: f.type });
    }
    fileInput.value = '';
    renderChips();
  });

  function readFile(f) {
    return new Promise(resolve => {
      const r = new FileReader();
      if (f.type.startsWith('image/')) {
        r.onload = e => resolve(e.target.result);
        r.readAsDataURL(f);
      } else {
        r.onload = e => resolve(e.target.result);
        r.readAsText(f);
      }
    });
  }

  function renderChips() {
    chipList.innerHTML = '';
    pendingFiles.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.innerHTML = '<span>' + f.name + '</span>';
      const btn = document.createElement('button');
      btn.textContent = '×';
      btn.addEventListener('click', () => { pendingFiles.splice(i, 1); renderChips(); });
      chip.appendChild(btn);
      chipList.appendChild(chip);
    });
  }

  function clearFiles() { pendingFiles = []; renderChips(); }

  // ── Model / thinking ─────────────────────────────────────────
  modelSel.addEventListener('change', () => {
    vscode.postMessage({ type: 'modelChange', model: modelSel.value });
  });
  thinkChk.addEventListener('change', () => {
    vscode.postMessage({ type: 'thinkingToggle', enabled: thinkChk.checked });
  });

  // ── Pet sprite ────────────────────────────────────────────────
  function cellColors(ch, body) {
    switch (ch) {
      case 'B': return { top: body,  bot: body  };
      case 'V': return { top: EYE,   bot: body  };
      case 'M': return { top: body,  bot: EYE   };
      case 'Y': return { top: BLINK, bot: body  };
      case 'H': return { top: body,  bot: body,  line: true };
      case 'L': return { top: null,  bot: body  };
      case 'U': return { top: body,  bot: null  };
      case ' ': return { top: null,  bot: null  };
      default:  return { top: body,  bot: body  };
    }
  }

  function drawFrame(rows, body) {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    const half = CELL_H / 2;
    rows.forEach((row, ri) => {
      [...row].forEach((ch, ci) => {
        const x = ci * CELL_W, y = ri * CELL_H;
        const c = cellColors(ch, body);
        if (c.top)  { ctx2d.fillStyle = c.top;  ctx2d.fillRect(x, y, CELL_W, half); }
        if (c.bot)  { ctx2d.fillStyle = c.bot;  ctx2d.fillRect(x, y + half, CELL_W, half); }
        if (c.line) { ctx2d.fillStyle = EYE;    ctx2d.fillRect(x, y + half - 1, CELL_W, 2); }
      });
    });
  }

  const NORMAL = ['BBBBBBBBB', 'BBVBBBVBB', 'BBBBBBBBB'];
  const SLEEP  = ['BBBBBBBBB', 'BHHBBBHHB', 'BBBBBBBBB'];
  const EAT_A  = ['BBBBBBBBB', 'BBVBBBVBB', 'BBB)WBBBB'];
  const EAT_B  = ['BBBBBBBBB', 'BBVBBBVBB', 'BBB)TBBBB'];
  const LOOK_L = ['BBBBBBBBB', 'BVBBBVBBB', 'BBBBBBBBB'];
  const LOOK_R = ['BBBBBBBBB', 'BBBVBBBVB', 'BBBBBBBBB'];
  const LOOK_U = ['BBMBBBMBB', 'BBBBBBBBB', 'BBBBBBBBB'];
  const LOOK_D = ['BBBBBBBBB', 'BBMBBBMBB', 'BBBBBBBBB'];

  let currentBody  = '#9FE749';
  let currentMood  = 'happy';
  let currentEat   = false;
  let eatFrame     = 0;
  let eatTimer     = null;
  let eyeDir       = 'normal';

  canvas.addEventListener('mousemove', (e) => {
    const r  = canvas.getBoundingClientRect();
    const dx = e.clientX - r.left  - r.width  / 2;
    const dy = e.clientY - r.top   - r.height / 2;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 3 && ay < 3)     eyeDir = 'normal';
    else if (ay > ax * 1.5)   eyeDir = dy < 0 ? 'up'   : 'down';
    else if (ax > ay * 1.5)   eyeDir = dx < 0 ? 'left' : 'right';
    else                      eyeDir = dy < 0 ? 'up'   : 'down';
    refresh();
  });
  canvas.addEventListener('mouseleave', () => { eyeDir = 'normal'; refresh(); });

  function frameFor(mood, eating) {
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

  function refresh() { drawFrame(frameFor(currentMood, currentEat), currentBody); }

  function drawPet(msg) {
    currentBody = msg.color || '#9FE749';
    currentMood = msg.mood  || 'happy';
    currentEat  = !!msg.isEating;
    if (eatTimer) { clearInterval(eatTimer); eatTimer = null; }
    if (currentEat) eatTimer = setInterval(() => { eatFrame++; refresh(); }, 300);
    refresh();
  }

  drawFrame(NORMAL, '#9FE749');
  inputEl.focus();
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Editor panel — opens as a tab with ViewColumn.Beside (Claude Code style)
// ---------------------------------------------------------------------------

export class Bk1ChatPanel {
  static readonly viewType = 'bk1.chatPanel';
  static currentPanel?: Bk1ChatPanel;

  private readonly panel: vscode.WebviewPanel;
  private pollTimer?: NodeJS.Timeout;
  private readonly getTerminal: () => vscode.Terminal | undefined;

  static createOrReveal(
    ctx: vscode.ExtensionContext,
    getTerminal: () => vscode.Terminal | undefined,
  ): Bk1ChatPanel {
    if (Bk1ChatPanel.currentPanel) {
      Bk1ChatPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside, true);
      return Bk1ChatPanel.currentPanel;
    }
    const iconUri = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
    const panel = vscode.window.createWebviewPanel(
      Bk1ChatPanel.viewType,
      'bk1',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [ctx.extensionUri],
      },
    );
    panel.iconPath = iconUri;
    const instance = new Bk1ChatPanel(panel, ctx, getTerminal);
    Bk1ChatPanel.currentPanel = instance;
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    ctx: vscode.ExtensionContext,
    getTerminal: () => vscode.Terminal | undefined,
  ) {
    this.panel       = panel;
    this.getTerminal = getTerminal;

    panel.webview.html = buildHtml(panel.webview, 'panel');
    panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    panel.onDidDispose(() => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      Bk1ChatPanel.currentPanel = undefined;
    });

    this.sendPetState();
    this.pollTimer = setInterval(() => this.sendPetState(), 2000);
  }

  private sendPetState() {
    const pet = readPetState();
    if (!pet) return;
    const now   = new Date();
    const color = petColorHex(pet);
    const mood  = petMood(pet, now);
    void this.panel.webview.postMessage({
      type: 'petState',
      color, mood,
      isSleeping: mood === 'sleeping',
      isEating: !!pet.eating_until && new Date(pet.eating_until) > now,
    });
  }

  /** Notify the webview whether the bk1 terminal is currently running. */
  notifyTerminalStatus(open: boolean) {
    void this.panel.webview.postMessage({ type: 'terminalStatus', open });
  }

  private handleMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'submit': {
        const text    = (msg.text    as string) ?? '';
        const files   = (msg.files   as { name: string; content: string; fileType: string }[]) ?? [];
        this.submit(text, files);
        break;
      }
      case 'cancel':
        // Send Ctrl+C to bk1 to interrupt the running agent loop.
        this.getTerminal()?.sendText('\x03', false);
        break;
      case 'openTerminal':
        void vscode.commands.executeCommand('bk1.open');
        break;
    }
  }

  private submit(
    text: string,
    files: { name: string; content: string; fileType: string }[],
  ) {
    const terminal = this.getTerminal();
    if (!terminal) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: 'bk1 terminal is not running — click the link above to open it.',
      });
      return;
    }

    const parts: string[] = [];
    for (const f of files) {
      if (f.fileType.startsWith('image/')) {
        try {
          const tmpPath = path.join(os.tmpdir(), `bk1-${Date.now()}-${f.name}`);
          const b64 = f.content.replace(/^data:[^,]+,/, '');
          fs.writeFileSync(tmpPath, Buffer.from(b64, 'base64'));
          parts.push(`[Attached image: ${tmpPath}]`);
        } catch {
          parts.push(`[Image attachment failed: ${f.name}]`);
        }
      } else {
        parts.push(`[Attached file: ${f.name}]\n${f.content}`);
      }
    }
    if (text.trim()) parts.push(text.trim());
    const full = parts.join('\n\n');
    if (!full) return;

    terminal.sendText(full, true);
    // show terminal briefly so user sees the response, but don't steal focus
    terminal.show(true);
    // signal done immediately — we can't detect when bk1 finishes yet
    void this.panel.webview.postMessage({ type: 'done' });
  }
}

// ---------------------------------------------------------------------------
// Sidebar view — small preview in the activity-bar panel
// ---------------------------------------------------------------------------

export class Bk1ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'bk1.chat';

  private view?: vscode.WebviewView;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly getTerminal: () => vscode.Terminal | undefined,
  ) {}

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
    webviewView.webview.html = buildHtml(webviewView.webview, 'sidebar');
    webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));

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
    const now   = new Date();
    const color = petColorHex(pet);
    const mood  = petMood(pet, now);
    void this.view.webview.postMessage({
      type: 'petState', color, mood,
      isSleeping: mood === 'sleeping',
      isEating: !!pet.eating_until && new Date(pet.eating_until) > now,
    });
  }

  private handleMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'submit': {
        const text  = (msg.text  as string) ?? '';
        const files = (msg.files as { name: string; content: string; fileType: string }[]) ?? [];
        this.submit(text, files);
        break;
      }
      case 'cancel':
        this.getTerminal()?.sendText('\x03', false);
        break;
      case 'openTerminal':
        void vscode.commands.executeCommand('bk1.open');
        break;
    }
  }

  private submit(text: string, files: { name: string; content: string; fileType: string }[]) {
    const terminal = this.getTerminal();
    if (!terminal) {
      void this.view?.webview.postMessage({ type: 'error', message: 'bk1 terminal is not open.' });
      return;
    }
    const parts: string[] = [];
    for (const f of files) {
      if (f.fileType.startsWith('image/')) {
        parts.push(`[Image: ${f.name}]`);
      } else {
        parts.push(`[File: ${f.name}]\n${f.content}`);
      }
    }
    if (text.trim()) parts.push(text.trim());
    const full = parts.join('\n\n');
    if (!full) return;
    terminal.sendText(full, true);
    terminal.show(true);
    void this.view?.webview.postMessage({ type: 'done' });
  }
}
