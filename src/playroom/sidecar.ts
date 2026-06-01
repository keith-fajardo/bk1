// Playroom transport: WebSocket client to the playroom relay.
//
// API surface kept similar to the previous Tailscale-based sidecar so the
// lobby code only needs minor adjustments:
//   .start()                  open the WebSocket connection
//   .create()                 server returns a pin
//   .join(pin)                pair with an existing room
//   .send(data)               forward a string to the peer
//   .close()                  drop the connection
//   .on(event, handler)       subscribe to peer events
//
// Differences vs. the old sidecar:
//   - No separate `init` (no auth step) — relay connection is the only setup.
//   - `auth_url` event is gone.
//   - `peer_connected` fires when both peers are paired in the relay.
//   - `peer_message` payload is the line as sent (no framing for us — the
//     relay forwards one message per data op).

import type { RelayClientMsg, RelayServerMsg, PlayerRole } from './relay-protocol';

// Default points at the deployed Cloudflare Worker so plain `bun run dev`
// works out of the box for end users — no env var to set. The PLAYROOM_RELAY_URL
// env var still wins if present, which is what dev/CI uses to point at a
// local relay (`bun run relay` → ws://localhost:8787) without rebuilding.
//
// The URL is not a secret: it's a public Cloudflare endpoint, and the only
// access control the relay enforces is "you need a valid pin to join a room."
// Hard-coding here is intentional and standard practice for clients that
// point at a known public backend.
const DEFAULT_RELAY_URL =
  process.env.PLAYROOM_RELAY_URL ?? 'wss://bk1-playroom-relay.bk1.workers.dev';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
};

type EventName =
  | 'peer_connected'
  | 'peer_disconnected'
  | 'peer_message'
  | 'spectator_joined'
  | 'spectator_left'
  | 'joined_as_spectator'
  | 'error';
type EventListener = (data: any) => void;

interface CreateResult { pin: string; }
// `join` resolves with the role the relay assigned. 'joiner' = primary player
// (both player slots are now filled); 'spectator' = view-only attach.
interface JoinResult { role: 'joiner' | 'spectator'; pin: string; }

// Send a ping this often while connected. Must be comfortably below the edge's
// idle-WebSocket timeout (Cloudflare drops quiet sockets after ~100s, but turn
// gaps in a game can be long, so we stay well under). The relay answers with a
// native pong without waking its Durable Object.
const KEEPALIVE_MS = 25_000;

// Auto-reconnect on an unexpected close: a few quick retries before giving up
// and surfacing the disconnect to the UI.
const RECONNECT_TRIES = 3;
const RECONNECT_DELAY_MS = 800;

export class PlayroomSidecar {
  private ws: WebSocket | null = null;
  private url: string = DEFAULT_RELAY_URL;
  private listeners = new Map<EventName, Set<EventListener>>();
  private pendingCreate: Pending | null = null;
  private pendingJoin: Pending | null = null;
  private opened = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  // True once the caller asked us to close; suppresses reconnect so esc/leave
  // doesn't trigger a rejoin race.
  private intentionalClose = false;
  // Set after a successful create/join so reconnect knows what room to rejoin.
  // Host can't be rebuilt (its room is torn down relay-side the moment its
  // socket drops), so only joiner/spectator pins are reconnectable.
  private roomPin: string | null = null;
  // Role assigned by the relay. Set after create or join resolves; null until
  // then. Exposed so the UI can render player vs spectator chrome.
  private _role: PlayerRole | null = null;
  get role(): PlayerRole | null { return this._role; }

  async start(url: string = DEFAULT_RELAY_URL): Promise<void> {
    if (this.ws) return;
    this.url = url;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.opened = false;
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => {
        this.opened = true;
        this.startKeepalive();
        resolve();
      };
      this.ws!.onerror = () => {
        if (!this.opened) reject(new Error(`relay connection failed: ${this.url}`));
      };
      this.ws!.onmessage = (e) => this.handleMessage(e.data as string);
      this.ws!.onclose = () => this.handleClose();
    });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      this.sendRaw({ op: 'ping' });
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
  }

  async create(): Promise<CreateResult> {
    if (!this.ws) throw new Error('relay not connected');
    if (this.pendingCreate) throw new Error('create already in flight');
    return new Promise((resolve, reject) => {
      this.pendingCreate = { resolve, reject };
      this.sendRaw({ op: 'create' });
    });
  }

  async join(pin: string): Promise<JoinResult> {
    if (!this.ws) throw new Error('relay not connected');
    if (this.pendingJoin) throw new Error('join already in flight');
    // Remember the pin up front so an unexpected drop can rejoin the same room
    // (the relay's `joined` ack carries no pin). Cleared again if the join
    // itself fails.
    this.roomPin = pin;
    return new Promise((resolve, reject) => {
      this.pendingJoin = {
        resolve,
        reject: (err) => { this.roomPin = null; reject(err); },
      };
      this.sendRaw({ op: 'join', pin });
    });
  }

  // Kept as a Promise so existing call sites can `.catch` — the WebSocket
  // send itself is synchronous best-effort.
  async send(data: string): Promise<void> {
    this.sendRaw({ op: 'data', payload: data });
  }

  on(name: EventName, fn: EventListener): () => void {
    let set = this.listeners.get(name);
    if (!set) { set = new Set(); this.listeners.set(name, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.stopKeepalive();
    if (!this.ws) return;
    try { this.ws.close(); } catch {}
    this.ws = null;
  }

  // Internals ────────────────────────────────────────────────────────────────
  private sendRaw(msg: RelayClientMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(msg)); } catch {}
  }

  private handleMessage(raw: string): void {
    let msg: RelayServerMsg;
    try { msg = JSON.parse(raw) as RelayServerMsg; }
    catch { return; }
    switch (msg.op) {
      case 'created':
        this._role = 'host';
        this.pendingCreate?.resolve({ pin: msg.pin });
        this.pendingCreate = null;
        return;
      case 'joined':
        this._role = 'joiner';
        this.pendingJoin?.resolve({ role: 'joiner', pin: '' });
        this.pendingJoin = null;
        return;
      case 'joined_as_spectator':
        this._role = 'spectator';
        this.roomPin = msg.pin;
        this.pendingJoin?.resolve({ role: 'spectator', pin: msg.pin });
        this.pendingJoin = null;
        // Also fire as an event so the lobby can immediately swap to spectator chrome.
        this.emit('joined_as_spectator', { pin: msg.pin });
        return;
      case 'pong':
        // Keepalive ack — nothing to do; the round-trip already kept the
        // connection warm at the edge.
        return;
      case 'paired':
        this.emit('peer_connected', {});
        return;
      case 'data':
        // `from` is set when the relay forwards a player's message. Spectators
        // use it to attribute; players ignore it (they only have one peer).
        this.emit('peer_message', { line: msg.payload, from: msg.from });
        return;
      case 'spectator_joined':
        this.emit('spectator_joined', { count: msg.count });
        return;
      case 'spectator_left':
        this.emit('spectator_left', { count: msg.count });
        return;
      case 'peer_left':
        this.emit('peer_disconnected', {});
        return;
      case 'error':
        // Bias toward whichever request is pending; if neither, surface as an event.
        if (this.pendingCreate) { this.pendingCreate.reject(new Error(msg.msg)); this.pendingCreate = null; return; }
        if (this.pendingJoin)   { this.pendingJoin.reject(new Error(msg.msg));   this.pendingJoin = null;   return; }
        this.emit('error', { msg: msg.msg });
        return;
    }
  }

  private handleClose(): void {
    this.stopKeepalive();
    this.ws = null;

    const err = new Error('relay connection closed');
    this.pendingCreate?.reject(err); this.pendingCreate = null;
    this.pendingJoin?.reject(err);   this.pendingJoin = null;

    if (this.intentionalClose) return;

    // Unexpected drop. A joiner or spectator can transparently rejoin the same
    // pin (the relay keeps the room alive now). A host can't: the relay tears
    // its room down the instant the host socket drops, so there's nothing to
    // rejoin — surface the disconnect immediately.
    if ((this._role === 'joiner' || this._role === 'spectator') && this.roomPin) {
      this.reconnect().catch(() => {});
      return;
    }
    this.emit('peer_disconnected', {});
  }

  private async reconnect(): Promise<void> {
    const pin = this.roomPin!;
    for (let attempt = 1; attempt <= RECONNECT_TRIES; attempt++) {
      await delay(RECONNECT_DELAY_MS * attempt);
      if (this.intentionalClose) return;
      try {
        await this.connect();
        await this.join(pin);
        // Rejoin succeeded. The relay's `paired`/`joined_as_spectator` reply
        // already drove the right event through handleMessage, so the lobby is
        // back in sync — nothing more to emit here.
        return;
      } catch {
        // connect or rejoin failed (room gone, relay unreachable) — try again.
        if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
      }
    }
    // Out of retries — the room is genuinely gone.
    this.emit('peer_disconnected', {});
  }

  private emit(name: EventName, data: any): void {
    const set = this.listeners.get(name);
    if (set) for (const fn of set) fn(data);
  }
}
