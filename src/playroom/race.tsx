// Steeplechase — 3000m race with hurdles, driven by alternating-key mash
// (same input model as Long Jump). Space is the hurdle-jump key.
//
// Mechanic:
//   • Alternating non-space keys boost velocity (MASH_BOOST per press).
//     Repeating the same key — or holding for auto-repeat — is ignored,
//     same enforcement as Long Jump.
//   • Velocity has proportional drag, so equilibrium is gated by mash
//     speed; stop mashing and you coast to a stop.
//   • Position advances continuously based on velocity (not per-keystroke
//     like the old Race).
//   • Hurdles at fixed cell positions. Pressing [space] opens a brief
//     "jumping window" (JUMP_WINDOW_MS). If you cross a hurdle inside
//     the window you clear it; outside it you trip — velocity drops to 0,
//     position pins just before the hurdle, and inputs are ignored for
//     TRIP_PENALTY_MS.
//
// The race subscreen still uses the existing race_* protocol so no other
// game/code path changes. We broadcast race_position on each whole-cell
// crossing (deterministic, peer just receives integers) and race_finished
// with elapsed_ms on completion — same as before.

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PetSpriteLine } from '../app';
import { petSprite, petSpriteHappy, petSpriteSad, type PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import { encodeMessage, parseGameMessage } from './messages';

// ───────────── tuning ─────────────
// Track: 60 cells render 3000m. METERS_PER_CELL = 50 — hurdle spacing
// (every 500m = 10 cells) reads cleanly. We tried 90 cells but the total
// row width (label + 90 + suffix ≈ 108 chars) overflowed typical terminals
// and crashed Yoga's flex layout. 60 keeps the row under ~76 chars while
// still feeling 2× longer than the original 30-cell sprint.
const TRACK_LEN = 60;
const TRACK_METERS = 3000;
const METERS_PER_CELL = TRACK_METERS / TRACK_LEN;
// 5 hurdles every 500m. cells = [10, 20, 30, 40, 50]; final 10 cells are
// a clean home stretch.
const HURDLE_POSITIONS: ReadonlySet<number> = new Set([10, 20, 30, 40, 50]);

// Mash physics — borrowed verbatim from Long Jump for consistent feel.
const MAX_VELOCITY = 25;             // cols/sec hard cap
const MASH_BOOST = 3.0;              // velocity per alternating press
const DRAG_COEF = 1.5;               // proportional drag: v -= DRAG × v × dt
const TICK_MS = 50;

// Jump window — pressing [space] sets jumpingUntil = now + JUMP_WINDOW_MS.
// Crossing a hurdle inside that window clears it; outside trips you. The
// 400ms window covers ~10 cells of high-speed travel, giving forgiving
// timing without trivializing the hurdle dance.
const JUMP_WINDOW_MS = 400;
// Trip penalty — frozen for this long, velocity reset to 0.
const TRIP_PENALTY_MS = 800;

type Phase =
  | { kind: 'ready'; selfReady: boolean; peerReady: boolean }
  | { kind: 'countdown'; count: 3 | 2 | 1 | 0 }
  | {
      kind: 'racing';
      selfPos: number;          // float — continuous progress in cells
      selfVelocity: number;     // cols/sec
      peerPos: number;          // integer — last broadcast position
      startedAt: number;
      jumpingUntil: number;     // ms timestamp, 0 = not jumping
      trippedUntil: number;     // ms timestamp, 0 = not tripped
      tripFlash: boolean;       // mirrors tripped state for cheap render reads
    }
  | {
      kind: 'finished';
      selfPos: number;
      peerPos: number;
      selfTime: number | null;
      peerTime: number | null;
    };

interface Props {
  pet: PetState;
  peerPet: PetState;
  sidecar: PlayroomSidecar;
  onExit: () => void;
  onMatchDismiss?: () => void;
}

export function Race({ pet, peerPet, sidecar, onExit, onMatchDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready', selfReady: false, peerReady: false });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const matchEndedRef = useRef(false);
  // Last key consumed as a mash event — alternation enforcement.
  const lastMashKeyRef = useRef<string | null>(null);
  // Last col broadcast over the wire — used to avoid re-sending the same
  // position when we tick across non-integer fractions of a cell.
  const lastBroadcastColRef = useRef(0);

  const updatePhase = (fn: (p: Phase) => Phase) => {
    setPhase(prev => {
      const next = fn(prev);
      phaseRef.current = next;
      return next;
    });
  };

  const maybeStartCountdown = () => {
    const p = phaseRef.current;
    if (p.kind !== 'ready') return;
    if (!p.selfReady || !p.peerReady) return;
    setPhase({ kind: 'countdown', count: 3 });
  };

  useEffect(() => {
    if (phase.kind === 'finished'
        && phase.selfTime !== null
        && phase.peerTime !== null) {
      matchEndedRef.current = true;
    }
  }, [phase]);

  // Countdown ticker.
  useEffect(() => {
    if (phase.kind !== 'countdown') return;
    const id = setTimeout(() => {
      updatePhase(p => {
        if (p.kind !== 'countdown') return p;
        if (p.count <= 0) {
          lastBroadcastColRef.current = 0;
          return {
            kind: 'racing',
            selfPos: 0, selfVelocity: 0, peerPos: 0,
            startedAt: Date.now(),
            jumpingUntil: 0, trippedUntil: 0, tripFlash: false,
          };
        }
        return { kind: 'countdown', count: (p.count - 1) as 3 | 2 | 1 | 0 };
      });
    }, 1000);
    return () => clearTimeout(id);
  }, [phase]);

  // Racing tick — integrates velocity into position, applies proportional
  // drag, checks hurdle crossings, handles trips, broadcasts on integer
  // crossings, transitions to finished on TRACK_LEN.
  useEffect(() => {
    if (phase.kind !== 'racing') return;
    const dt = TICK_MS / 1000;
    const id = setInterval(() => {
      updatePhase(p => {
        if (p.kind !== 'racing') return p;
        const now = Date.now();
        const tripped = p.trippedUntil > now;

        let nextVelocity = tripped ? 0 : Math.max(0, p.selfVelocity - DRAG_COEF * p.selfVelocity * dt);
        let nextPos = tripped ? p.selfPos : p.selfPos + p.selfVelocity * dt;
        let nextTrippedUntil = p.trippedUntil;
        let nextTripFlash = p.tripFlash;
        let nextJumpingUntil = p.jumpingUntil;

        // Clear trip flash once the freeze ends.
        if (p.tripFlash && !tripped) {
          nextTripFlash = false;
        }

        // Hurdle crossing — only meaningful when we're actually advancing.
        if (!tripped) {
          const jumping = p.jumpingUntil > now;
          for (const h of HURDLE_POSITIONS) {
            if (p.selfPos < h && nextPos >= h) {
              if (jumping) {
                // Cleared! Consume the jump so it doesn't free a second
                // hurdle (matters only if you pressed space and somehow
                // crossed two hurdles in one tick — currently impossible
                // with our spacing but safer to handle anyway).
                nextJumpingUntil = 0;
              } else {
                // Trip — velocity to 0, freeze, pin position just before
                // the hurdle so the player must clear it after the freeze.
                nextTrippedUntil = now + TRIP_PENALTY_MS;
                nextTripFlash = true;
                nextVelocity = 0;
                nextPos = h - 0.001;
                break;
              }
            }
          }
        }

        // Broadcast on each whole-cell crossing. Avoids per-tick chatter
        // while keeping the peer's track view smooth at ~25 updates/sec
        // during top speed.
        const newCol = Math.floor(nextPos);
        if (newCol > lastBroadcastColRef.current && newCol < TRACK_LEN) {
          lastBroadcastColRef.current = newCol;
          sidecar.send(encodeMessage({ type: 'race_position', col: newCol })).catch(() => {});
        }

        // Finish.
        if (nextPos >= TRACK_LEN) {
          const elapsed = now - p.startedAt;
          lastBroadcastColRef.current = TRACK_LEN;
          sidecar.send(encodeMessage({ type: 'race_finished', elapsed_ms: elapsed })).catch(() => {});
          return {
            kind: 'finished',
            selfPos: TRACK_LEN,
            peerPos: p.peerPos,
            selfTime: elapsed,
            peerTime: null,
          };
        }

        return {
          ...p,
          selfPos: nextPos,
          selfVelocity: nextVelocity,
          jumpingUntil: nextJumpingUntil,
          trippedUntil: nextTrippedUntil,
          tripFlash: nextTripFlash,
        };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [phase.kind]);

  // Peer message handler.
  useEffect(() => {
    const offMessage = sidecar.on('peer_message', ({ line }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'race_quit') { onExit(); return; }
      if (msg.type === 'race_ready') {
        updatePhase(p => p.kind === 'ready' ? { ...p, peerReady: true } : p);
        queueMicrotask(maybeStartCountdown);
        return;
      }
      if (msg.type === 'race_position') {
        updatePhase(p => {
          if (p.kind === 'racing') return { ...p, peerPos: Math.min(TRACK_LEN, msg.col) };
          if (p.kind === 'finished') return { ...p, peerPos: Math.min(TRACK_LEN, msg.col) };
          return p;
        });
        return;
      }
      if (msg.type === 'race_finished') {
        updatePhase(p => {
          if (p.kind === 'racing') {
            return {
              kind: 'finished',
              selfPos: p.selfPos,
              peerPos: TRACK_LEN,
              selfTime: null,
              peerTime: msg.elapsed_ms,
            };
          }
          if (p.kind === 'finished' && p.peerTime === null) {
            return { ...p, peerPos: TRACK_LEN, peerTime: msg.elapsed_ms };
          }
          return p;
        });
        return;
      }
    });
    return () => {
      offMessage();
      if (!matchEndedRef.current) {
        sidecar.send(encodeMessage({ type: 'race_quit' })).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.escape) { onExit(); return; }

    if (phase.kind === 'ready') {
      if (key.return && !phase.selfReady) {
        sidecar.send(encodeMessage({ type: 'race_ready' })).catch(() => {});
        updatePhase(p => p.kind === 'ready' ? { ...p, selfReady: true } : p);
        queueMicrotask(maybeStartCountdown);
      }
      return;
    }

    if (phase.kind === 'racing') {
      if (phase.trippedUntil > Date.now()) return; // frozen
      if (key.ctrl || key.meta) return;

      // Space opens the jump window. Doesn't count as a mash event (so it
      // doesn't reset lastMashKey — you can still alternate around it).
      if (input === ' ') {
        updatePhase(p => p.kind === 'racing' ? { ...p, jumpingUntil: Date.now() + JUMP_WINDOW_MS } : p);
        return;
      }
      if (!input) return; // arrows/fn → ignore
      // Alternation enforcement — same key as last mash is dropped.
      if (lastMashKeyRef.current === input) return;
      lastMashKeyRef.current = input;
      updatePhase(p => {
        if (p.kind !== 'racing') return p;
        const nextVelocity = Math.min(MAX_VELOCITY, p.selfVelocity + MASH_BOOST);
        return { ...p, selfVelocity: nextVelocity };
      });
      return;
    }

    if (phase.kind === 'finished' && key.return) {
      const naturalEnd = phase.selfTime !== null && phase.peerTime !== null;
      (naturalEnd ? (onMatchDismiss ?? onExit) : onExit)();
    }
  });

  const headerStatus = headerFor(phase);
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color="cyan" bold>steeplechase</Text>
        <Box flexGrow={1} />
        <Text color="gray">{headerStatus}</Text>
      </Box>
      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={14}>
        <Body phase={phase} pet={pet} peerPet={peerPet} />
      </Box>
      <Box paddingX={1}>
        <Text color="gray">esc  {phase.kind === 'finished' ? 'return to playroom' : 'quit race'}</Text>
      </Box>
    </Box>
  );
}

function headerFor(phase: Phase): string {
  switch (phase.kind) {
    case 'ready':     return 'ready?';
    case 'countdown': return phase.count === 0 ? 'go!' : `${phase.count}...`;
    case 'racing':    return `${TRACK_METERS}m · hurdles ahead`;
    case 'finished':  return 'finished';
  }
}

function Body({ phase, pet, peerPet }: { phase: Phase; pet: PetState; peerPet: PetState }) {
  const yourName = pet.name ?? 'motchi';
  const peerName = peerPet.name ?? 'friend';

  if (phase.kind === 'ready') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row"><Text>you      {yourName.padEnd(10)} </Text><Text color={phase.selfReady ? 'green' : 'gray'}>{phase.selfReady ? '✓ ready' : '· waiting'}</Text></Box>
        <Box flexDirection="row"><Text>friend   {peerName.padEnd(10)} </Text><Text color={phase.peerReady ? 'green' : 'gray'}>{phase.peerReady ? '✓ ready' : '· waiting'}</Text></Box>
        <Text> </Text>
        <Text> </Text>
        <Text color="gray">press [↵] when ready — 3000m, alternate two keys to sprint, [space] over hurdles ▮</Text>
      </Box>
    );
  }

  if (phase.kind === 'countdown') {
    return (
      <Box flexDirection="column">
        <TrackLine name={yourName} col={0} side="me" tripFlash={false} jumping={false} arcHeight={0} />
        <Text> </Text>
        <TrackLine name={peerName} col={0} side="you" tripFlash={false} jumping={false} arcHeight={0} />
        <Text> </Text>
        <Text> </Text>
        <Text bold color="cyan">           get ready... {phase.count === 0 ? 'GO!' : phase.count}</Text>
      </Box>
    );
  }

  if (phase.kind === 'racing') {
    const now = Date.now();
    const jumping = phase.jumpingUntil > now;
    const tripped = phase.trippedUntil > now;
    // Parabolic arc height during the jump window — same shape as Long
    // Jump's airborne. Peak at t=0.5 of the JUMP_WINDOW_MS, 0 at endpoints.
    const jumpStart = phase.jumpingUntil - JUMP_WINDOW_MS;
    const tJump = jumping ? Math.max(0, Math.min(1, (now - jumpStart) / JUMP_WINDOW_MS)) : 0;
    const arcHeight = jumping ? Math.round(4 * tJump * (1 - tJump) * 2) : 0;
    const selfMeters = Math.min(TRACK_METERS, Math.round(phase.selfPos * METERS_PER_CELL));
    const peerMeters = Math.min(TRACK_METERS, Math.round(phase.peerPos * METERS_PER_CELL));
    const vRel = Math.min(1, phase.selfVelocity / MAX_VELOCITY);
    const meterWidth = 16;
    const filled = Math.round(vRel * meterWidth);
    const meter = '█'.repeat(filled) + '░'.repeat(meterWidth - filled);
    return (
      <Box flexDirection="column">
        <TrackLine name={yourName} col={Math.floor(phase.selfPos)} side="me" tripFlash={phase.tripFlash} jumping={jumping} arcHeight={arcHeight} />
        <Text> </Text>
        <TrackLine name={peerName} col={phase.peerPos} side="you" tripFlash={false} jumping={false} arcHeight={0} />
        <Text> </Text>
        <Box flexDirection="row">
          <Text>speed:  </Text>
          <Text color={vRel > 0.75 ? 'green' : vRel > 0.4 ? 'yellow' : 'red'}>{meter}</Text>
          <Text color="gray">  {phase.selfVelocity.toFixed(1)} / {MAX_VELOCITY}</Text>
        </Box>
        <Text>you {selfMeters}m / {TRACK_METERS}m   friend {peerMeters}m / {TRACK_METERS}m</Text>
        <Text color={tripped ? 'red' : jumping ? 'yellow' : 'gray'}>
          {tripped ? 'TRIPPED! you hit a hurdle — friend gaining ground...' :
           jumping ? 'JUMPING — cross the hurdle now!' :
           'alternate two keys to sprint · [space] over hurdles ▮'}
        </Text>
      </Box>
    );
  }

  // finished
  const result = finishResult(phase);
  return (
    <Box flexDirection="column">
      <FinishedSprites pet={pet} peerPet={peerPet} result={result} yourName={yourName} peerName={peerName} />
      <Text> </Text>
      <TrackLine name={yourName} col={Math.floor(phase.selfPos)} side="me" finished={phase.selfTime !== null} time={phase.selfTime} winner={result === 'me'} tripFlash={false} jumping={false} arcHeight={0} />
      <Text> </Text>
      <TrackLine name={peerName} col={phase.peerPos} side="you" finished={phase.peerTime !== null} time={phase.peerTime} winner={result === 'you'} tripFlash={false} jumping={false} arcHeight={0} />
      <Text> </Text>
      <Text bold color={result === 'me' ? 'green' : result === 'you' ? 'red' : 'gray'}>{resultCopy(result, phase, yourName, peerName)}</Text>
      <Text> </Text>
      <Text color="gray">press ↵ to return to playroom</Text>
    </Box>
  );
}

function finishResult(p: Extract<Phase, { kind: 'finished' }>): 'me' | 'you' | 'tie' | 'pending' {
  if (p.selfTime === null && p.peerTime === null) return 'pending';
  if (p.selfTime !== null && p.peerTime === null) return 'me';
  if (p.selfTime === null && p.peerTime !== null) return 'you';
  if (p.selfTime! < p.peerTime!) return 'me';
  if (p.peerTime! < p.selfTime!) return 'you';
  return 'tie';
}

function resultCopy(
  result: 'me' | 'you' | 'tie' | 'pending',
  phase: Extract<Phase, { kind: 'finished' }>,
  yourName: string,
  peerName: string,
): string {
  if (result === 'pending') return 'waiting for finish...';
  if (result === 'tie') return 'photo finish — dead heat!';
  const sTime = phase.selfTime;
  const pTime = phase.peerTime;
  if (result === 'me') {
    if (sTime !== null && pTime !== null) {
      const margin = ((pTime - sTime) / 1000).toFixed(1);
      return `${yourName} wins by ${margin}s`;
    }
    return `${yourName} crossed first — waiting for ${peerName}...`;
  }
  if (sTime !== null && pTime !== null) {
    const margin = ((sTime - pTime) / 1000).toFixed(1);
    return `${peerName} wins by ${margin}s`;
  }
  return `${peerName} crossed first — keep going!`;
}

function TrackLine({
  name, col, side, finished, time, winner, tripFlash, jumping, arcHeight,
}: {
  name: string;
  col: number;
  side: 'me' | 'you';
  finished?: boolean;
  time?: number | null;
  winner?: boolean;
  tripFlash: boolean;
  jumping: boolean;
  arcHeight: number;
}) {
  // When airborne (arcHeight > 0) the runner glyph leaves the ground row
  // and rides the arc above. We reserve ARC_ROWS rows of vertical space
  // above the runway so the layout doesn't shift up/down each jump cycle.
  const ARC_ROWS = 2;
  const airborne = arcHeight > 0;

  // Per-cell composition with run-length compression — keeps Yoga node
  // count low. ~12 cells of color transition typical for a 60-cell row.
  const cells: { ch: string; color: string }[] = [];
  for (let i = 0; i < TRACK_LEN; i++) {
    if (i === col && !airborne) {
      const runnerColor = tripFlash ? 'red' : jumping ? 'yellow' : (winner ? 'green' : 'cyan');
      cells.push({
        ch: finished ? '⚑' : (tripFlash ? '✗' : '→'),
        color: runnerColor,
      });
    } else if (HURDLE_POSITIONS.has(i)) {
      cells.push({ ch: '▮', color: 'yellow' });
    } else {
      cells.push({ ch: '·', color: 'gray' });
    }
  }
  const runs: { color: string; text: string }[] = [];
  for (const c of cells) {
    const last = runs[runs.length - 1];
    if (last && last.color === c.color) last.text += c.ch;
    else runs.push({ color: c.color, text: c.ch });
  }

  // Arc rows above runway. Runner '●' appears in the row matching
  // arcHeight (1..ARC_ROWS); other rows are blank. When not jumping these
  // rows are all blank but still rendered so the layout stays stable.
  const arcRows: React.ReactElement[] = [];
  for (let r = ARC_ROWS; r >= 1; r--) {
    const glyph = arcHeight === r ? '●' : ' ';
    arcRows.push(
      <Box flexDirection="row" key={`arc${r}`}>
        <Text>{' '.repeat(8 /* label width */)}</Text>
        <Text color={jumping ? 'yellow' : 'cyan'}>{' '.repeat(col) + glyph}</Text>
      </Box>
    );
  }

  const label = side === 'me' ? 'you' : 'friend';
  const timeStr = time !== null && time !== undefined ? `${(time / 1000).toFixed(1)}s` : '';
  return (
    <Box flexDirection="column">
      {arcRows}
      <Box flexDirection="row">
        <Text>{label.padEnd(8)}</Text>
        {runs.map((r, i) => <Text key={i} color={r.color}>{r.text}</Text>)}
        <Text>|</Text>
        <Text>  {timeStr}{winner ? ' ★' : ''}</Text>
      </Box>
    </Box>
  );
}

function FinishedSprites({
  pet, peerPet, result, yourName, peerName,
}: {
  pet: PetState;
  peerPet: PetState;
  result: 'me' | 'you' | 'tie' | 'pending';
  yourName: string;
  peerName: string;
}) {
  const myMood: 'happy' | 'sad' | 'neutral' =
    result === 'me'  ? 'happy' :
    result === 'you' ? 'sad'   : 'neutral';
  const theirMood: 'happy' | 'sad' | 'neutral' =
    result === 'you' ? 'happy' :
    result === 'me'  ? 'sad'   : 'neutral';
  const spriteFor = (p: PetState, m: 'happy' | 'sad' | 'neutral') =>
    m === 'happy' ? petSpriteHappy(p)
    : m === 'sad' ? petSpriteSad(p)
    : petSprite(p);
  const mineSprite = spriteFor(pet, myMood);
  const peerSprite = spriteFor(peerPet, theirMood);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={22}>
        <Text>you{result === 'me' ? ' ★' : ''}</Text>
        <Text> </Text>
        {mineSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{yourName}</Text>
      </Box>
      <Box flexDirection="column" width={22}>
        <Text>friend{result === 'you' ? ' ★' : ''}</Text>
        <Text> </Text>
        {peerSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{peerName}</Text>
      </Box>
    </Box>
  );
}
