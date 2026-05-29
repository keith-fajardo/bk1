// Application-level message types exchanged over the playroom data channel.
// One line of JSON = one message. The sidecar handles the line framing.
//
// Validation lives in `parseGameMessage` below — the channel is treated as
// untrusted input even though Tailscale provides the transport encryption.

import type { PetState } from '../pet';

export type JakenpoyChoice = 'bato' | 'gunting' | 'papel';

export type GameMessage =
  | { type: 'hello'; pet: PetState }
  // Sent by whichever player launches a game from the lobby; everyone else
  // (the other player + any spectators) auto-routes into that game's view.
  | { type: 'game_started'; game: 'jakenpoy' | 'race' | 'artillery' | 'longjump' | 'shotput' }
  // Sent by whoever exits a game (esc or match-over → ↵). Returns all
  // viewers to the lobby.
  | { type: 'game_ended' }
  | { type: 'jakenpoy_choice'; round: number; choice: JakenpoyChoice }
  | { type: 'jakenpoy_quit' }
  | { type: 'race_ready' }
  | { type: 'race_position'; col: number }
  | { type: 'race_finished'; elapsed_ms: number }
  | { type: 'race_quit' }
  // Artillery (Gunbound-style turn-based duel). The active player's UI
  // mutates angle/power locally; only the COMMITTED shot crosses the wire.
  // Both clients then simulate the trajectory deterministically from
  // {angle, power, wind} — wind is derived per turn from a shared seed
  // (turn number), so no separate wind broadcast is needed.
  | { type: 'artillery_ready' }
  | { type: 'artillery_fire'; angle: number; power: number }
  | { type: 'artillery_quit' }
  // Long Jump (Track-&-Field-style mash-to-run + space-to-jump). No live
  // runup-position broadcasts — runup is local on each side. The committed
  // jump's outcome is the only thing that crosses the wire:
  //   distance_m — landed metres (0 on foul)
  //   fouled     — true if the space press happened past the foul line
  | { type: 'longjump_ready' }
  | { type: 'longjump_finished'; distance_m: number; fouled: boolean }
  | { type: 'longjump_quit' }
  // Shot Put — aim angle, charge power, time the release.
  //   distance_m — landed metres (0 on foul)
  //   fouled     — release came too late / over-rotation out of circle
  | { type: 'shotput_ready' }
  | { type: 'shotput_finished'; distance_m: number; fouled: boolean }
  | { type: 'shotput_quit' };

export function encodeMessage(msg: GameMessage): string {
  return JSON.stringify(msg);
}

// Parse and validate a line from the peer. Returns null for any line that
// doesn't conform — drop silently rather than throwing, so a noisy peer
// can't crash us.
export function parseGameMessage(line: string): GameMessage | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!isObject(raw)) return null;
  const t = (raw as { type?: unknown }).type;
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'hello': {
      const pet = (raw as { pet?: unknown }).pet;
      if (!isPetState(pet)) return null;
      return { type: 'hello', pet };
    }
    case 'jakenpoy_choice': {
      const round = (raw as { round?: unknown }).round;
      const choice = (raw as { choice?: unknown }).choice;
      if (typeof round !== 'number' || !Number.isFinite(round)) return null;
      if (choice !== 'bato' && choice !== 'gunting' && choice !== 'papel') return null;
      return { type: 'jakenpoy_choice', round, choice };
    }
    case 'jakenpoy_quit':
      return { type: 'jakenpoy_quit' };
    case 'game_started': {
      const game = (raw as { game?: unknown }).game;
      if (game !== 'jakenpoy' && game !== 'race' && game !== 'artillery' && game !== 'longjump' && game !== 'shotput') return null;
      return { type: 'game_started', game };
    }
    case 'game_ended':
      return { type: 'game_ended' };
    case 'race_ready':
      return { type: 'race_ready' };
    case 'race_position': {
      const col = (raw as { col?: unknown }).col;
      if (typeof col !== 'number' || !Number.isFinite(col)) return null;
      return { type: 'race_position', col: Math.max(0, Math.floor(col)) };
    }
    case 'race_finished': {
      const e = (raw as { elapsed_ms?: unknown }).elapsed_ms;
      if (typeof e !== 'number' || !Number.isFinite(e) || e < 0) return null;
      return { type: 'race_finished', elapsed_ms: Math.floor(e) };
    }
    case 'race_quit':
      return { type: 'race_quit' };
    case 'artillery_ready':
      return { type: 'artillery_ready' };
    case 'artillery_fire': {
      const angle = (raw as { angle?: unknown }).angle;
      const power = (raw as { power?: unknown }).power;
      if (typeof angle !== 'number' || !Number.isFinite(angle)) return null;
      if (typeof power !== 'number' || !Number.isFinite(power)) return null;
      return { type: 'artillery_fire', angle, power };
    }
    case 'artillery_quit':
      return { type: 'artillery_quit' };
    case 'longjump_ready':
      return { type: 'longjump_ready' };
    case 'longjump_finished': {
      const d = (raw as { distance_m?: unknown }).distance_m;
      const fouled = (raw as { fouled?: unknown }).fouled;
      if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) return null;
      if (typeof fouled !== 'boolean') return null;
      return { type: 'longjump_finished', distance_m: d, fouled };
    }
    case 'longjump_quit':
      return { type: 'longjump_quit' };
    case 'shotput_ready':
      return { type: 'shotput_ready' };
    case 'shotput_finished': {
      const d = (raw as { distance_m?: unknown }).distance_m;
      const fouled = (raw as { fouled?: unknown }).fouled;
      if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) return null;
      if (typeof fouled !== 'boolean') return null;
      return { type: 'shotput_finished', distance_m: d, fouled };
    }
    case 'shotput_quit':
      return { type: 'shotput_quit' };
    default:
      return null;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isPetState(x: unknown): x is PetState {
  if (!isObject(x)) return false;
  return (typeof x.name === 'string' || x.name === null)
    && typeof x.born_at === 'string'
    && typeof x.last_seen === 'string'
    && typeof x.hunger === 'number'
    && typeof x.happiness === 'number'
    && typeof x.energy === 'number'
    && typeof x.coins === 'number';
}

// Jakenpoy rules — pure function so it's testable without UI.
//   bato (rock)  beats gunting (scissors)
//   gunting     beats papel (paper)
//   papel       beats bato
export function jakenpoyWinner(mine: JakenpoyChoice, theirs: JakenpoyChoice): 'me' | 'you' | 'tie' {
  if (mine === theirs) return 'tie';
  if ((mine === 'bato' && theirs === 'gunting')
    || (mine === 'gunting' && theirs === 'papel')
    || (mine === 'papel' && theirs === 'bato')) {
    return 'me';
  }
  return 'you';
}

export function jakenpoyVerdict(winner: JakenpoyChoice, loser: JakenpoyChoice): string {
  if (winner === 'bato' && loser === 'gunting') return 'bato dulls gunting';
  if (winner === 'gunting' && loser === 'papel') return 'gunting cuts papel';
  if (winner === 'papel' && loser === 'bato') return 'papel wraps bato';
  return '';
}
