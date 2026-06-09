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

// Replica of bk1's level model (src/pet.ts levelInfo) — the extension can't
// import across packages, so this must track that file if LEVEL_BASE changes.
const LEVEL_BASE = 50;

function levelInfo(xp: number): { level: number; into: number; span: number } {
  let level = 1;
  let remaining = Math.max(0, Math.floor(xp));
  while (remaining >= LEVEL_BASE * level) {
    remaining -= LEVEL_BASE * level;
    level += 1;
  }
  return { level, into: remaining, span: LEVEL_BASE * level };
}

function makeNonce(): string { return crypto.randomBytes(16).toString('hex'); }

// ---------------------------------------------------------------------------
// Sidebar chat view (WebviewView in the bk1 activity-bar container).
// Design comes from the dbt-agent-ui scaffold: media/main.css + media/main.js
// carry the UI; this class is the thin host shell — HTML scaffold, pet.json
// polling, and the postMessage <-> file-channel bridge.
// ---------------------------------------------------------------------------

export class Bk1ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'bk1.chat';

  private view?: vscode.WebviewView;
  private petTimer?: NodeJS.Timeout;
  // Chat events can arrive before VS Code lazily resolves the view (it only
  // resolves once the sidebar is first shown). Buffer and flush on resolve.
  private pendingEvents: Record<string, unknown>[] = [];
  private lastTerminalOpen = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly getTerminal: () => vscode.Terminal | undefined,
    private readonly deliverPrompt: (line: string) => void | Promise<void>,
    private readonly ensureRunning: () => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(msg => this.handle(msg));
    view.onDidDispose(() => {
      if (this.petTimer) { clearInterval(this.petTimer); this.petTimer = undefined; }
      this.view = undefined;
    });

    for (const e of this.pendingEvents) {
      void view.webview.postMessage({ type: 'chatEvent', event: e });
    }
    this.pendingEvents = [];
    this.notifyTerminalStatus(this.lastTerminalOpen);

    this.pushPet();
    if (this.petTimer) clearInterval(this.petTimer);
    this.petTimer = setInterval(() => this.pushPet(), 2000);

    // Pre-warm bk1 so it's mounted and watching prompt-input.jsonl before the
    // user submits — the prompt then drains via fs.watch (no first-drain
    // freshness gate). Also re-ensure on re-show in case bk1 died while hidden.
    // ensureRunning() is idempotent (no-ops when bk1 is already alive).
    this.ensureRunning();
    view.onDidChangeVisibility(() => { if (view.visible) this.ensureRunning(); });
  }

  /** Forward a parsed chat event line from the events file to the webview. */
  sendEvent(event: Record<string, unknown>) {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'chatEvent', event });
    } else {
      this.pendingEvents.push(event);
      if (this.pendingEvents.length > 200) this.pendingEvents.shift();
    }
  }

  notifyTerminalStatus(open: boolean) {
    this.lastTerminalOpen = open;
    void this.view?.webview.postMessage({ type: 'terminalStatus', open });
  }

  private pushPet() {
    if (!this.view) return;
    const pet = readPetState();
    if (!pet) return;
    const now = new Date();
    const lvl = levelInfo(pet.xp ?? 0);
    void this.view.webview.postMessage({
      type: 'petState',
      // sprite
      color: petColorHex(pet),
      mood: petMood(pet, now),
      isSleeping: petMood(pet, now) === 'sleeping',
      isEating: !!pet.eating_until && new Date(pet.eating_until) > now,
      // pet tab
      name: pet.name,
      hunger: pet.hunger,
      happiness: pet.happiness,
      energy: pet.energy,
      coins: pet.coins,
      xp: pet.xp,
      level: lvl.level,
      into: lvl.into,
      span: lvl.span,
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
        else void this.view?.webview.postMessage({ type: 'done' });
        break;
      }
      case 'openTerminal':
        void vscode.commands.executeCommand('bk1.open');
        break;
    }
  }

  private submit(text: string, files: { name: string; content: string; fileType: string }[], model?: string, thinking?: boolean) {
    // Inline attachments into the prompt text (images written to a tmp file and
    // referenced by path) — bk1 receives one string.
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

  private getHtml(webview: vscode.Webview): string {
    const nonce   = makeNonce();
    const cssUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.css'));
    const jsUri   = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.js'));
    const version = (this.ctx.extension.packageJSON as { version?: string }).version ?? '?';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${cssUri}" rel="stylesheet">
<title>bk1</title>
</head>
<body>
<main class="app-shell">
  <header class="agent-header">
    <div class="agent-title">bk1 · dbt agent</div>
    <div class="ver">v${version}</div>
  </header>

  <section class="hero">
    <canvas id="motchi-hero" class="motchi-canvas motchi-hero" width="45" height="15" title="Motchi"></canvas>
    <div class="speech-bubble">
      <div>Hey there! I'm Motchi 🦀</div>
      <div>Your dbt companion. Ask me anything about your project!</div>
    </div>
  </section>

  <nav class="tabs" aria-label="bk1 tabs">
    <button id="chatTabButton" class="tab active" data-tab="chat">CHAT</button>
    <button id="petTabButton" class="tab" data-tab="pet">PET</button>
  </nav>

  <section id="chatView" class="tab-panel active">
    <div id="chatHistory" class="chat-history"></div>

    <div id="term-hint" hidden>bk1 terminal not running — <a id="open-link">open it</a></div>

    <div id="suggestions"></div>
    <form id="promptForm" class="prompt-box">
      <div class="input-row">
        <textarea id="promptInput" rows="2" placeholder="Message bk1…" spellcheck="false"></textarea>
        <button id="sendButton" class="send-button" type="submit" title="Send (Enter)">➤</button>
      </div>
      <div id="chip-list"></div>
      <div class="prompt-footer">
        <div class="footer-icons">
          <button type="button" id="attach-btn" class="footer-icon" title="Attach file or image">📎</button>
          <select id="model-select" title="Active model">
            <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
            <option value="claude-sonnet-4-6" selected>Sonnet 4.6</option>
            <option value="claude-opus-4-8">Opus 4.8</option>
          </select>
          <label id="thinking-label"><input type="checkbox" id="thinking-chk"> thinking</label>
        </div>
        <div class="footer-hint">↵ send · ⇧↵ newline</div>
      </div>
      <input type="file" id="file-input" multiple
        accept=".sql,.yml,.yaml,.md,.txt,.json,.py,.csv,.png,.jpg,.jpeg,.gif,.webp">
    </form>
  </section>

  <section id="petView" class="tab-panel">
    <section class="pet-card">
      <div class="pet-header">
        <div>
          <span class="pet-name" id="pet-name">Motchi</span>
          <button class="edit-name-button" id="rename-btn" type="button" title="Rename">✎</button>
        </div>
        <div id="pet-level">Level 1</div>
      </div>

      <div id="rename-row" hidden>
        <input id="rename-input" maxlength="24" placeholder="New name…">
        <button id="rename-ok" type="button" title="Rename">✓</button>
      </div>

      <div class="xp-row">
        <div class="xp-bar"><div class="xp-fill" id="xp-fill"></div></div>
        <span id="xp-label">0 / 50 XP</span>
      </div>

      <div class="pet-room">
        <div class="window-art">
          <div class="hill one"></div>
          <div class="hill two"></div>
        </div>
        <div class="wall-art"></div>
        <div class="shelf-art"></div>
        <div class="motchi-stage-wrap">
          <canvas id="motchi-stage" class="motchi-canvas motchi-stage" width="126" height="42" title="Click to check on Motchi"></canvas>
        </div>
      </div>

      <div class="stat-list">
        <div class="stat-row">
          <span>🙂 Mood</span>
          <strong id="stat-mood">—</strong>
        </div>
        <div class="stat-row">
          <span>🍙 Fullness</span>
          <div class="metric">
            <div class="metric-track"><div class="metric-fill fullness" id="fill-fullness"></div></div>
            <span id="val-fullness">—</span>
          </div>
        </div>
        <div class="stat-row">
          <span>⚡ Energy</span>
          <div class="metric">
            <div class="metric-track"><div class="metric-fill energy" id="fill-energy"></div></div>
            <span id="val-energy">—</span>
          </div>
        </div>
        <div class="stat-row">
          <span>💛 Happiness</span>
          <div class="metric">
            <div class="metric-track"><div class="metric-fill happiness" id="fill-happiness"></div></div>
            <span id="val-happiness">—</span>
          </div>
        </div>
        <div class="stat-row">
          <span>🪙 Coins</span>
          <strong id="stat-coins">—</strong>
        </div>
      </div>
    </section>

    <section class="next-level-card">
      <div class="next-level-header">
        <strong>Next Level</strong>
        <span id="next-xp">— XP to go</span>
      </div>
      <div class="next-progress"><div id="next-fill"></div></div>
    </section>

    <footer class="pet-actions">
      <button type="button" class="action-item" data-cmd="/pet feed snack" data-cost="5">🍪<span>Snack · 5</span></button>
      <button type="button" class="action-item" data-cmd="/pet feed meal" data-cost="15">🍱<span>Meal · 15</span></button>
      <button type="button" class="action-item" data-cmd="/pet feed feast" data-cost="35">🍗<span>Feast · 35</span></button>
      <button type="button" class="action-item" data-cmd="/pet sleep" data-cost="0">😴<span>Sleep</span></button>
    </footer>
  </section>
</main>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
