// Application-level message types exchanged over the playroom data channel.
// One line of JSON = one message. The sidecar handles the line framing.
//
// Validation lives in `parseGameMessage` below — the channel is treated as
// untrusted input even though Tailscale provides the transport encryption.

import type { PetState } from '../pet';

export type JakenpoyChoice = 'bato' | 'gunting' | 'papel';

export type GameMessage =
  | { type: 'hello'; pet: PetState }
  | { type: 'jakenpoy_choice'; round: number; choice: JakenpoyChoice }
  | { type: 'jakenpoy_quit' };

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
