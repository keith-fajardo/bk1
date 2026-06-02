// Coin-event constants + handler plumbing.
//
// Coin events are emitted from leaf subsystems (state.ts for lint transitions;
// later: git poll for pushes, dbt tool wrappers for run/test success). The
// handler is registered once by app.tsx at mount and translates events into
// `addCoins(pet, delta)` + `savePet` calls, optionally surfacing a transient
// toast.
//
// This keeps state.ts (and other emitters) ignorant of pet state — they just
// call `emitCoinEvent({...})` and let the app deal with it. Easier to test
// emitters in isolation, easier to mock the handler in tests.

export const COIN_REWARDS = {
  newModel:       +5,
  modelUpdate:    +1,
  lintFix:        +3,
  pushToMaster:  +10,
  dbtRun:         +2,
  dbtTest:        +1,
} as const;

export const COIN_PENALTIES = {
  newViolation:   -5,
} as const;

export type CoinEventType =
  | 'new_model'
  | 'model_update'
  | 'lint_fix'
  | 'new_violation'
  | 'push_to_master'
  | 'dbt_run'
  | 'dbt_test';

export interface CoinEvent {
  type:   CoinEventType;
  delta:  number;
  reason: string;          // short user-facing description ("Fixed: stg_orders")
}

export type CoinEventHandler = (event: CoinEvent) => void;

// Singleton handler — app.tsx sets it on mount, clears on unmount. Emitters
// just call emitCoinEvent and the registered handler (if any) processes it.
let handler: CoinEventHandler | null = null;

export function registerCoinEventHandler(h: CoinEventHandler | null): void {
  handler = h;
}

export function emitCoinEvent(event: CoinEvent): void {
  if (handler) handler(event);
}
