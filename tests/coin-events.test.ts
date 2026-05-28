import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { computeLintTransition } from '../src/state';
import {
  registerCoinEventHandler, emitCoinEvent,
  COIN_REWARDS, COIN_PENALTIES, PASSIVE_SESSION_CAP,
  type CoinEvent,
} from '../src/coin-events';

describe('computeLintTransition', () => {
  test('NULL → violations is grandfathered (first lint, no event)', () => {
    expect(computeLintTransition(null, 'violations', 'stg_orders')).toBeNull();
  });

  test('NULL → clean is no-op (first lint, clean, no event)', () => {
    expect(computeLintTransition(null, 'clean', 'stg_orders')).toBeNull();
  });

  test('violations → clean emits lint_fix reward', () => {
    const ev = computeLintTransition('violations', 'clean', 'stg_orders');
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('lint_fix');
    expect(ev!.delta).toBe(COIN_REWARDS.lintFix);
    expect(ev!.reason).toContain('stg_orders');
  });

  test('violations → violations is no-op (already counted)', () => {
    expect(computeLintTransition('violations', 'violations', 'stg_orders')).toBeNull();
  });

  test('clean → violations emits new_violation penalty', () => {
    const ev = computeLintTransition('clean', 'violations', 'stg_orders');
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('new_violation');
    expect(ev!.delta).toBe(COIN_PENALTIES.newViolation);
    expect(ev!.reason).toContain('stg_orders');
  });

  test('clean → clean is no-op', () => {
    expect(computeLintTransition('clean', 'clean', 'stg_orders')).toBeNull();
  });
});

describe('coin event handler registration', () => {
  let received: CoinEvent[];

  beforeEach(() => {
    received = [];
    registerCoinEventHandler(ev => received.push(ev));
  });

  afterEach(() => {
    registerCoinEventHandler(null);
  });

  test('emitCoinEvent forwards to the registered handler', () => {
    emitCoinEvent({ type: 'lint_fix', delta: 3, reason: 'Fixed: x' });
    expect(received.length).toBe(1);
    expect(received[0]!.type).toBe('lint_fix');
  });

  test('emitCoinEvent is a no-op when no handler is registered', () => {
    registerCoinEventHandler(null);
    expect(() => emitCoinEvent({ type: 'lint_fix', delta: 3, reason: 'x' })).not.toThrow();
  });

  test('passive cap constant is positive (sanity check)', () => {
    // Sanity: cap should be meaningfully positive so passive earnings can accrue.
    // Live cap enforcement is exercised inside app.tsx; this just guards against
    // an accidental flip of the constant to zero or negative.
    expect(PASSIVE_SESSION_CAP).toBeGreaterThan(0);
  });
});
