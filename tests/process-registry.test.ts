// Unit tests for the pure reap policy in the VS Code extension's process
// registry. The async probing (ps / kill -0) is the untestable I/O half;
// reapDecision is the policy half, extracted precisely so the multi-window
// safety invariants are pinned without spawning processes or killing anything.

import { test, expect } from 'bun:test';
import { reapDecision, ownerLiveDecision } from '../vscode-ext/src/process-registry';

type E = { pid: number; host: number; hostStart: string };
const entry = (pid: number, host: number): E => ({ pid, host, hostStart: 'x' });

test('live, identity-matched owner is left entirely alone', () => {
  const entries = [entry(200, 100)];
  const { drop, kill } = reapDecision(entries, () => ({ owner: true, proc: true, bk1: true }));
  expect(drop.size).toBe(0);
  expect(kill).toEqual([]);
});

test('dead owner + live bk1 orphan is dropped and killed', () => {
  const entries = [entry(200, 100)];
  const { drop, kill } = reapDecision(entries, () => ({ owner: false, proc: true, bk1: true }));
  expect([...drop]).toEqual([200]);
  expect(kill).toEqual([200]);
});

test('dead owner + already-dead pid is dropped but not killed', () => {
  const entries = [entry(200, 100)];
  const { drop, kill } = reapDecision(entries, () => ({ owner: false, proc: false, bk1: false }));
  expect([...drop]).toEqual([200]);
  expect(kill).toEqual([]);
});

test('dead owner + live non-bk1 (PID reused) is dropped but never killed', () => {
  const entries = [entry(200, 100)];
  const { drop, kill } = reapDecision(entries, () => ({ owner: false, proc: true, bk1: false }));
  expect([...drop]).toEqual([200]);
  expect(kill).toEqual([]); // the isBk1 guard spares an innocent recycled PID
});

test('multi-window: only dead-owner entries are touched, live siblings preserved', () => {
  const live = entry(201, 101); // sibling window, owner alive
  const orphan = entry(202, 102); // prior crashed host, bk1 still up
  const stale = entry(203, 103); // prior crashed host, bk1 already gone
  const probe = (e: E): { owner: boolean; proc: boolean; bk1: boolean } => {
    if (e.pid === 201) return { owner: true, proc: true, bk1: true };
    if (e.pid === 202) return { owner: false, proc: true, bk1: true };
    return { owner: false, proc: false, bk1: false };
  };
  const { drop, kill } = reapDecision([live, orphan, stale], probe);
  expect(drop.has(201)).toBe(false); // never drop a live sibling's tracking
  expect(drop.has(202)).toBe(true);
  expect(drop.has(203)).toBe(true);
  expect(kill).toEqual([202]); // only the still-running orphan is killed
});

test('empty registry is a no-op', () => {
  const { drop, kill } = reapDecision([], () => ({ owner: false, proc: false, bk1: false }));
  expect(drop.size).toBe(0);
  expect(kill).toEqual([]);
});

// Host-identity decision — the substance of the host-PID-reuse guard.
test('dead host is never the owner, regardless of start time', () => {
  expect(ownerLiveDecision(false, 'Mon May 26 10:00:00 2026', 'Mon May 26 10:00:00 2026')).toBe(false);
});

test('alive host with matching start time is the owner (live sibling window)', () => {
  expect(ownerLiveDecision(true, 'Mon May 26 10:00:00 2026', 'Mon May 26 10:00:00 2026')).toBe(true);
});

test('alive host with mismatched start time is NOT the owner (PID reused)', () => {
  expect(ownerLiveDecision(true, 'Mon May 26 10:00:00 2026', 'Tue May 27 08:30:00 2026')).toBe(false);
});

test('unverifiable entry (no recorded start) trusts liveness — fail-safe, never over-kills', () => {
  expect(ownerLiveDecision(true, '', 'whatever')).toBe(true);
  expect(ownerLiveDecision(false, '', '')).toBe(false);
});
