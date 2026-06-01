// bk1 playroom relay — Cloudflare Worker variant.
//
// Same wire protocol as src/playroom/relay-server.ts so the bk1 client
// (src/playroom/sidecar.ts) doesn't change. Two-player rooms plus N
// spectators per pin; spectator-originated data is silently dropped.
//
// Architecture: every connection is routed through one Durable Object
// instance (id "global") that holds the rooms map. Fine for low-volume
// usage; we can shard by pin into per-room DOs later if a single-instance
// bottleneck shows up.
//
// Durability: the DO uses the WebSocket Hibernation API. Without it, a DO
// whose sockets go quiet is evicted from memory within ~10s, taking its
// in-memory room map with it — the next message lands on a fresh instance
// with no rooms and the room "closes for no reason". Hibernation keeps the
// sockets attached across eviction, and we mirror the room map into DO
// storage so it can be rebuilt after a cold start. Combined with the
// auto-response ping (setWebSocketAutoResponse) and the client keepalive,
// idle rooms survive turn gaps instead of being dropped by the edge.
//
// Deploy: cd relay && npx wrangler deploy
// Local dev: cd relay && npx wrangler dev (then PLAYROOM_RELAY_URL=ws://...)

interface Env {
  ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const upgrade = request.headers.get('upgrade');
    if (upgrade !== 'websocket') {
      console.log(`[worker fetch] non-ws request: ${request.url}`);
      return new Response('bk1 playroom relay (cf worker)\n', { status: 200 });
    }
    console.log(`[worker fetch] ws upgrade from ${request.headers.get('cf-connecting-ip') ?? '?'}`);
    const id = env.ROOMS.idFromName('global');
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

// ───────────────────────── shared protocol types ─────────────────────────────
// Inlined so the worker has zero imports from the bk1 source tree (Workers can
// only ship what's in its own bundle). Keep these in sync with
// src/playroom/relay-protocol.ts.

type RelayClientMsg =
  | { op: 'create' }
  | { op: 'join'; pin: string }
  | { op: 'data'; payload: string }
  // Client keepalive. The relay also installs a native auto-response for this
  // op (setWebSocketAutoResponse) so a hibernated socket answers without
  // waking the DO; this handler path only runs if the DO is already awake.
  | { op: 'ping' };

type PlayerRole = 'host' | 'joiner' | 'spectator';

type RelayServerMsg =
  | { op: 'created'; pin: string }
  | { op: 'joined' }
  | { op: 'joined_as_spectator'; pin: string }
  | { op: 'paired' }
  | { op: 'spectator_joined'; count: number }
  | { op: 'spectator_left'; count: number }
  | { op: 'data'; payload: string; from?: 'host' | 'joiner' }
  | { op: 'peer_left' }
  | { op: 'pong' }
  | { op: 'error'; msg: string };

const PIN_CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PIN_LENGTH = 6;

function generatePin(): string {
  let out = '';
  for (let i = 0; i < PIN_LENGTH; i++) {
    out += PIN_CHARSET[Math.floor(Math.random() * PIN_CHARSET.length)];
  }
  return out;
}

function isValidPin(s: string): boolean {
  if (s.length !== PIN_LENGTH) return false;
  for (const ch of s) if (!PIN_CHARSET.includes(ch)) return false;
  return true;
}

// ─────────────────────────── Durable Object ─────────────────────────────────

// Metadata attached to each hibernatable WebSocket. The hibernation runtime
// can evict the DO instance (and any plain instance fields) while keeping the
// sockets alive, so the per-socket role/pin must live ON the socket via
// serializeAttachment — not in a WeakMap, which would be lost on wake.
interface Attachment {
  role: PlayerRole;
  pin: string;
}

// The persisted shape of a room. We can't serialize live WebSocket objects, so
// storage holds only the pin and the membership pin is enough to rebuild the
// room from the sockets the runtime hands back on wake (each socket carries its
// own role via its attachment). Stored under STORAGE_KEY as a string[] of pins.
const STORAGE_KEY = 'roomPins';
const PING_PAYLOAD = JSON.stringify({ op: 'ping' });
const PONG_PAYLOAD = JSON.stringify({ op: 'pong' });

// Grace window after a player's socket drops before we declare the room over.
// A client blip + auto-reconnect (see src/playroom/sidecar.ts) lands well
// within this; if the player rejoins the same pin before the alarm fires, the
// peer never sees a disconnect. Storage key holds a map of pin -> deadline(ms).
const GRACE_KEY = 'graceDeadlines';
const GRACE_MS = 8_000;

interface Peer {
  ws: WebSocket;
  role: PlayerRole;
  pin: string;
}

interface Room {
  pin: string;
  host: Peer | null;
  joiner: Peer | null;
  spectators: Set<Peer>;
}

export class PlayroomRelay {
  private state: DurableObjectState;
  // Rebuilt lazily from the live sockets the runtime owns (see rooms()).
  // Never read directly — always go through rooms() so a freshly-woken
  // instance reconstructs membership before serving a request.
  private roomsCache: Map<string, Room> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
    // A hibernated socket answers a `ping` with `pong` natively — no DO wake,
    // no JS executed — which keeps the edge from idling the connection out
    // during turn gaps. Set once per instance lifetime; cheap to re-set on wake.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING_PAYLOAD, PONG_PAYLOAD),
    );
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('bk1 playroom relay (cf worker)\n', { status: 200 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernatable accept — the runtime, not an in-memory listener, owns the
    // socket. Message/close/error are delivered to the webSocket* methods below
    // and survive instance eviction.
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Rebuild the room map from the sockets the runtime currently owns. After a
  // cold start the runtime re-hands every still-open socket via
  // getWebSockets(); each carries its role+pin in its attachment, so we can
  // reconstitute every room without persisting the socket objects themselves.
  private rooms(): Map<string, Room> {
    if (this.roomsCache) return this.roomsCache;
    const map = new Map<string, Room>();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att) continue;
      let room = map.get(att.pin);
      if (!room) {
        room = { pin: att.pin, host: null, joiner: null, spectators: new Set() };
        map.set(att.pin, room);
      }
      const peer: Peer = { ws, role: att.role, pin: att.pin };
      if (att.role === 'host') room.host = peer;
      else if (att.role === 'joiner') room.joiner = peer;
      else room.spectators.add(peer);
    }
    this.roomsCache = map;
    return map;
  }

  private peerFor(ws: WebSocket): Peer | null {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return null;
    return { ws, role: att.role, pin: att.pin };
  }

  private attach(ws: WebSocket, att: Attachment): void {
    ws.serializeAttachment(att);
  }

  private send(ws: WebSocket | null, msg: RelayServerMsg): void {
    if (!ws) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  private broadcastToPlayers(room: Room, msg: RelayServerMsg): void {
    this.send(room.host?.ws ?? null, msg);
    this.send(room.joiner?.ws ?? null, msg);
  }

  private forwardData(room: Room, from: 'host' | 'joiner', payload: string): void {
    const msg: RelayServerMsg = { op: 'data', payload, from };
    if (from === 'host') this.send(room.joiner?.ws ?? null, msg);
    if (from === 'joiner') this.send(room.host?.ws ?? null, msg);
    for (const spec of room.spectators) this.send(spec.ws, msg);
  }

  private endRoom(room: Room, leftRole: PlayerRole): void {
    const msg: RelayServerMsg = { op: 'peer_left' };
    if (leftRole !== 'host') this.send(room.host?.ws ?? null, msg);
    if (leftRole !== 'joiner') this.send(room.joiner?.ws ?? null, msg);
    for (const spec of room.spectators) {
      if (spec.role !== leftRole) this.send(spec.ws, msg);
    }
    this.rooms().delete(room.pin);
    this.persist();
  }

  // Mirror the live room pins into storage. Storage is the cold-start safety
  // net: the source of truth is the set of live sockets, but persisting the
  // pin set lets us detect/clean orphaned rooms and keeps the DO classified as
  // stateful so the platform treats eviction as hibernation, not teardown.
  private persist(): void {
    const pins = [...this.rooms().keys()];
    this.state.storage.put(STORAGE_KEY, pins).catch(() => {});
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.handle(ws, raw);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const peer = this.peerFor(ws);
    console.log(`[close] role=${peer?.role ?? '?'} pin=${peer?.pin ?? '?'} code=${code} reason="${reason}" wasClean=${wasClean}`);
    this.disconnect(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const peer = this.peerFor(ws);
    console.log(`[error] role=${peer?.role ?? '?'} pin=${peer?.pin ?? '?'} error=${String(error)}`);
    this.disconnect(ws);
  }

  private handle(ws: WebSocket, raw: string): void {
    let msg: RelayClientMsg;
    try { msg = JSON.parse(raw) as RelayClientMsg; }
    catch { this.send(ws, { op: 'error', msg: 'malformed json' }); return; }

    const rooms = this.rooms();

    switch (msg.op) {
      case 'ping': {
        // Reached only if the DO is already awake; the hibernated path is
        // handled natively by setWebSocketAutoResponse.
        this.send(ws, { op: 'pong' });
        return;
      }
      case 'create': {
        if (this.peerFor(ws)) { this.send(ws, { op: 'error', msg: 'already in a room' }); return; }
        let pin = generatePin();
        for (let i = 0; i < 5 && rooms.has(pin); i++) pin = generatePin();
        if (rooms.has(pin)) { this.send(ws, { op: 'error', msg: 'pin generation failed' }); return; }
        const peer: Peer = { ws, role: 'host', pin };
        const room: Room = { pin, host: peer, joiner: null, spectators: new Set() };
        rooms.set(pin, room);
        this.attach(ws, { role: 'host', pin });
        this.persist();
        this.send(ws, { op: 'created', pin });
        console.log(`[create] pin=${pin}`);
        return;
      }
      case 'join': {
        if (this.peerFor(ws)) { this.send(ws, { op: 'error', msg: 'already in a room' }); return; }
        if (!isValidPin(msg.pin)) { this.send(ws, { op: 'error', msg: 'invalid pin format' }); return; }
        const room = rooms.get(msg.pin);
        if (!room || !room.host) { this.send(ws, { op: 'error', msg: 'no room with that pin' }); return; }
        if (!room.joiner) {
          const peer: Peer = { ws, role: 'joiner', pin: msg.pin };
          room.joiner = peer;
          this.attach(ws, { role: 'joiner', pin: msg.pin });
          // If this slot was vacated by a drop, cancel the pending teardown so
          // the alarm doesn't later kill the now-live room.
          this.clearGrace(msg.pin).catch(() => {});
          this.persist();
          this.send(ws, { op: 'joined' });
          this.send(room.host.ws, { op: 'paired' });
          this.send(room.joiner.ws, { op: 'paired' });
          console.log(`[join joiner] pin=${msg.pin}`);
          return;
        }
        const peer: Peer = { ws, role: 'spectator', pin: msg.pin };
        room.spectators.add(peer);
        this.attach(ws, { role: 'spectator', pin: msg.pin });
        this.persist();
        this.send(ws, { op: 'joined_as_spectator', pin: msg.pin });
        const count = room.spectators.size;
        this.broadcastToPlayers(room, { op: 'spectator_joined', count });
        console.log(`[join spectator] pin=${msg.pin} watchers=${count}`);
        return;
      }
      case 'data': {
        const peer = this.peerFor(ws);
        if (!peer) { this.send(ws, { op: 'error', msg: 'not in a room' }); return; }
        const room = rooms.get(peer.pin);
        if (!room) return;
        if (peer.role === 'spectator') {
          console.log(`[data dropped: spectator] pin=${peer.pin} payload=${msg.payload.slice(0, 80)}`);
          return;
        }
        // Sample only the message type for log brevity — payloads can be long.
        let typeHint = '?';
        try { typeHint = (JSON.parse(msg.payload) as { type?: string }).type ?? '?'; } catch {}
        console.log(`[data] from=${peer.role} pin=${peer.pin} type=${typeHint}`);
        this.forwardData(room, peer.role as 'host' | 'joiner', msg.payload);
        return;
      }
    }
  }

  private disconnect(ws: WebSocket): void {
    const peer = this.peerFor(ws);
    if (!peer) return;
    const room = this.rooms().get(peer.pin);
    if (!room) return;
    if (peer.role === 'spectator') {
      // Remove by ws identity — the rebuilt Peer is a fresh object each call.
      for (const spec of room.spectators) {
        if (spec.ws === ws) { room.spectators.delete(spec); break; }
      }
      const count = room.spectators.size;
      this.broadcastToPlayers(room, { op: 'spectator_left', count });
      this.persist();
      return;
    }
    // The joiner can transparently reconnect (the host stays put and the
    // joiner's client rejoins the same pin), so hold the room open for a grace
    // window instead of ending it. Clear the slot in the cached room so a
    // rejoin within the window takes the `!room.joiner` branch (re-pair, host
    // never learns) and so the grace alarm sees the slot as vacant. A host drop
    // has nothing to reconnect to (no host socket = no room), so end it now.
    if (peer.role === 'joiner' && room.host) {
      room.joiner = null;
      this.scheduleGrace(room.pin);
      return;
    }
    this.endRoom(room, peer.role);
  }

  private async scheduleGrace(pin: string): Promise<void> {
    const deadline = Date.now() + GRACE_MS;
    const grace = await this.loadGrace();
    grace.set(pin, deadline);
    await this.saveGrace(grace);
    // Arm (or pull in) the alarm so it fires at or before this deadline. If an
    // earlier deadline already armed it, leave that one — alarm() handles all
    // due pins together and re-arms for the next.
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > deadline) {
      await this.state.storage.setAlarm(deadline);
    }
  }

  async alarm(): Promise<void> {
    const grace = await this.loadGrace();
    if (grace.size === 0) return;
    const rooms = this.rooms();
    const now = Date.now();
    let next: number | null = null;
    for (const [pin, deadline] of [...grace]) {
      if (deadline > now) { next = next === null ? deadline : Math.min(next, deadline); continue; }
      grace.delete(pin);
      const room = rooms.get(pin);
      // Rejoined in time → room.joiner is set again → nothing to do.
      // Still vacant → the player never came back; tell whoever remains.
      if (room && room.host && !room.joiner) {
        this.send(room.host.ws, { op: 'peer_left' });
        for (const spec of room.spectators) this.send(spec.ws, { op: 'peer_left' });
        rooms.delete(pin);
      }
    }
    await this.saveGrace(grace);
    this.persist();
    if (next !== null) await this.state.storage.setAlarm(next);
  }

  private async loadGrace(): Promise<Map<string, number>> {
    // Stored as [pin, deadlineMs][]; rebuild into a Map. Deadlines are absolute
    // epoch ms so a DO wake/sleep cycle doesn't reset the countdown.
    const raw = (await this.state.storage.get(GRACE_KEY)) as [string, number][] | undefined;
    return raw ? new Map(raw) : new Map();
  }

  private async saveGrace(grace: Map<string, number>): Promise<void> {
    if (grace.size === 0) { await this.state.storage.delete(GRACE_KEY); return; }
    await this.state.storage.put(GRACE_KEY, [...grace]);
  }

  // Called when a joiner re-pairs to a pin that was in its grace window — drop
  // the pending teardown so the alarm doesn't later kill the live room.
  private async clearGrace(pin: string): Promise<void> {
    const grace = await this.loadGrace();
    if (grace.delete(pin)) await this.saveGrace(grace);
  }
}
