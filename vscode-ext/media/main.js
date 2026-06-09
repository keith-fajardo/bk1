// bk1 sidebar chat — webview script. Talks to the extension host via
// postMessage; the host owns the file channels (prompt-input.jsonl in,
// chat-events.jsonl out) and pet.json polling.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ── DOM ────────────────────────────────────────────────────
  const chatTabButton = document.getElementById('chatTabButton');
  const petTabButton  = document.getElementById('petTabButton');
  const chatView      = document.getElementById('chatView');
  const petView       = document.getElementById('petView');

  const chatHistory = document.getElementById('chatHistory');
  const termHint    = document.getElementById('term-hint');
  const openLink    = document.getElementById('open-link');
  const sugEl       = document.getElementById('suggestions');
  const promptForm  = document.getElementById('promptForm');
  const inputEl     = document.getElementById('promptInput');
  const sendBtn     = document.getElementById('sendButton');
  const attachBtn   = document.getElementById('attach-btn');
  const fileInput   = document.getElementById('file-input');
  const chipList    = document.getElementById('chip-list');
  const modelSel    = document.getElementById('model-select');
  const thinkChk    = document.getElementById('thinking-chk');

  const petNameEl   = document.getElementById('pet-name');
  const petLevelEl  = document.getElementById('pet-level');
  const xpFillEl    = document.getElementById('xp-fill');
  const xpLabelEl   = document.getElementById('xp-label');
  const statMoodEl  = document.getElementById('stat-mood');
  const statCoinsEl = document.getElementById('stat-coins');
  const fillFull    = document.getElementById('fill-fullness');
  const valFull     = document.getElementById('val-fullness');
  const fillEnergy  = document.getElementById('fill-energy');
  const valEnergy   = document.getElementById('val-energy');
  const fillHappy   = document.getElementById('fill-happiness');
  const valHappy    = document.getElementById('val-happiness');
  const nextXpEl    = document.getElementById('next-xp');
  const nextFillEl  = document.getElementById('next-fill');
  const renameBtn   = document.getElementById('rename-btn');
  const renameRow   = document.getElementById('rename-row');
  const renameInput = document.getElementById('rename-input');
  const renameOk    = document.getElementById('rename-ok');
  const actionBtns  = Array.from(document.querySelectorAll('.action-item'));

  // ── State ──────────────────────────────────────────────────
  let pendingFiles = [];
  let responding   = false;
  let turnStarted  = false; // doSubmit() rendered the user card; skip bk1's echo
  let lastPet      = null;  // last petState payload — colors new mini canvases
  let ackTimer     = null;  // fires if bk1 never acknowledges a submitted prompt

  // Safety net for the multi-process handshake (extension writes prompt-input.jsonl,
  // bk1 must mount + drain + emit chat-events.jsonl). If bk1 sends NO event within
  // the window, the prompt was lost (bk1 not running / slow mount) — surface it
  // instead of leaving a silent spinner. The first chatEvent of any kind disarms it.
  const ACK_TIMEOUT_MS = 20000;
  function armAck() {
    clearAck();
    ackTimer = setTimeout(() => {
      ackTimer = null;
      addSystemNote('bk1 didn’t pick up your message. It may still be starting up, or the bk1 process isn’t running — reopen the bk1 sidebar to relaunch it.');
      if (responding) { setResponding(false); finishTurn(); }
    }, ACK_TIMEOUT_MS);
  }
  function clearAck() { if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; } }

  // Conversation rendering state for the in-flight turn
  let assistantBody = null; // .assistant-body container of the streaming card
  let assistantText = '';
  let textEl        = null; // the .msg-text <p> inside assistantBody
  let activeToolPill = null;

  // Slash suggestions
  const CMDS = [
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
  let sugItems  = [];
  let sugActive = -1;

  // ── Motchi sprite ──────────────────────────────────────────
  const EYE = '#000000';
  const BLINK_COL = '#FCD34D';
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

  function cellColors(ch, body) {
    switch (ch) {
      case 'B': return { t: body,      b: body, line: false };
      case 'V': return { t: EYE,       b: body, line: false };
      case 'M': return { t: body,      b: EYE,  line: false };
      case 'Y': return { t: BLINK_COL, b: body, line: false };
      case 'H': return { t: body,      b: body, line: true  };
      case 'L': return { t: null,      b: body, line: false };
      case 'U': return { t: body,      b: null, line: false };
      case ' ': return { t: null,      b: null, line: false };
      default:  return { t: body,      b: body, line: false };
    }
  }

  // Draw one frame onto a canvas at the given cell size. Pure pixels — no state.
  function drawFrame(canvas, cellPx, rows, body) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const h2 = cellPx / 2;
    rows.forEach((row, ri) => {
      Array.from(row).forEach((ch, ci) => {
        const x = ci * cellPx, y = ri * cellPx;
        const c = cellColors(ch, body);
        if (c.t)    { ctx.fillStyle = c.t;  ctx.fillRect(x, y,      cellPx, h2); }
        if (c.b)    { ctx.fillStyle = c.b;  ctx.fillRect(x, y + h2, cellPx, h2); }
        if (c.line) { ctx.fillStyle = EYE;  ctx.fillRect(x, y + h2 - 1, cellPx, 2); }
      });
    });
  }

  // Animated Motchi instance: eye tracking, blink, idle glances, eating.
  // Minis on chat messages skip this and use a single static drawFrame —
  // per-message timers would leak under retainContextWhenHidden.
  function makeMotchi(canvas, cellPx) {
    let body = '#9FE749';
    let mood = 'happy';
    let eating = false;
    let eatFrame = 0;
    let eatTimer = null;
    let eyeDir = 'normal';
    let blinking = false;

    function currentFrame() {
      if (mood === 'sleeping') return FRAMES.sleep;
      if (eating) return eatFrame % 2 === 0 ? FRAMES.eat_a : FRAMES.eat_b;
      if (blinking) return FRAMES.blink;
      return FRAMES[eyeDir] || FRAMES.normal;
    }
    function refresh() { drawFrame(canvas, cellPx, currentFrame(), body); }

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const dx = e.clientX - r.left - r.width / 2;
      const dy = e.clientY - r.top - r.height / 2;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax < 3 && ay < 3)   eyeDir = 'normal';
      else if (ay > ax * 1.5) eyeDir = dy < 0 ? 'up' : 'down';
      else if (ax > ay * 1.5) eyeDir = dx < 0 ? 'left' : 'right';
      else                    eyeDir = dy < 0 ? 'up' : 'down';
      refresh();
    });
    canvas.addEventListener('mouseleave', () => { eyeDir = 'normal'; refresh(); });

    (function scheduleBlink() {
      setTimeout(() => {
        blinking = true; refresh();
        setTimeout(() => { blinking = false; refresh(); scheduleBlink(); }, 150);
      }, 3000 + Math.random() * 5000);
    })();

    (function scheduleIdle() {
      setTimeout(() => {
        if (eyeDir === 'normal') {
          const dirs = ['left', 'right', 'up', 'down'];
          eyeDir = dirs[Math.floor(Math.random() * dirs.length)];
          refresh();
          setTimeout(() => { eyeDir = 'normal'; refresh(); scheduleIdle(); }, 800);
        } else {
          scheduleIdle();
        }
      }, 6000 + Math.random() * 8000);
    })();

    refresh();

    return {
      drawPet(msg) {
        body = msg.color || '#9FE749';
        mood = msg.mood || 'happy';
        eating = !!msg.isEating;
        if (eatTimer) { clearInterval(eatTimer); eatTimer = null; }
        if (eating) eatTimer = setInterval(() => { eatFrame++; refresh(); }, 300);
        refresh();
      },
    };
  }

  const heroMotchi  = makeMotchi(document.getElementById('motchi-hero'), 5);
  const stageMotchi = makeMotchi(document.getElementById('motchi-stage'), 14);

  document.getElementById('motchi-stage').addEventListener('click', () => {
    submitCommand('/pet');
  });

  // ── Tabs ───────────────────────────────────────────────────
  function showTab(tabName) {
    const isChat = tabName === 'chat';
    chatTabButton.classList.toggle('active', isChat);
    petTabButton.classList.toggle('active', !isChat);
    chatView.classList.toggle('active', isChat);
    petView.classList.toggle('active', !isChat);
  }
  chatTabButton.addEventListener('click', () => showTab('chat'));
  petTabButton.addEventListener('click', () => showTab('pet'));

  // ── Terminal hint ──────────────────────────────────────────
  function setTermOpen(open) {
    termHint.hidden = open;
  }
  setTermOpen(false);
  openLink.addEventListener('click', () => vscode.postMessage({ type: 'openTerminal' }));

  // ── Input ──────────────────────────────────────────────────
  function resizeInput() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }
  inputEl.addEventListener('input', () => { resizeInput(); updateSuggestions(); });

  // ── Slash-command suggestions ──────────────────────────────
  function updateSuggestions() {
    const val = inputEl.value;
    if (!val.startsWith('/') || val.includes(' ') || val.includes('\n')) {
      hideSug(); return;
    }
    const filt = CMDS.filter(([cmd]) => cmd.startsWith(val));
    if (!filt.length) { hideSug(); return; }

    sugEl.innerHTML = '';
    sugActive = -1;
    sugItems = filt.map(([cmd, desc]) => {
      const d = document.createElement('div');
      d.className = 'sug-item';
      const c = document.createElement('span');
      c.className = 'sug-cmd';
      c.textContent = cmd;
      const t = document.createElement('span');
      t.className = 'sug-desc';
      t.textContent = desc;
      d.appendChild(c);
      d.appendChild(t);
      d.addEventListener('mousedown', (e) => { e.preventDefault(); applySug(cmd); });
      sugEl.appendChild(d);
      return d;
    });
    sugEl.classList.add('visible');
  }

  function hideSug() {
    sugEl.classList.remove('visible');
    sugItems = [];
    sugActive = -1;
  }

  function applySug(cmd) {
    inputEl.value = cmd + ' ';
    resizeInput();
    hideSug();
    inputEl.focus();
  }

  function refreshSugActive() {
    sugItems.forEach((el, i) => el.classList.toggle('active', i === sugActive));
  }

  function visibleCmds() {
    const val = inputEl.value;
    return CMDS.filter(([cmd]) => cmd.startsWith(val));
  }

  // ── Keys ───────────────────────────────────────────────────
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
        applySug(visibleCmds()[sugActive][0]); return;
      }
      if (e.key === 'Escape') { hideSug(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSubmit(); }
    if (e.key === 'Escape' && responding) { e.preventDefault(); doCancel(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && responding && document.activeElement !== inputEl) {
      e.preventDefault(); doCancel();
    }
  });

  // ── Submit / cancel ────────────────────────────────────────
  promptForm.addEventListener('submit', (e) => e.preventDefault());
  sendBtn.addEventListener('click', () => { if (responding) doCancel(); else doSubmit(); });

  function doSubmit() {
    const text = inputEl.value;
    if (!text.trim() && !pendingFiles.length) return;
    if (responding) return;

    hideSug();

    // Show the user card immediately — don't wait for chatEvent.user from bk1.
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
    armAck();
  }

  // Pet actions and sprite clicks: no optimistic card — bk1's echoed
  // chatEvent.user renders it, same as a prompt typed in the TUI.
  function submitCommand(cmd) {
    if (responding) return;
    vscode.postMessage({ type: 'submit', text: cmd, model: modelSel.value, thinking: false, files: [] });
    showTab('chat');
    armAck();
  }

  function doCancel() {
    vscode.postMessage({ type: 'cancel' });
    setResponding(false);
    finishTurn();
  }

  function setResponding(on) {
    responding = on;
    if (on) {
      sendBtn.textContent = '■';
      sendBtn.title = 'Cancel (Esc)';
      sendBtn.classList.add('stop');
    } else {
      sendBtn.textContent = '➤';
      sendBtn.title = 'Send (Enter)';
      sendBtn.classList.remove('stop');
    }
    updateActionState();
  }

  // ── Conversation rendering ─────────────────────────────────
  function getCurrentTime() {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date());
  }

  function makeCard(kind, metaLabel) {
    const article = document.createElement('article');
    article.className = 'message-card ' + kind;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const l = document.createElement('span');
    l.textContent = metaLabel;
    const t = document.createElement('span');
    t.textContent = getCurrentTime();
    meta.appendChild(l);
    meta.appendChild(t);
    article.appendChild(meta);
    return article;
  }

  function startTurn(userText) {
    const card = makeCard('user-message', 'Your Prompt');
    const content = document.createElement('div');
    content.className = 'message-content row';
    const icon = document.createElement('div');
    icon.className = 'user-icon';
    icon.textContent = '👤';
    const p = document.createElement('p');
    p.className = 'msg-text';
    p.textContent = userText || '…';
    content.appendChild(icon);
    content.appendChild(p);
    card.appendChild(content);
    chatHistory.appendChild(card);
    scroll();

    assistantBody = null;
    assistantText = '';
    textEl = null;
    activeToolPill = null;
  }

  function ensureAssistantCard() {
    if (assistantBody) return;
    const card = makeCard('assistant-message', "Motchi's Response");
    const content = document.createElement('div');
    content.className = 'message-content assistant-layout';

    const mini = document.createElement('canvas');
    mini.className = 'motchi-canvas motchi-mini';
    mini.width = 9 * 4;
    mini.height = 3 * 4;
    const sleeping = lastPet && lastPet.mood === 'sleeping';
    drawFrame(mini, 4, sleeping ? FRAMES.sleep : FRAMES.normal, (lastPet && lastPet.color) || '#9FE749');
    content.appendChild(mini);

    assistantBody = document.createElement('div');
    assistantBody.className = 'assistant-body';
    content.appendChild(assistantBody);
    card.appendChild(content);
    chatHistory.appendChild(card);

    textEl = document.createElement('p');
    textEl.className = 'msg-text';
    const cur = document.createElement('span');
    cur.className = 'cursor-blink';
    textEl.appendChild(cur);
    assistantBody.appendChild(textEl);
    scroll();
  }

  function appendText(chunk) {
    ensureAssistantCard();
    assistantText += chunk;
    const cur = textEl.querySelector('.cursor-blink');
    if (cur) cur.remove();
    textEl.textContent = assistantText;
    const newCur = document.createElement('span');
    newCur.className = 'cursor-blink';
    textEl.appendChild(newCur);
    scroll();
  }

  function addToolPill(name) {
    ensureAssistantCard();
    if (activeToolPill) { activeToolPill.classList.remove('running'); activeToolPill.classList.add('done'); }
    const pill = document.createElement('div');
    pill.className = 'tool-pill running';
    pill.textContent = '⟳ ' + name.replace(/^Semantic:\s*/i, '');
    assistantBody.appendChild(pill);
    activeToolPill = pill;
    scroll();
  }

  function addNote(text, cls) {
    ensureAssistantCard();
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    assistantBody.appendChild(d);
    scroll();
  }

  // Standalone note in the history (not tied to an assistant card) — used by the
  // ack watchdog when bk1 produced no output at all for a turn.
  function addSystemNote(text) {
    const d = document.createElement('div');
    d.className = 'system-note';
    d.textContent = text;
    chatHistory.appendChild(d);
    scroll();
  }

  function finishTurn() {
    if (textEl) {
      const cur = textEl.querySelector('.cursor-blink');
      if (cur) cur.remove();
    }
    if (activeToolPill) { activeToolPill.classList.remove('running'); activeToolPill.classList.add('done'); }
    assistantBody = null;
    assistantText = '';
    textEl = null;
    activeToolPill = null;
    // A turn that ended without bk1 echoing its user event (cancel, error,
    // terminal death) must not leave the dedup armed — it would swallow the
    // next turn's user card.
    turnStarted = false;
    clearAck();
  }

  function scroll() { chatHistory.scrollTop = chatHistory.scrollHeight; }

  // ── Messages from the extension host ───────────────────────
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'chatEvent': {
        // Any event from bk1 proves it picked up the turn — disarm the watchdog.
        clearAck();
        const e = msg.event;
        switch (e.type) {
          case 'user':
            // doSubmit() already rendered the card — skip the echo once.
            if (turnStarted) { turnStarted = false; }
            else { startTurn(e.text); setResponding(true); }
            break;
          case 'text':
            appendText(e.chunk);
            break;
          case 'tool_start':
            addToolPill(e.name);
            break;
          case 'done':
            if (e.error) addNote('✕ ' + e.error, 'tool-pill error');
            else if (e.cancelled) addNote('(cancelled)', 'muted-note');
            finishTurn();
            setResponding(false);
            break;
        }
        break;
      }
      case 'done': // host fallback (e.g. cancel with no live terminal)
        finishTurn();
        setResponding(false);
        break;
      case 'petState':
        lastPet = msg;
        heroMotchi.drawPet(msg);
        stageMotchi.drawPet(msg);
        applyPetState(msg);
        break;
      case 'terminalStatus':
        setTermOpen(msg.open);
        // bk1's process died (or was stopped) — any in-flight turn is over.
        // Without this the responding flag could stick and wedge the input.
        if (!msg.open && responding) { finishTurn(); setResponding(false); }
        break;
    }
  });

  // ── File attachments ───────────────────────────────────────
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
    return new Promise((r) => {
      const fr = new FileReader();
      fr.onload = (e) => r(e.target.result);
      if (f.type.startsWith('image/')) fr.readAsDataURL(f);
      else fr.readAsText(f);
    });
  }

  function renderChips() {
    chipList.innerHTML = '';
    pendingFiles.forEach((f, i) => {
      const c = document.createElement('div');
      c.className = 'chip';
      const s = document.createElement('span');
      s.textContent = f.name;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '×';
      b.addEventListener('click', () => { pendingFiles.splice(i, 1); renderChips(); });
      c.appendChild(s);
      c.appendChild(b);
      chipList.appendChild(c);
    });
  }

  function clearFiles() { pendingFiles = []; renderChips(); }

  // ── Pet tab: stats + actions ───────────────────────────────
  function titleCase(s) {
    if (!s) return 'Motchi';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function setMetric(fillEl, valEl, pct) {
    const v = Math.round(Math.max(0, Math.min(100, pct)));
    fillEl.style.width = v + '%';
    valEl.textContent = v + '%';
  }

  function applyPetState(msg) {
    petNameEl.textContent = titleCase(msg.name);
    petLevelEl.textContent = 'Level ' + msg.level;
    xpLabelEl.textContent = msg.into + ' / ' + msg.span + ' XP';
    const pct = Math.round((msg.into / msg.span) * 100);
    xpFillEl.style.width = pct + '%';
    nextFillEl.style.width = pct + '%';
    nextXpEl.textContent = (msg.span - msg.into) + ' XP to go';
    statMoodEl.textContent = titleCase(msg.mood);
    statCoinsEl.textContent = String(msg.coins);
    setMetric(fillFull, valFull, 100 - msg.hunger);
    setMetric(fillEnergy, valEnergy, msg.energy);
    setMetric(fillHappy, valHappy, msg.happiness);
    updateActionState();
  }

  function updateActionState() {
    for (const btn of actionBtns) {
      const cost = Number(btn.dataset.cost || 0);
      const broke = lastPet ? lastPet.coins < cost : false;
      btn.disabled = responding || broke;
      btn.title = broke ? 'Not enough coins' : '';
    }
  }

  for (const btn of actionBtns) {
    btn.addEventListener('click', () => submitCommand(btn.dataset.cmd));
  }

  // Rename: ✎ toggles an inline input; ✓ or Enter submits /pet name <name>.
  renameBtn.addEventListener('click', () => {
    renameRow.hidden = !renameRow.hidden;
    if (!renameRow.hidden) { renameInput.value = ''; renameInput.focus(); }
  });
  function doRename() {
    const name = renameInput.value.trim();
    if (!name || responding) return;
    renameRow.hidden = true;
    submitCommand('/pet name ' + name);
  }
  renameOk.addEventListener('click', doRename);
  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doRename(); }
    if (e.key === 'Escape') { renameRow.hidden = true; }
  });

  updateActionState();
})();
