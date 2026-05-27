import { FetchGame } from './fetch';
import type { Game } from './types';

// Registry of pet mini-games. Each game owns its own screen + input handling
// while active; app.tsx hands off rendering and gates its own mouse handler
// when one is set (see `activeGameRef` there). To add a new game (e.g.
// ping-pong), implement a component conforming to GameProps and register its
// id here. The id is what /pet play (or future /pet <game>) routes to.
export const GAMES: Record<string, Game> = {
  fetch: {
    id: 'fetch',
    description: 'Click anywhere to throw — your pet hops over to fetch.',
    component: FetchGame,
  },
};

export type { Game, GameProps } from './types';
