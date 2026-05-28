// Local Bun WebSocket relay for the playroom feature. Runs the same protocol
// the future Cloudflare Worker will serve, so the bk1 client doesn't care
// which backend it talks to.
//
// Usage:   bun src/playroom/relay-server.ts
// Listens: ws://localhost:8787 (override with PLAYROOM_RELAY_PORT)
//
// The relay is stateless beyond a room table held in process memory. Two-
// peer rooms only: a third client trying to join an existing pin is rejected.

import {
  type RelayClientMsg,
  type RelayServerMsg,
  generatePin,
  isValidPin,
} from './relay-protocol';

interface Peer {
  ws: WebSocket;
  role: 'host' | 'joiner';
  pin: string;
}

interface Room {
  pin: string;
  host: Peer;
  joiner: Peer | null;
}

const rooms = new Map<string, Room>();
// Reverse lookup so we can clean up rooms when a peer disconnects without
// having to scan the rooms map.
const peerByWs = new WeakMap<WebSocket, Peer>();

function send(ws: WebSocket, msg: RelayServerMsg): void {
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function handle(ws: WebSocket, raw: string): void {
  let msg: RelayClientMsg;
  try { msg = JSON.parse(raw) as RelayClientMsg; }
  catch { send(ws, { op: 'error', msg: 'malformed json' }); return; }

  switch (msg.op) {
    case 'create': {
      if (peerByWs.has(ws)) { send(ws, { op: 'error', msg: 'already in a room' }); return; }
      // Generate a pin; on the wildly improbable chance of collision, retry.
      let pin = generatePin();
      for (let i = 0; i < 5 && rooms.has(pin); i++) pin = generatePin();
      if (rooms.has(pin)) { send(ws, { op: 'error', msg: 'pin generation failed' }); return; }
      const peer: Peer = { ws, role: 'host', pin };
      const room: Room = { pin, host: peer, joiner: null };
      rooms.set(pin, room);
      peerByWs.set(ws, peer);
      send(ws, { op: 'created', pin });
      return;
    }
    case 'join': {
      if (peerByWs.has(ws)) { send(ws, { op: 'error', msg: 'already in a room' }); return; }
      if (!isValidPin(msg.pin)) { send(ws, { op: 'error', msg: 'invalid pin format' }); return; }
      const room = rooms.get(msg.pin);
      if (!room) { send(ws, { op: 'error', msg: 'no room with that pin' }); return; }
      if (room.joiner) { send(ws, { op: 'error', msg: 'room is full' }); return; }
      const peer: Peer = { ws, role: 'joiner', pin: msg.pin };
      room.joiner = peer;
      peerByWs.set(ws, peer);
      send(ws, { op: 'joined' });
      // Notify both sides that the pairing is complete and message relay is live.
      send(room.host.ws, { op: 'paired' });
      send(room.joiner.ws, { op: 'paired' });
      return;
    }
    case 'data': {
      const peer = peerByWs.get(ws);
      if (!peer) { send(ws, { op: 'error', msg: 'not in a room' }); return; }
      const room = rooms.get(peer.pin);
      if (!room) return;
      const other = peer.role === 'host' ? room.joiner : room.host;
      if (!other) return; // peer hasn't joined yet; silently drop
      send(other.ws, { op: 'data', payload: msg.payload });
      return;
    }
  }
}

function disconnect(ws: WebSocket): void {
  const peer = peerByWs.get(ws);
  if (!peer) return;
  peerByWs.delete(ws);
  const room = rooms.get(peer.pin);
  if (!room) return;
  const other = peer.role === 'host' ? room.joiner : room.host;
  if (other) send(other.ws, { op: 'peer_left' });
  rooms.delete(peer.pin);
}

const port = Number(process.env.PLAYROOM_RELAY_PORT ?? 8787);

Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('bk1 playroom relay\n', { status: 200 });
  },
  websocket: {
    message(ws, message) {
      const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
      handle(ws as unknown as WebSocket, raw);
    },
    close(ws) { disconnect(ws as unknown as WebSocket); },
  },
});

console.log(`bk1 playroom relay listening on ws://localhost:${port}`);
