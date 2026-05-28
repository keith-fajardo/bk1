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

export class PlayroomSidecar {
  private ws: WebSocket | null = null;
  private listeners = new Map<EventName, Set<EventListener>>();
  private pendingCreate: Pending | null = null;
  private pendingJoin: Pending | null = null;
  private opened = false;
  // Role assigned by the relay. Set after create or join resolves; null until
  // then. Exposed so the UI can render player vs spectator chrome.
  private _role: PlayerRole | null = null;
  get role(): PlayerRole | null { return this._role; }

  async start(url: string = DEFAULT_RELAY_URL): Promise<void> {
    if (this.ws) return;
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => { this.opened = true; resolve(); };
      this.ws!.onerror = (e) => {
        if (!this.opened) reject(new Error(`relay connection failed: ${url}`));
      };
      this.ws!.onmessage = (e) => this.handleMessage(e.data as string);
      this.ws!.onclose = () => this.handleClose();
    });
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
    return new Promise((resolve, reject) => {
      this.pendingJoin = { resolve, reject };
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
        this.pendingJoin?.resolve({ role: 'spectator', pin: msg.pin });
        this.pendingJoin = null;
        // Also fire as an event so the lobby can immediately swap to spectator chrome.
        this.emit('joined_as_spectator', { pin: msg.pin });
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
    const err = new Error('relay connection closed');
    this.pendingCreate?.reject(err); this.pendingCreate = null;
    this.pendingJoin?.reject(err);   this.pendingJoin = null;
    this.emit('error', { msg: 'relay disconnected' });
    this.ws = null;
  }

  private emit(name: EventName, data: any): void {
    const set = this.listeners.get(name);
    if (set) for (const fn of set) fn(data);
  }
}
