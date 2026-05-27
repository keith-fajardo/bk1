import type { ReactElement } from 'react';
import type { PetState } from '../pet';

// Mini-games for the Tamagotchi pet. Each game takes over the screen while active,
// owns its own mouse/keyboard handlers, and signals exit via onExit (optionally
// returning a happiness boost to credit on the pet's stats). Registered in
// games/index.ts — add a new id there to expose it through /pet play (or future
// commands like /pet pingpong).

export interface GameProps {
  pet: PetState;
  onExit: (happinessGain?: number) => void;
}

export interface Game {
  id: string;
  description: string;
  component: (props: GameProps) => ReactElement;
}
