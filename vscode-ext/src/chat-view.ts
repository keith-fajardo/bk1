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
  try { return JSON.parse(fs.readFileSync(PET_FILE, 'utf8')) as PetState; }
  catch { return null; }
}

function petColorHex(pet: PetState): string {
  const p: Record<string, string> = {
    green: '#9FE749', pink: '#FF8FB1', blue: '#6FCFFF',
    yellow: '#FFD93D', purple: '#C77DFF', orange: '#FF9A3C',
  };
  return p[pet.color ?? 'green'] ?? '#9FE749';
}

function petMood(pet: PetState, now: Date): string {
  if (pet.sleeping_until && new Date(pet.sleeping_until) > now) return 'sleeping';
  if (pet.hunger >= 80)   return 'hungry';
  if (pet.happiness <= 30) return 'sad';
  if (pet.energy <= 30)   return 'sleepy';
  return 'happy';
}

function makeNonce(): string { return crypto.randomBytes(16).toString('hex'); }

// ---------------------------------------------------------------------------
// Shared HTML
// ---------------------------------------------------------------------------

function buildHtml(webview: vscode.Webview, mode: 'panel' | 'sidebar', version: string): string {
  const n      = makeNonce();
  const csp    = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `img-src data:`,
  ].join('; ');

  const cellPx  = mode === 'panel' ? 10 : 8;
  const canvasW = 9 * cellPx;
  const canvasH = 3 * cellPx;

  // Slash commands shown in autocomplete
  const SLASH_CMDS = [
    ['/lint',     'Run the mechanical linter'],
    ['/kimball',  'Kimball dimensional modeling review'],
    ['/review',   'Review a specific model'],
    ['/usage',    'Show usage and cost stats'],
    ['/pet',      'Interact with Motchi'],
    ['/adaptive', 'Toggle adaptive (extended) thinking'],
    ['/model',    'Switch active model'],
    ['/new',      'Start a fresh conversation'],
    ['/clear',    'Clear conversation history'],
    ['/sessions', 'Browse past sessions'],
    ['/project',  'Switch dbt project'],
    ['/term',     'Toggle terminal mode'],
    ['/help',     'Show all available commands'],
  ];

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-foreground, #cccccc);
    font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: 13px;
    overflow: hidden;
  }

  /* ── Conversation area ─────────────────────────────── */
  #conv {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px 4px;
    display: flex;
    flex-direction: column;
    gap: 0;
    scroll-behavior: smooth;
  }
  #conv::-webkit-scrollbar { width: 4px; }
  #conv::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, #424242);
    border-radius: 2px;
  }

  /* Empty state */
  #empty {
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
  #empty .icon { font-size: 28px; }
  #empty .title { font-size: 14px; font-weight: 500; opacity: 0.7; }
  #empty .hint  { font-size: 11.5px; opacity: 0.45; line-height: 1.5; }
  #empty .ver   { font-size: 10.5px; opacity: 0.35; margin-top: 4px; font-variant-numeric: tabular-nums; }

  /* Turn: wrapper groups user msg + assistant response */
  .turn { display: flex; flex-direction: column; gap: 0; margin-bottom: 12px; }

  /* User message */
  .msg-user {
    align-self: flex-end;
    max-width: 80%;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    padding: 8px 12px;
    border-radius: 12px 12px 3px 12px;
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 8px;
  }

  /* Assistant response block */
  .msg-assistant {
    align-self: flex-start;
    max-width: 96%;
    font-size: 13px;
    line-height: 1.6;
    color: var(--vscode-foreground, #cccccc);
    white-space: pre-wrap;
    word-break: break-word;
    padding: 0 2px;
  }

  /* Tool call pill */
  .tool-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-panel-border, #2d2d2d);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground, #888);
    margin: 3px 0;
    cursor: default;
  }
  .tool-pill.running { color: var(--vscode-textLink-foreground, #3794ff); }
  .tool-pill.done    { color: #3cb371; }

  /* Live streaming text indicator */
  .cursor-blink {
    display: inline-block;
    width: 2px; height: 1em;
    background: var(--vscode-foreground, #ccc);
    margin-left: 1px;
    vertical-align: text-bottom;
    animation: blink 1s step-end infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* ── Terminal hint ─────────────────────────────────── */
  #term-hint {
    text-align: center;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #555);
    padding: 3px 10px;
    user-select: none;
  }
  #term-hint a {
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    text-decoration: none;
  }
  #term-hint a:hover { text-decoration: underline; }

  /* ── Slash-command suggestions ─────────────────────── */
  #suggestions {
    margin: 0 8px;
    border: 1px solid var(--vscode-panel-border, #2d2d2d);
    border-radius: 8px 8px 0 0;
    border-bottom: none;
    background: var(--vscode-editorWidget-background, #252526);
    overflow: hidden;
    display: none;
    max-height: 180px;
    overflow-y: auto;
  }
  #suggestions.visible { display: block; }
  .sug-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 12px;
  }
  .sug-item:hover, .sug-item.active {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #fff);
  }
  .sug-cmd  { font-weight: 600; color: var(--vscode-textLink-foreground, #3794ff); }
  .sug-item:hover .sug-cmd,
  .sug-item.active .sug-cmd { color: inherit; }
  .sug-desc { opacity: 0.7; font-size: 11px; }

  /* ── Floating input card ───────────────────────────── */
  #input-card {
    margin: 0 8px 8px;
    background: var(--vscode-input-background, #2d2d2d);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 0 0 12px 12px;
    box-shadow: 0 2px 12px rgba(0,0,0,.35);
    display: flex;
    flex-direction: column;
    gap: 0;
    transition: border-color .15s;
  }
  #input-card.no-suggestions { border-radius: 12px; }
  #input-card:focus-within   { border-color: var(--vscode-focusBorder, #007acc); }

  #input-row {
    display: flex;
    align-items: flex-end;
    padding: 8px 8px 4px;
    gap: 8px;
  }

  /* Pet canvas — fixed pixel dimensions to avoid flex squish */
  #pet-canvas {
    display: block;
    width: ${canvasW}px;
    height: ${canvasH}px;
    flex: 0 0 ${canvasW}px;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    cursor: pointer;
    align-self: flex-end;
  }

  #input {
    flex: 1;
    min-height: 36px;
    max-height: 180px;
    padding: 7px 0;
    background: transparent;
    color: var(--vscode-input-foreground, #ccc);
    border: none;
    outline: none;
    resize: none;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.45;
    overflow-y: auto;
  }
  #input::placeholder { color: var(--vscode-input-placeholderForeground, #555); }
  #input::-webkit-scrollbar { width: 3px; }
  #input::-webkit-scrollbar-thumb { background: #424242; border-radius: 2px; }

  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 5px;
    border-radius: 5px;
    font-size: 15px;
    line-height: 1;
    opacity: .55;
    color: var(--vscode-foreground, #ccc);
    flex-shrink: 0;
    align-self: flex-end;
    transition: opacity .12s, background .12s;
  }
  .btn-icon:hover { opacity: 1; background: rgba(255,255,255,.07); }

  #submit-btn {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    opacity: 1;
  }
  #submit-btn:hover { filter: brightness(1.1); background: var(--vscode-button-background, #0e639c); }
  #submit-btn:disabled { opacity: .3; cursor: not-allowed; filter: none; }
  #submit-btn.stop {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: #f48771;
  }

  #file-input { display: none; }

  /* Toolbar */
  #toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 8px;
    border-top: 1px solid rgba(255,255,255,.05);
    flex-wrap: wrap;
  }
  #model-select {
    background: transparent;
    color: var(--vscode-descriptionForeground, #888);
    border: none; outline: none;
    font-size: 11.5px; font-family: inherit;
    cursor: pointer;
    -webkit-appearance: none; appearance: none;
  }
  #model-select:hover { color: var(--vscode-foreground, #ccc); }

  #thinking-label {
    display: flex; align-items: center; gap: 4px;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground, #888);
    cursor: pointer; user-select: none;
  }
  #thinking-label:hover { color: var(--vscode-foreground, #ccc); }
  #thinking-label input { cursor: pointer; }

  #chip-list {
    flex: 1; display: flex; flex-wrap: wrap; gap: 4px; min-width: 0;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 3px;
    background: rgba(255,255,255,.1);
    border-radius: 8px; padding: 1px 8px;
    font-size: 10.5px; max-width: 120px;
  }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip button {
    background: none; border: none; cursor: pointer;
    color: inherit; font-size: 11px; padding: 0 0 0 2px; opacity: .65;
  }
  .chip button:hover { opacity: 1; }
</style>
</head>
<body>

<div id="conv">
  <div id="empty">
    <div class="icon">🌿</div>
    <div class="title">bk1 · dbt agent</div>
    <div class="hint">Type a message below to start.<br>Responses stream in here live.</div>
    <div class="ver">v${version}</div>
  </div>
</div>

<div id="term-hint" style="display:none">
  bk1 terminal not running — <a id="open-link">open it</a>
</div>

<div id="suggestions"></div>

<div id="input-card" class="no-suggestions">
  <div id="input-row">
    <canvas id="pet-canvas"
      width="${canvasW}" height="${canvasH}"
      title="Click to check on Motchi"></canvas>

    <textarea id="input"
      placeholder="Message bk1… (Enter · Shift+Enter for newline)"
      rows="1" spellcheck="false"></textarea>

    <button class="btn-icon" id="attach-btn" title="Attach file or image">📎</button>
    <button class="btn-icon" id="submit-btn" title="Send (Enter)">↑</button>
    <input type="file" id="file-input" multiple
      accept=".sql,.yml,.yaml,.md,.txt,.json,.py,.csv,.png,.jpg,.jpeg,.gif,.webp">
  </div>

  <div id="toolbar">
    <select id="model-select" title="Active model">
      <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
      <option value="claude-sonnet-4-6" selected>Sonnet 4.6</option>
      <option value="claude-opus-4-8">Opus 4.8</option>
    </select>
    <label id="thinking-label">
      <input type="checkbox" id="thinking-chk"> thinking
    </label>
    <div id="chip-list"></div>
  </div>
</div>

<script nonce="${n}">
(function () {
'use strict';

const vscode      = acquireVsCodeApi();
const convEl      = document.getElementById('conv');
const emptyEl     = document.getElementById('empty');
const termHint    = document.getElementById('term-hint');
const openLink    = document.getElementById('open-link');
const sugEl       = document.getElementById('suggestions');
const inputCard   = document.getElementById('input-card');
const inputEl     = document.getElementById('input');
const submitBtn   = document.getElementById('submit-btn');
const attachBtn   = document.getElementById('attach-btn');
const fileInput   = document.getElementById('file-input');
const modelSel    = document.getElementById('model-select');
const thinkChk    = document.getElementById('thinking-chk');
const chipList    = document.getElementById('chip-list');
const canvas      = document.getElementById('pet-canvas');
const ctx2d       = canvas.getContext('2d');

const CELL_W = ${cellPx}, CELL_H = ${cellPx};
const EYE = '#000000', BLINK_COL = '#FCD34D';

// ── State ──────────────────────────────────────────────────
let pendingFiles  = [];
let responding    = false;
let termOpen      = false;
let turnStarted   = false;  // true after doSubmit() calls startTurn() immediately

// Conversation rendering state
let activeTurn     = null;   // current .turn element being built
let assistantEl    = null;   // current .msg-assistant element
let assistantText  = '';     // accumulated assistant text for current turn
let activeToolPill = null;   // currently-running .tool-pill

// Slash suggestions
const CMDS = ${JSON.stringify(SLASH_CMDS)};
let sugItems      = [];
let sugActive     = -1;

// ── Terminal hint ───────────────────────────────────────────
function setTermOpen(open) {
  termOpen = open;
  termHint.style.display = open ? 'none' : '';
}
setTermOpen(false);
openLink.addEventListener('click', () => vscode.postMessage({ type: 'openTerminal' }));

// ── Input resize ────────────────────────────────────────────
function resizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}
inputEl.addEventListener('input', () => { resizeInput(); updateSuggestions(); });

// ── Slash-command suggestions ────────────────────────────────
function updateSuggestions() {
  const val = inputEl.value;
  if (!val.startsWith('/') || val.includes(' ') || val.includes('\n')) {
    hideSug(); return;
  }
  const filt = CMDS.filter(([cmd]) => cmd.startsWith(val));
  if (!filt.length) { hideSug(); return; }

  sugEl.innerHTML = '';
  sugActive = -1;
  sugItems  = filt.map(([cmd, desc], i) => {
    const d = document.createElement('div');
    d.className = 'sug-item';
    d.innerHTML = '<span class="sug-cmd">' + cmd + '</span><span class="sug-desc">' + desc + '</span>';
    d.addEventListener('mousedown', (e) => { e.preventDefault(); applySug(cmd); });
    sugEl.appendChild(d);
    return d;
  });
  sugEl.classList.add('visible');
  inputCard.classList.remove('no-suggestions');
}

function hideSug() {
  sugEl.classList.remove('visible');
  inputCard.classList.add('no-suggestions');
  sugItems  = [];
  sugActive = -1;
}

function applySug(cmd) {
  inputEl.value = cmd + ' ';
  resizeInput();
  hideSug();
  inputEl.focus();
}

// ── Keys ─────────────────────────────────────────────────────
inputEl.addEventListener('keydown', (e) => {
  if (sugItems.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sugActive = Math.min(sugActive + 1, sugItems.length - 1);
      refreshSugActive(); return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      sugActive = Math.max(sugActive - 1, -1);
      refreshSugActive(); return;
    }
    if ((e.key === 'Tab' || e.key === 'Enter') && sugActive >= 0) {
      e.preventDefault();
      applySug(CMDS[sugActive][0]); return;
    }
    if (e.key === 'Escape') { hideSug(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey)  { e.preventDefault(); doSubmit(); }
  if (e.key === 'Escape' && responding)  { e.preventDefault(); doCancel(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && responding && document.activeElement !== inputEl) {
    e.preventDefault(); doCancel();
  }
});

function refreshSugActive() {
  sugItems.forEach((el, i) => el.classList.toggle('active', i === sugActive));
}

// ── Submit ────────────────────────────────────────────────────
submitBtn.addEventListener('click', () => { if (responding) doCancel(); else doSubmit(); });

function doSubmit() {
  const text = inputEl.value;
  if (!text.trim() && !pendingFiles.length) return;
  if (responding) return;

  hideSug();
  removeEmpty();

  // Show user bubble immediately — don't wait for chatEvent.user from bk1.
  startTurn(text);
  turnStarted = true;

  vscode.postMessage({
    type: 'submit', text,
    model: modelSel.value, thinking: thinkChk.checked,
    files: pendingFiles.slice(),
  });

  inputEl.value = '';
  resizeInput();
  clearFiles();
  setResponding(true);
}

function doCancel() {
  vscode.postMessage({ type: 'cancel' });
  setResponding(false);
  if (assistantEl) {
    const cursor = assistantEl.querySelector('.cursor-blink');
    if (cursor) cursor.remove();
  }
  finishTurn();
}

function setResponding(on) {
  responding = on;
  submitBtn.disabled = false;
  if (on) {
    submitBtn.textContent = '■';
    submitBtn.title = 'Cancel (Esc)';
    submitBtn.classList.add('stop');
  } else {
    submitBtn.textContent = '↑';
    submitBtn.title = 'Send (Enter)';
    submitBtn.classList.remove('stop');
  }
}

// ── Conversation rendering ───────────────────────────────────
function removeEmpty() {
  if (emptyEl && emptyEl.parentNode) emptyEl.remove();
}

function startTurn(userText) {
  activeTurn   = document.createElement('div');
  activeTurn.className = 'turn';

  const userDiv = document.createElement('div');
  userDiv.className = 'msg-user';
  userDiv.textContent = userText || '…';
  activeTurn.appendChild(userDiv);

  convEl.appendChild(activeTurn);
  scroll();

  assistantEl   = null;
  assistantText = '';
  activeToolPill = null;
}

function ensureAssistantEl() {
  if (!assistantEl) {
    assistantEl = document.createElement('div');
    assistantEl.className = 'msg-assistant';
    // Blinking cursor shown while streaming
    const cur = document.createElement('span');
    cur.className = 'cursor-blink';
    assistantEl.appendChild(cur);
    if (activeTurn) activeTurn.appendChild(assistantEl);
    else convEl.appendChild(assistantEl);
  }
}

function appendText(chunk) {
  ensureAssistantEl();
  assistantText += chunk;
  // Render: remove cursor, set text, re-add cursor
  const cur = assistantEl.querySelector('.cursor-blink');
  if (cur) cur.remove();
  assistantEl.textContent = assistantText;
  const newCur = document.createElement('span');
  newCur.className = 'cursor-blink';
  assistantEl.appendChild(newCur);
  scroll();
}

function addToolPill(name, running) {
  ensureAssistantEl();
  // End previous tool pill
  if (activeToolPill) { activeToolPill.classList.remove('running'); activeToolPill.classList.add('done'); }

  const pill = document.createElement('div');
  pill.className = 'tool-pill' + (running ? ' running' : ' done');
  const icon = running ? '⟳' : '✓';
  const label = name.replace(/^Semantic:\s*/i, '');
  pill.textContent = icon + ' ' + label;
  if (activeTurn) activeTurn.appendChild(pill);
  else convEl.appendChild(pill);
  activeToolPill = running ? pill : null;
  scroll();
}

function finishTurn() {
  if (assistantEl) {
    const cur = assistantEl.querySelector('.cursor-blink');
    if (cur) cur.remove();
  }
  if (activeToolPill) { activeToolPill.classList.remove('running'); activeToolPill.classList.add('done'); }
  activeTurn    = null;
  assistantEl   = null;
  assistantText = '';
  activeToolPill = null;
}

function scroll() { convEl.scrollTop = convEl.scrollHeight; }

// ── Messages from extension ──────────────────────────────────
window.addEventListener('message', (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    // --- streaming chat events from bk1 ---
    case 'chatEvent': {
      const e = msg.event;
      switch (e.type) {
        case 'user':
          // doSubmit() already called startTurn() immediately — skip duplicate.
          if (turnStarted) { turnStarted = false; }
          else { startTurn(e.text); }
          break;
        case 'text':
          appendText(e.chunk);
          break;
        case 'tool_start':
          addToolPill(e.name, true);
          break;
        case 'done':
          finishTurn();
          setResponding(false);
          break;
      }
      break;
    }
    case 'done':
      finishTurn();
      setResponding(false);
      break;
    case 'error':
      finishTurn();
      setResponding(false);
      {
        const d = document.createElement('div');
        d.className = 'tool-pill';
        d.style.color = '#f48771';
        d.textContent = '✕ ' + msg.message;
        convEl.appendChild(d);
        scroll();
      }
      break;
    case 'petState':
      drawPet(msg);
      break;
    case 'terminalStatus':
      setTermOpen(msg.open);
      break;
  }
});

// ── File attachment ──────────────────────────────────────────
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
  return new Promise(r => {
    const fr = new FileReader();
    if (f.type.startsWith('image/')) { fr.onload = e => r(e.target.result); fr.readAsDataURL(f); }
    else                             { fr.onload = e => r(e.target.result); fr.readAsText(f); }
  });
}
function renderChips() {
  chipList.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const c = document.createElement('div'); c.className = 'chip';
    const s = document.createElement('span'); s.textContent = f.name;
    const b = document.createElement('button'); b.textContent = '×';
    b.addEventListener('click', () => { pendingFiles.splice(i, 1); renderChips(); });
    c.appendChild(s); c.appendChild(b); chipList.appendChild(c);
  });
}
function clearFiles() { pendingFiles = []; renderChips(); }

modelSel.addEventListener('change', () => vscode.postMessage({ type: 'modelChange', model: modelSel.value }));

// ── Pet sprite ────────────────────────────────────────────────
function cellColors(ch, body) {
  switch (ch) {
    case 'B': return { t: body,  b: body,  line: false };
    case 'V': return { t: EYE,   b: body,  line: false };
    case 'M': return { t: body,  b: EYE,   line: false };
    case 'Y': return { t: BLINK_COL, b: body, line: false };
    case 'H': return { t: body,  b: body,  line: true  };
    case 'L': return { t: null,  b: body,  line: false };
    case 'U': return { t: body,  b: null,  line: false };
    case ' ': return { t: null,  b: null,  line: false };
    default:  return { t: body,  b: body,  line: false };
  }
}
function drawFrame(rows, body) {
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  const h2 = CELL_H / 2;
  rows.forEach((row, ri) => {
    [...row].forEach((ch, ci) => {
      const x = ci * CELL_W, y = ri * CELL_H;
      const c = cellColors(ch, body);
      if (c.t)    { ctx2d.fillStyle = c.t; ctx2d.fillRect(x, y,      CELL_W, h2); }
      if (c.b)    { ctx2d.fillStyle = c.b; ctx2d.fillRect(x, y + h2, CELL_W, h2); }
      if (c.line) { ctx2d.fillStyle = EYE; ctx2d.fillRect(x, y + h2 - 1, CELL_W, 2); }
    });
  });
}

const FRAMES = {
  normal: ['BBBBBBBBB', 'BBVBBBVBB', 'BBBBBBBBB'],
  blink:  ['BBBBBBBBB', 'BBBBBBBBB', 'BBBBBBBBB'],
  sleep:  ['BBBBBBBBB', 'BHHBBBHHB', 'BBBBBBBBB'],
  eat_a:  ['BBBBBBBBB', 'BBVBBBVBB', 'BBB)WBBBB'],
  eat_b:  ['BBBBBBBBB', 'BBVBBBVBB', 'BBB)TBBBB'],
  left:   ['BBBBBBBBB', 'BVBBBVBBB', 'BBBBBBBBB'],
  right:  ['BBBBBBBBB', 'BBBVBBBVB', 'BBBBBBBBB'],
  up:     ['BBMBBBMBB', 'BBBBBBBBB', 'BBBBBBBBB'],
  down:   ['BBBBBBBBB', 'BBMBBBMBB', 'BBBBBBBBB'],
};

let body      = '#9FE749';
let mood      = 'happy';
let eating    = false;
let eatFrame  = 0;
let eatTimer  = null;
let eyeDir    = 'normal';
let blinking  = false;

function currentFrame() {
  if (mood === 'sleeping') return FRAMES.sleep;
  if (eating) return eatFrame % 2 === 0 ? FRAMES.eat_a : FRAMES.eat_b;
  if (blinking) return FRAMES.blink;
  return FRAMES[eyeDir] || FRAMES.normal;
}
function refresh() { drawFrame(currentFrame(), body); }

// Eye tracking
canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  const dx = e.clientX - r.left - r.width / 2;
  const dy = e.clientY - r.top  - r.height / 2;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < 3 && ay < 3)    eyeDir = 'normal';
  else if (ay > ax * 1.5)  eyeDir = dy < 0 ? 'up'   : 'down';
  else if (ax > ay * 1.5)  eyeDir = dx < 0 ? 'left' : 'right';
  else                     eyeDir = dy < 0 ? 'up'   : 'down';
  refresh();
});
canvas.addEventListener('mouseleave', () => { eyeDir = 'normal'; refresh(); });

// Click to check on Motchi
canvas.addEventListener('click', () => {
  vscode.postMessage({ type: 'submit', text: '/pet', model: modelSel.value, thinking: false, files: [] });
});

// Blink animation (random interval 3–8s)
function scheduleBlink() {
  const delay = 3000 + Math.random() * 5000;
  setTimeout(() => {
    blinking = true; refresh();
    setTimeout(() => { blinking = false; refresh(); scheduleBlink(); }, 150);
  }, delay);
}
scheduleBlink();

// Idle look-around (random interval 6–14s)
function scheduleIdle() {
  const delay = 6000 + Math.random() * 8000;
  setTimeout(() => {
    if (eyeDir === 'normal') {
      const dirs = ['left', 'right', 'up', 'down'];
      eyeDir = dirs[Math.floor(Math.random() * dirs.length)];
      refresh();
      setTimeout(() => { eyeDir = 'normal'; refresh(); scheduleIdle(); }, 800);
    } else {
      scheduleIdle();
    }
  }, delay);
}
scheduleIdle();

function drawPet(msg) {
  body  = msg.color || '#9FE749';
  mood  = msg.mood  || 'happy';
  eating = !!msg.isEating;
  if (eatTimer) { clearInterval(eatTimer); eatTimer = null; }
  if (eating) eatTimer = setInterval(() => { eatFrame++; refresh(); }, 300);
  refresh();
}

drawFrame(FRAMES.normal, '#9FE749');
inputEl.focus();
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Editor panel (WebviewPanel — opens beside code files, Claude Code style)
// ---------------------------------------------------------------------------

export class Bk1ChatPanel {
  static readonly viewType = 'bk1.chatPanel';
  static currentPanel?: Bk1ChatPanel;

  private readonly panel: vscode.WebviewPanel;
  private petTimer?: NodeJS.Timeout;
  private readonly getTerminal: () => vscode.Terminal | undefined;
  private readonly deliverPrompt: (line: string) => void | Promise<void>;

  static createOrReveal(
    ctx: vscode.ExtensionContext,
    getTerminal: () => vscode.Terminal | undefined,
    deliverPrompt: (line: string) => void | Promise<void>,
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
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [ctx.extensionUri] },
    );
    panel.iconPath = iconUri;
    const instance = new Bk1ChatPanel(panel, ctx, getTerminal, deliverPrompt);
    Bk1ChatPanel.currentPanel = instance;
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    ctx: vscode.ExtensionContext,
    getTerminal: () => vscode.Terminal | undefined,
    deliverPrompt: (line: string) => void | Promise<void>,
  ) {
    this.panel         = panel;
    this.getTerminal   = getTerminal;
    this.deliverPrompt = deliverPrompt;
    const version = (ctx.extension.packageJSON as { version?: string }).version ?? '?';
    panel.webview.html = buildHtml(panel.webview, 'panel', version);
    panel.webview.onDidReceiveMessage(msg => this.handle(msg));
    panel.onDidDispose(() => {
      if (this.petTimer) clearInterval(this.petTimer);
      Bk1ChatPanel.currentPanel = undefined;
    });
    this.pushPet();
    this.petTimer = setInterval(() => this.pushPet(), 2000);
  }

  /** Forward a parsed chat event line from the events file to the webview. */
  sendEvent(event: Record<string, unknown>) {
    void this.panel.webview.postMessage({ type: 'chatEvent', event });
  }

  notifyTerminalStatus(open: boolean) {
    void this.panel.webview.postMessage({ type: 'terminalStatus', open });
  }

  private pushPet() {
    const pet = readPetState();
    if (!pet) return;
    const now = new Date();
    void this.panel.webview.postMessage({
      type: 'petState',
      color: petColorHex(pet),
      mood: petMood(pet, now),
      isSleeping: petMood(pet, now) === 'sleeping',
      isEating: !!pet.eating_until && new Date(pet.eating_until) > now,
    });
  }

  private handle(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'submit': {
        const text     = (msg.text  as string) ?? '';
        const files    = (msg.files as { name: string; content: string; fileType: string }[]) ?? [];
        const model    = typeof msg.model === 'string' ? msg.model : undefined;
        const thinking = msg.thinking === true;
        this.submit(text, files, model, thinking);
        break;
      }
      case 'cancel': {
        // Interrupt the running turn by sending Ctrl+C to the bk1 TUI — but only
        // if its process is live. sendText to a dead terminal would relaunch it.
        const t = this.getTerminal();
        if (t && t.exitStatus === undefined) t.sendText('\x03', false);
        else void this.panel.webview.postMessage({ type: 'done' });
        break;
      }
      case 'openTerminal':
        void vscode.commands.executeCommand('bk1.open');
        break;
    }
  }

  private submit(text: string, files: { name: string; content: string; fileType: string }[], model?: string, thinking?: boolean) {
    // Inline attachments into the prompt text (images written to a tmp file and
    // referenced by path) — same composition as before; bk1 receives one string.
    const parts: string[] = [];
    for (const f of files) {
      if (f.fileType.startsWith('image/')) {
        try {
          const tmp = path.join(os.tmpdir(), `bk1-${Date.now()}-${f.name}`);
          fs.writeFileSync(tmp, Buffer.from(f.content.replace(/^data:[^,]+,/, ''), 'base64'));
          parts.push(`[Attached image: ${tmp}]`);
        } catch { parts.push(`[Image failed: ${f.name}]`); }
      } else {
        parts.push(`[Attached file: ${f.name}]\n${f.content}`);
      }
    }
    if (text.trim()) parts.push(text.trim());
    const full = parts.join('\n\n');
    if (!full) return;
    // Deliver via the append-only prompt-input channel — NOT terminal keystroke
    // injection (which silently dropped the prompt whenever the hosting terminal's
    // process had exited). The extension writes this line and guarantees bk1 is
    // running; bk1's fs.watch drains it straight into its agent loop. ts lets bk1
    // gate stale-replay on a relaunch (PROMPT_INPUT_FRESH_MS in app.tsx).
    const line = JSON.stringify({ text: full, model, thinking: !!thinking, files: [], ts: Date.now() });
    void this.deliverPrompt(line);
  }
}

