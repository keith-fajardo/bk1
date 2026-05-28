import type { ReactElement } from 'react';
import type { PetState } from '../pet';

// Mini-games for the Tamagotchi pet. Each game takes over the screen while active,
// owns its own mouse/keyboard handlers, and signals exit via onExit. The result
// can credit happiness (mapped to play() taps in app.tsx), award coins, or both —
// games that don't need a particular dimension just omit it. Registered in
// games/index.ts — add a new id there to expose it through /pet play.

export interface GameResult {
  happiness?: number;  // happiness points earned this session; converted to play() taps on exit
  coins?: number;      // coin delta (positive = reward, negative = penalty)
}

export interface GameProps {
  pet: PetState;
  onExit: (result?: GameResult) => void;
}

export interface Game {
  id: string;
  description: string;
  component: (props: GameProps) => ReactElement;
}
