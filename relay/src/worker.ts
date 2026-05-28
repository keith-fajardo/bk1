// bk1 playroom relay — Cloudflare Worker variant.
//
// Same wire protocol as src/playroom/relay-server.ts so the bk1 client
// (src/playroom/sidecar.ts) doesn't change. Two-player rooms plus N
// spectators per pin; spectator-originated data is silently dropped.
//
// Architecture: every connection is routed through one Durable Object
// instance (id "global") that holds the rooms map in memory. Fine for
// low-volume usage; we can shard by pin into per-room DOs later if a
// single-instance bottleneck shows up.
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
  | { op: 'data'; payload: string };

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

interface Peer {
  ws: WebSocket;
  role: PlayerRole;
  pin: string;
}

interface Room {
  pin: string;
  host: Peer;
  joiner: Peer | null;
  spectators: Set<Peer>;
}

export class PlayroomRelay {
  // The DurableObjectState is required by Cloudflare's runtime but we don't
  // currently use its persistent storage — rooms live in memory and die when
  // either player disconnects, which is the right lifecycle for a match.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_state: DurableObjectState) {}

  private rooms = new Map<string, Room>();
  private peerByWs = new WeakMap<WebSocket, Peer>();

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('bk1 playroom relay (cf worker)\n', { status: 200 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    server.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
      this.handle(server, raw);
    });
    server.addEventListener('close', (ev: CloseEvent) => {
      const peer = this.peerByWs.get(server);
      console.log(`[close] role=${peer?.role ?? '?'} pin=${peer?.pin ?? '?'} code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`);
      this.disconnect(server);
    });
    server.addEventListener('error', (ev) => {
      const peer = this.peerByWs.get(server);
      console.log(`[error] role=${peer?.role ?? '?'} pin=${peer?.pin ?? '?'} event=${JSON.stringify(ev)}`);
      this.disconnect(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, msg: RelayServerMsg): void {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  private broadcastToPlayers(room: Room, msg: RelayServerMsg): void {
    this.send(room.host.ws, msg);
    if (room.joiner) this.send(room.joiner.ws, msg);
  }

  private forwardData(room: Room, from: 'host' | 'joiner', payload: string): void {
    const msg: RelayServerMsg = { op: 'data', payload, from };
    if (from === 'host' && room.joiner) this.send(room.joiner.ws, msg);
    if (from === 'joiner') this.send(room.host.ws, msg);
    for (const spec of room.spectators) this.send(spec.ws, msg);
  }

  private endRoom(room: Room, leftRole: PlayerRole): void {
    const msg: RelayServerMsg = { op: 'peer_left' };
    if (leftRole !== 'host') this.send(room.host.ws, msg);
    if (leftRole !== 'joiner' && room.joiner) this.send(room.joiner.ws, msg);
    for (const spec of room.spectators) {
      if (spec.role !== leftRole) this.send(spec.ws, msg);
    }
    this.rooms.delete(room.pin);
  }

  private handle(ws: WebSocket, raw: string): void {
    let msg: RelayClientMsg;
    try { msg = JSON.parse(raw) as RelayClientMsg; }
    catch { this.send(ws, { op: 'error', msg: 'malformed json' }); return; }

    switch (msg.op) {
      case 'create': {
        if (this.peerByWs.has(ws)) { this.send(ws, { op: 'error', msg: 'already in a room' }); return; }
        let pin = generatePin();
        for (let i = 0; i < 5 && this.rooms.has(pin); i++) pin = generatePin();
        if (this.rooms.has(pin)) { this.send(ws, { op: 'error', msg: 'pin generation failed' }); return; }
        const peer: Peer = { ws, role: 'host', pin };
        const room: Room = { pin, host: peer, joiner: null, spectators: new Set() };
        this.rooms.set(pin, room);
        this.peerByWs.set(ws, peer);
        this.send(ws, { op: 'created', pin });
        console.log(`[create] pin=${pin}`);
        return;
      }
      case 'join': {
        if (this.peerByWs.has(ws)) { this.send(ws, { op: 'error', msg: 'already in a room' }); return; }
        if (!isValidPin(msg.pin)) { this.send(ws, { op: 'error', msg: 'invalid pin format' }); return; }
        const room = this.rooms.get(msg.pin);
        if (!room) { this.send(ws, { op: 'error', msg: 'no room with that pin' }); return; }
        if (!room.joiner) {
          const peer: Peer = { ws, role: 'joiner', pin: msg.pin };
          room.joiner = peer;
          this.peerByWs.set(ws, peer);
          this.send(ws, { op: 'joined' });
          this.send(room.host.ws, { op: 'paired' });
          this.send(room.joiner.ws, { op: 'paired' });
          console.log(`[join joiner] pin=${msg.pin}`);
          return;
        }
        const peer: Peer = { ws, role: 'spectator', pin: msg.pin };
        room.spectators.add(peer);
        this.peerByWs.set(ws, peer);
        this.send(ws, { op: 'joined_as_spectator', pin: msg.pin });
        const count = room.spectators.size;
        this.broadcastToPlayers(room, { op: 'spectator_joined', count });
        console.log(`[join spectator] pin=${msg.pin} watchers=${count}`);
        return;
      }
      case 'data': {
        const peer = this.peerByWs.get(ws);
        if (!peer) { this.send(ws, { op: 'error', msg: 'not in a room' }); return; }
        const room = this.rooms.get(peer.pin);
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
    const peer = this.peerByWs.get(ws);
    if (!peer) return;
    this.peerByWs.delete(ws);
    const room = this.rooms.get(peer.pin);
    if (!room) return;
    if (peer.role === 'spectator') {
      room.spectators.delete(peer);
      const count = room.spectators.size;
      this.broadcastToPlayers(room, { op: 'spectator_left', count });
      return;
    }
    this.endRoom(room, peer.role);
  }
}
