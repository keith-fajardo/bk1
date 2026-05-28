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

// Cap on the cumulative passive coin total awarded for model add/update
// events in a single bk1 session — refactor sprees shouldn't dump 500 coins.
// Lint fixes, pushes, and dbt runs are NOT capped (they reflect real work).
export const PASSIVE_SESSION_CAP = 50;

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
  countsTowardPassiveCap?: boolean;  // true for new_model / model_update
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
