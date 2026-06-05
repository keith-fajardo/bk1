// Tracks the real bk1 child PIDs this extension spawns and reaps the ones that
// outlived their extension host.
//
// Why this exists: bk1 runs as the shell of a vscode.Terminal pty. Disposing
// the terminal SIGHUPs that pty, but a crashed/force-killed extension host
// never runs deactivate()/dispose(), so the bk1 process is orphaned and keeps
// its whole React tree + SQLite resident. Across window reloads these stack up
// into the memory pressure users see in Activity Monitor. bk1 itself now exits
// when its pty dies (see src/app.tsx), but a hung instance can still slip
// through — this is the belt-and-suspenders cleanup.
//
// The registry is a JSON file shared by every window. Each entry records the
// bk1 PID, the extension-host PID that owns it, and that host's start time. On
// activate() we kill only the bk1 PIDs whose owning host is genuinely gone —
// that's what makes this safe with multiple windows open at once: a sibling
// window's live bk1 has a live owner, so we never touch it.
//
// Two OS realities the design has to survive, both of which bit the first cut:
//   - PID reuse: a host PID being alive is not enough — the OS may have handed
//     that number to an unrelated process after the real host died. We pin each
//     entry to the host's start time and treat a mismatch as "owner gone", so a
//     recycled host PID can't shield a leaked orphan forever. The bk1 PID gets
//     the same treatment via isBk1() before any kill.
//   - Lost updates: reapOrphans() spawns `ps` (an await) between reading and
//     writing, during which another window can record a new entry. We never
//     write back a pre-await snapshot — the final write re-reads fresh and drops
//     only the specific stale PIDs this reap decided on, preserving anything
//     recorded concurrently. (recordTerminal/forgetTerminal are synchronous
//     read-modify-write with no await, so they don't have this window; two
//     windows recording in the same sub-ms tick can still last-writer-wins, but
//     that only defers a reap — Part A still exits that bk1 on pty death.)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';

const REGISTRY = path.join(os.homedir(), '.bk1', 'ext-terminals.json');

interface Entry {
  pid: number;        // the bk1 process (pty shell)
  host: number;       // the extension-host process that owns it
  hostStart: string;  // that host's start time, to detect host-PID reuse ('' = unknown)
}

function read(): Entry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => typeof e?.pid === 'number' && typeof e?.host === 'number')
      .map((e) => ({ pid: e.pid, host: e.host, hostStart: typeof e.hostStart === 'string' ? e.hostStart : '' }));
  } catch {
    return [];
  }
}

function write(entries: Entry[]): void {
  try {
    fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
    const tmp = `${REGISTRY}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries), 'utf8');
    fs.renameSync(tmp, REGISTRY);
  } catch {
    /* best-effort cleanup ledger — losing it just defers a reap */
  }
}

// `ps -o lstart=` is a stable per-PID start-time string on both macOS and
// Linux. We only ever compare it for equality against the same PID, so its
// exact format doesn't matter. '' on any failure.
function procStart(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'lstart='], (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

let selfStart = '';

// This host's own start time, captured synchronously the first time we record
// so the value is *guaranteed* present at record time — an async capture leaves
// a window where a terminal opens before it resolves and gets stamped with ''
// (which would silently weaken the host-PID-reuse guard for that entry). One
// blocking `ps` on the first Open-bk1 is a fine price; the result is cached.
function hostStart(): string {
  if (!selfStart) {
    try {
      selfStart = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    } catch {
      selfStart = '';
    }
  }
  return selfStart;
}

// Signal 0 probes existence without delivering anything. EPERM means the
// process exists but is owned by someone else (still "alive" for our purposes).
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

// Pure ownership decision, extracted so the host-PID-reuse logic is testable
// without spawning ps. An entry recorded with no start time ('' — pre-identity
// or a failed capture) can't be verified, so we trust liveness alone rather
// than risk killing a genuinely live window (fail-safe: never over-kill).
export function ownerLiveDecision(hostAlive: boolean, recordedStart: string, currentStart: string): boolean {
  if (!hostAlive) return false;
  if (!recordedStart) return true;
  return recordedStart === currentStart;
}

// True when `host` is alive AND is the same process that recorded the entry
// (not a reused PID). Only probes the start time when it's both needed and
// usable.
async function ownerLive(host: number, recordedStart: string): Promise<boolean> {
  const alive = isAlive(host);
  const currentStart = alive && recordedStart ? await procStart(host) : '';
  return ownerLiveDecision(alive, recordedStart, currentStart);
}

// Confirm a PID is still a bk1 process before killing it. After an orphan dies
// the OS can hand its PID to something unrelated; this guards us from killing
// that innocent process. macOS `ps -o comm=` returns the full executable path,
// so match on the basename, anchored — `.../bk1/<ver>/bk1` and dev-build
// `dbt-agent` pass; `bk1-lint`, `mybk1tool`, `/opt/bk1-x/foo` do not.
function isBk1(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(/^(bk1|dbt-agent)$/.test(path.basename(stdout.trim())));
    });
  });
}

export function recordTerminal(pid: number): void {
  const entries = read().filter((e) => e.pid !== pid);
  entries.push({ pid, host: process.pid, hostStart: hostStart() });
  write(entries);
}

export function forgetTerminal(pid: number): void {
  write(read().filter((e) => e.pid !== pid));
}

interface Probe {
  owner: boolean;  // the owning host is alive AND identity-matched
  proc: boolean;   // the bk1 PID is still alive
  bk1: boolean;    // ...and is still a bk1 process
}

// Pure reap policy, extracted so it's unit-testable without spawning ps or
// killing anything. Given each entry's probe results, decide which PIDs to drop
// from the registry and which to SIGKILL. An entry with a live, identity-matched
// owner is left entirely alone (another live window). Everything else is stale:
// dropped from the ledger, and killed too if it's still a live bk1 orphan.
export function reapDecision(entries: Entry[], probe: (e: Entry) => Probe): { drop: Set<number>; kill: number[] } {
  const drop = new Set<number>();
  const kill: number[] = [];
  for (const e of entries) {
    const p = probe(e);
    if (p.owner) continue;
    drop.add(e.pid);
    if (p.proc && p.bk1) kill.push(e.pid);
  }
  return { drop, kill };
}

// Kill bk1 processes whose owning extension host is gone (or whose host PID was
// recycled). Called on activate(); surviving orphans from a prior crashed host
// are by definition not owned by a live window.
export async function reapOrphans(): Promise<void> {
  const entries = read();
  const probes = new Map<number, Probe>();
  for (const e of entries) {
    const owner = await ownerLive(e.host, e.hostStart);
    const proc = !owner && isAlive(e.pid);
    probes.set(e.pid, { owner, proc, bk1: proc && (await isBk1(e.pid)) });
  }

  const { drop, kill } = reapDecision(entries, (e) => probes.get(e.pid)!);
  for (const pid of kill) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already exited between the check and the kill */
    }
  }

  // Re-read fresh and drop only the stale PIDs we decided on. Writing the
  // pre-await snapshot here would clobber any entry recorded by another window
  // during our `ps` awaits — see the lost-update note in the header.
  write(read().filter((e) => !drop.has(e.pid)));
}
