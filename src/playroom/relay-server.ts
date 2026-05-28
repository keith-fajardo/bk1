// Local Bun WebSocket relay for the playroom feature. Runs the same protocol
// the future Cloudflare Worker will serve, so the bk1 client doesn't care
// which backend it talks to.
//
// Usage:   bun src/playroom/relay-server.ts
// Listens: ws://localhost:8787 (override with PLAYROOM_RELAY_PORT)
//
// Room model: two players (host + joiner) plus any number of spectators.
// Once the host has created and the joiner has joined, additional `join`
// requests for the same pin attach as spectators. Spectators receive every
// data message from both players (tagged with `from`) but cannot send.

import {
  type RelayClientMsg,
  type RelayServerMsg,
  type PlayerRole,
  generatePin,
  isValidPin,
} from './relay-protocol';

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

const rooms = new Map<string, Room>();
// Reverse lookup so we can clean up rooms when a peer disconnects without
// having to scan the rooms map.
const peerByWs = new WeakMap<WebSocket, Peer>();

function send(ws: WebSocket, msg: RelayServerMsg): void {
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function broadcastToPlayers(room: Room, msg: RelayServerMsg): void {
  send(room.host.ws, msg);
  if (room.joiner) send(room.joiner.ws, msg);
}

function forwardData(room: Room, from: 'host' | 'joiner', payload: string): void {
  const msg: RelayServerMsg = { op: 'data', payload, from };
  // Player → other player
  if (from === 'host' && room.joiner) send(room.joiner.ws, msg);
  if (from === 'joiner') send(room.host.ws, msg);
  // Both player streams → all spectators
  for (const spec of room.spectators) send(spec.ws, msg);
}

function endRoom(room: Room, leftRole: PlayerRole): void {
  // Notify everyone still in the room that the session is over.
  const msg: RelayServerMsg = { op: 'peer_left' };
  if (leftRole !== 'host')    send(room.host.ws, msg);
  if (leftRole !== 'joiner' && room.joiner) send(room.joiner.ws, msg);
  for (const spec of room.spectators) {
    if (spec.role !== leftRole) send(spec.ws, msg);
  }
  rooms.delete(room.pin);
}

function handle(ws: WebSocket, raw: string): void {
  let msg: RelayClientMsg;
  try { msg = JSON.parse(raw) as RelayClientMsg; }
  catch { send(ws, { op: 'error', msg: 'malformed json' }); return; }

  switch (msg.op) {
    case 'create': {
      if (peerByWs.has(ws)) { send(ws, { op: 'error', msg: 'already in a room' }); return; }
      let pin = generatePin();
      for (let i = 0; i < 5 && rooms.has(pin); i++) pin = generatePin();
      if (rooms.has(pin)) { send(ws, { op: 'error', msg: 'pin generation failed' }); return; }
      const peer: Peer = { ws, role: 'host', pin };
      const room: Room = { pin, host: peer, joiner: null, spectators: new Set() };
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
      if (!room.joiner) {
        // Slot 2 — primary joiner. Both players get `paired`.
        const peer: Peer = { ws, role: 'joiner', pin: msg.pin };
        room.joiner = peer;
        peerByWs.set(ws, peer);
        send(ws, { op: 'joined' });
        send(room.host.ws, { op: 'paired' });
        send(room.joiner.ws, { op: 'paired' });
        return;
      }
      // Both player slots are filled — attach as spectator.
      const peer: Peer = { ws, role: 'spectator', pin: msg.pin };
      room.spectators.add(peer);
      peerByWs.set(ws, peer);
      send(ws, { op: 'joined_as_spectator', pin: msg.pin });
      // Tell both players that a watcher came in (with updated count).
      const count = room.spectators.size;
      broadcastToPlayers(room, { op: 'spectator_joined', count });
      return;
    }
    case 'data': {
      const peer = peerByWs.get(ws);
      if (!peer) { send(ws, { op: 'error', msg: 'not in a room' }); return; }
      const room = rooms.get(peer.pin);
      if (!room) return;
      // Spectators are view-only. Drop their sends silently — the client
      // shouldn't be calling .send() in spectator mode anyway, but we never
      // want a malicious spectator to inject choices into a match.
      if (peer.role === 'spectator') return;
      forwardData(room, peer.role as 'host' | 'joiner', msg.payload);
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

  if (peer.role === 'spectator') {
    // One watcher leaving doesn't end the room. Tell the players.
    room.spectators.delete(peer);
    const count = room.spectators.size;
    broadcastToPlayers(room, { op: 'spectator_left', count });
    return;
  }

  // Host or joiner left — the match is over for everyone.
  endRoom(room, peer.role);
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
