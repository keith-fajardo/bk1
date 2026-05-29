// Long Jump minigame for the playroom. Mash-to-run + space-to-jump
// (Track & Field / Famicom Olympics inspired).
//
// Runup mechanic — alternation-enforced mash:
//   • Each non-space keystroke boosts velocity IF different from the last
//     key consumed. Same-key repeats (and OS auto-repeat) are ignored —
//     this kills the "hold-one-key-for-auto-repeat" exploit and forces
//     real two-finger alternation.
//   • Velocity decays via proportional drag (v -= DRAG_COEF × v × dt), so
//     the ramp from v=0 feels responsive (low v ⇒ low drag, almost all of
//     MASH_BOOST sticks) and equilibrium is gated by alternation speed.
//
// Jump:
//   • Space commits at the current pos + velocity.
//   • Distance = MAX_DISTANCE_M × vRel² × posRel, where vRel = velocity /
//     MAX_VELOCITY (quadratic — slow runners drop off steeply) and posRel
//     is max(0.5, takeoffCol / FOUL_COL) (premature takeoff penalty,
//     floored at 0.5 so fast runners still get partial credit).
//   • Past FOUL_COL = foul (red flag, 0m). Auto-foul if pos crosses
//     FOUL_COL + RUNUP_OVERSHOOT_COLS uncommitted.
//
// Multiplayer: only the resolved jump crosses the wire as
// longjump_finished {distance_m, fouled}. Each side runs its own local
// runup timer; peer's lane shows "running..." until their result lands.
// matchEndedRef + onMatchDismiss let both sides dismiss the result screen
// independently (same pattern as Race / Artillery / Jakenpoy).

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PetSpriteLine } from '../app';
import { petSprite, petSpriteHappy, petSpriteSad, type PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import { encodeMessage, parseGameMessage } from './messages';

// ───────────── tuning ─────────────
const TRACK_LEN = 40;
const FOUL_COL = 28;
const RUNUP_OVERSHOOT_COLS = 7;
const MAX_VELOCITY = 25;             // cols/sec — hard cap
const MASH_BOOST = 3.0;              // velocity per alternating press
const DRAG_COEF = 1.5;               // proportional drag: v -= DRAG × v × dt
const MAX_DISTANCE_M = 15.0;         // distance at vRel=1, posRel=1
const AIRBORNE_FRAMES = 18;
const AIRBORNE_FRAME_MS = 70;

type Phase =
  | { kind: 'ready'; selfReady: boolean; peerReady: boolean }
  | { kind: 'countdown'; count: 3 | 2 | 1 | 0 }
  | { kind: 'runup'; velocity: number; pos: number }
  | { kind: 'airborne'; takeoffCol: number; distance_m: number; fouled: boolean; frame: number }
  | {
      kind: 'finished';
      selfDistance: number | null;
      peerDistance: number | null;
      selfFouled: boolean;
      peerFouled: boolean;
    };

interface Props {
  pet: PetState;
  peerPet: PetState;
  sidecar: PlayroomSidecar;
  onExit: () => void;
  onMatchDismiss?: () => void;
}

export function LongJump({ pet, peerPet, sidecar, onExit, onMatchDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready', selfReady: false, peerReady: false });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const matchEndedRef = useRef(false);
  // Last key consumed as a mash event — used to enforce alternation
  // (different key from last = counts; same key = ignored).
  const lastMashKeyRef = useRef<string | null>(null);
  // Peer's longjump_finished that arrived BEFORE our own jump resolved.
  // Folded in when we transition to finished.
  const peerEarlyResultRef = useRef<{ distance: number; fouled: boolean } | null>(null);

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

  // Watch for the "both finished" transition — gates the unmount cleanup
  // longjump_quit so each side can dismiss its finished screen
  // independently. Mid-runup esc keeps this false → cleanup broadcasts.
  useEffect(() => {
    if (phase.kind === 'finished'
        && phase.selfDistance !== null
        && phase.peerDistance !== null) {
      matchEndedRef.current = true;
    }
  }, [phase]);

  // Countdown ticker.
  useEffect(() => {
    if (phase.kind !== 'countdown') return;
    const id = setTimeout(() => {
      updatePhase(p => {
        if (p.kind !== 'countdown') return p;
        if (p.count <= 0) return { kind: 'runup', velocity: 0, pos: 0 };
        return { kind: 'countdown', count: (p.count - 1) as 3 | 2 | 1 | 0 };
      });
    }, 1000);
    return () => clearTimeout(id);
  }, [phase]);

  // Runup tick — integrate velocity into position, apply proportional drag.
  useEffect(() => {
    if (phase.kind !== 'runup') return;
    const TICK_MS = 50;
    const dt = TICK_MS / 1000;
    const id = setInterval(() => {
      updatePhase(p => {
        if (p.kind !== 'runup') return p;
        const nextVelocity = Math.max(0, p.velocity - DRAG_COEF * p.velocity * dt);
        const nextPos = p.pos + p.velocity * dt;
        if (nextPos >= FOUL_COL + RUNUP_OVERSHOOT_COLS) {
          return startAirborne(nextPos, /* fouled */ true);
        }
        return { kind: 'runup', velocity: nextVelocity, pos: nextPos };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [phase.kind]);

  // Airborne animator — advances the arc frame, transitions to finished
  // on landing, broadcasts longjump_finished.
  useEffect(() => {
    if (phase.kind !== 'airborne') return;
    const id = setInterval(() => {
      updatePhase(p => {
        if (p.kind !== 'airborne') return p;
        const nextFrame = p.frame + 1;
        if (nextFrame >= AIRBORNE_FRAMES) {
          const prevPeer = peerEarlyResultRef.current;
          peerEarlyResultRef.current = null;
          sidecar.send(encodeMessage({
            type: 'longjump_finished',
            distance_m: p.distance_m,
            fouled: p.fouled,
          })).catch(() => {});
          return {
            kind: 'finished',
            selfDistance: p.fouled ? 0 : p.distance_m,
            peerDistance: prevPeer ? prevPeer.distance : null,
            selfFouled: p.fouled,
            peerFouled: prevPeer ? prevPeer.fouled : false,
          };
        }
        return { ...p, frame: nextFrame };
      });
    }, AIRBORNE_FRAME_MS);
    return () => clearInterval(id);
  }, [phase.kind]);

  // Peer message handler — registered once.
  useEffect(() => {
    const offMessage = sidecar.on('peer_message', ({ line }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'longjump_quit') { onExit(); return; }
      if (msg.type === 'longjump_ready') {
        updatePhase(p => p.kind === 'ready' ? { ...p, peerReady: true } : p);
        queueMicrotask(maybeStartCountdown);
        return;
      }
      if (msg.type === 'longjump_finished') {
        // If we're already at finished, fold the peer result in. Otherwise
        // park it on the ref and let the local airborne→finished
        // transition consume it.
        updatePhase(p => {
          if (p.kind === 'finished') {
            return {
              ...p,
              peerDistance: msg.fouled ? 0 : msg.distance_m,
              peerFouled: msg.fouled,
            };
          }
          peerEarlyResultRef.current = { distance: msg.fouled ? 0 : msg.distance_m, fouled: msg.fouled };
          return p;
        });
        return;
      }
    });
    return () => {
      offMessage();
      // Forfeit only when leaving mid-event; skipped on natural end.
      if (!matchEndedRef.current) {
        sidecar.send(encodeMessage({ type: 'longjump_quit' })).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.escape) { onExit(); return; }

    if (phase.kind === 'ready') {
      if (key.return && !phase.selfReady) {
        sidecar.send(encodeMessage({ type: 'longjump_ready' })).catch(() => {});
        updatePhase(p => p.kind === 'ready' ? { ...p, selfReady: true } : p);
        queueMicrotask(maybeStartCountdown);
      }
      return;
    }

    if (phase.kind === 'runup') {
      if (key.ctrl || key.meta) return;
      const isSpace = input === ' ';
      if (isSpace) {
        const fouled = phase.pos > FOUL_COL;
        updatePhase(() => startAirborneFromVelocity(phase.pos, phase.velocity, fouled));
        return;
      }
      if (!input) return; // arrows / fn keys → ignored
      if (lastMashKeyRef.current === input) return; // alternation enforcement
      lastMashKeyRef.current = input;
      updatePhase(p => {
        if (p.kind !== 'runup') return p;
        const nextVelocity = Math.min(MAX_VELOCITY, p.velocity + MASH_BOOST);
        return { ...p, velocity: nextVelocity };
      });
      return;
    }

    if (phase.kind === 'finished' && key.return) {
      const naturalEnd = phase.selfDistance !== null && phase.peerDistance !== null;
      (naturalEnd ? (onMatchDismiss ?? onExit) : onExit)();
    }
  });

  const headerStatus = headerFor(phase);
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color="cyan" bold>long jump</Text>
        <Box flexGrow={1} />
        <Text color="gray">{headerStatus}</Text>
      </Box>
      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={16}>
        <Body phase={phase} pet={pet} peerPet={peerPet} />
      </Box>
      <Box paddingX={1}>
        <Text color="gray">esc  {phase.kind === 'finished' ? 'return to playroom' : 'quit'}</Text>
      </Box>
    </Box>
  );
}

// ───────────── pure helpers ─────────────

// Auto-foul transition from a runup tick that overshot — keeps last
// velocity for the visual landing arc.
function startAirborne(takeoffCol: number, fouled: boolean): Phase {
  return { kind: 'airborne', takeoffCol, distance_m: 0, fouled, frame: 0 };
}

// Player-committed jump from a runup phase.
function startAirborneFromVelocity(takeoffCol: number, velocity: number, fouled: boolean): Phase {
  const distance_m = fouled ? 0 : computeDistanceM(velocity, takeoffCol);
  return { kind: 'airborne', takeoffCol, distance_m, fouled, frame: 0 };
}

// distance = MAX_DISTANCE_M × vRel² × posRel
function computeDistanceM(velocity: number, takeoffCol: number): number {
  const vRel = Math.max(0, Math.min(1, velocity / MAX_VELOCITY));
  const posRel = Math.max(0.5, Math.min(1, takeoffCol / FOUL_COL));
  const d = MAX_DISTANCE_M * vRel * vRel * posRel;
  return Math.round(d * 100) / 100;
}

// Parabolic lift glyph row index. Peaks at the middle frame, zero at ends.
function arcHeightAt(frame: number, totalFrames: number, maxHeight: number): number {
  const t = frame / Math.max(1, totalFrames - 1);
  return Math.round(4 * t * (1 - t) * maxHeight);
}

// Horizontal drift during airborne — pet moves from takeoffCol forward by
// distance_m cells over the duration of the arc.
function airborneColAt(takeoffCol: number, distance_m: number, frame: number, totalFrames: number): number {
  const t = frame / Math.max(1, totalFrames - 1);
  return Math.min(TRACK_LEN, takeoffCol + Math.round(t * distance_m));
}

function headerFor(phase: Phase): string {
  switch (phase.kind) {
    case 'ready':     return 'ready?';
    case 'countdown': return phase.count === 0 ? 'go!' : `${phase.count}...`;
    case 'runup':     return 'mash to sprint';
    case 'airborne':  return phase.fouled ? 'foul!' : 'airborne!';
    case 'finished':  return 'finished';
  }
}

// ───────────── body ─────────────
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
        <Text color="gray">press [↵] when ready to start</Text>
      </Box>
    );
  }

  if (phase.kind === 'countdown') {
    return (
      <Box flexDirection="column">
        <RunwayLine label="you" col={0} airborneHeight={0} fouled={false} />
        <Text> </Text>
        <RunwayLine label="friend" col={0} airborneHeight={0} fouled={false} peerRunup />
        <Text> </Text>
        <Text> </Text>
        <Text bold color="cyan">           get ready... {phase.count === 0 ? 'GO!' : phase.count}</Text>
      </Box>
    );
  }

  if (phase.kind === 'runup') {
    const vRel = Math.min(1, phase.velocity / MAX_VELOCITY);
    const meterWidth = 16;
    const filled = Math.round(vRel * meterWidth);
    const meter = '█'.repeat(filled) + '░'.repeat(meterWidth - filled);
    return (
      <Box flexDirection="column">
        <RunwayLine label="you" col={phase.pos} airborneHeight={0} fouled={false} />
        <Text> </Text>
        <RunwayLine label="friend" col={0} airborneHeight={0} fouled={false} peerRunup />
        <Text> </Text>
        <Box flexDirection="row">
          <Text>speed:  </Text>
          <Text color={vRel > 0.75 ? 'green' : vRel > 0.4 ? 'yellow' : 'red'}>{meter}</Text>
          <Text color="gray">  {phase.velocity.toFixed(1)} / {MAX_VELOCITY}</Text>
        </Box>
        <Text color="gray">alternate two keys to sprint · [space] to jump · foul line at col {FOUL_COL}</Text>
      </Box>
    );
  }

  if (phase.kind === 'airborne') {
    const col = airborneColAt(phase.takeoffCol, phase.distance_m, phase.frame, AIRBORNE_FRAMES);
    const h = arcHeightAt(phase.frame, AIRBORNE_FRAMES, 3);
    return (
      <Box flexDirection="column">
        <RunwayLine label="you" col={col} airborneHeight={h} fouled={phase.fouled} />
        <Text> </Text>
        <RunwayLine label="friend" col={0} airborneHeight={0} fouled={false} peerRunup />
        <Text> </Text>
        {phase.fouled
          ? <Text bold color="red">FOUL! crossed the line.</Text>
          : <Text bold color="cyan">in the air — projected {phase.distance_m.toFixed(2)}m</Text>}
      </Box>
    );
  }

  // finished
  return <FinishedBody phase={phase} pet={pet} peerPet={peerPet} yourName={yourName} peerName={peerName} />;
}

function FinishedBody({
  phase, pet, peerPet, yourName, peerName,
}: {
  phase: Extract<Phase, { kind: 'finished' }>;
  pet: PetState;
  peerPet: PetState;
  yourName: string;
  peerName: string;
}) {
  const result = finishedResult(phase);
  return (
    <Box flexDirection="column">
      <FinishedSprites
        pet={pet} peerPet={peerPet}
        result={result}
        yourName={yourName} peerName={peerName}
        selfDistance={phase.selfDistance} peerDistance={phase.peerDistance}
        selfFouled={phase.selfFouled} peerFouled={phase.peerFouled}
      />
      <Text> </Text>
      <Text bold color={result === 'me' ? 'green' : result === 'you' ? 'red' : 'gray'}>
        {resultCopy(result, phase, yourName, peerName)}
      </Text>
      <Text> </Text>
      <Text color="gray">press ↵ to return to playroom</Text>
    </Box>
  );
}

function finishedResult(p: Extract<Phase, { kind: 'finished' }>): 'me' | 'you' | 'tie' | 'pending' {
  if (p.selfDistance === null || p.peerDistance === null) return 'pending';
  if (p.selfFouled && p.peerFouled) return 'tie';
  if (p.selfFouled) return 'you';
  if (p.peerFouled) return 'me';
  if (p.selfDistance > p.peerDistance) return 'me';
  if (p.peerDistance > p.selfDistance) return 'you';
  return 'tie';
}

function resultCopy(
  result: 'me' | 'you' | 'tie' | 'pending',
  phase: Extract<Phase, { kind: 'finished' }>,
  yourName: string,
  peerName: string,
): string {
  if (result === 'pending') {
    if (phase.selfDistance === null) return `waiting for your jump...`;
    return `${peerName} hasn't landed yet — waiting...`;
  }
  if (result === 'tie') {
    if (phase.selfFouled && phase.peerFouled) return 'both fouled — no measurement';
    return `dead heat at ${phase.selfDistance!.toFixed(2)}m`;
  }
  const winner = result === 'me' ? yourName : peerName;
  const loser  = result === 'me' ? peerName : yourName;
  const wDist  = result === 'me' ? phase.selfDistance : phase.peerDistance;
  const lDist  = result === 'me' ? phase.peerDistance : phase.selfDistance;
  const wFoul  = result === 'me' ? phase.selfFouled  : phase.peerFouled;
  const lFoul  = result === 'me' ? phase.peerFouled  : phase.selfFouled;
  if (lFoul && !wFoul) return `${winner} wins — ${loser} fouled`;
  const margin = Math.abs((wDist ?? 0) - (lDist ?? 0));
  return `${winner} wins · ${(wDist ?? 0).toFixed(2)}m vs ${(lDist ?? 0).toFixed(2)}m  (+${margin.toFixed(2)}m)`;
}

// ───────────── runway ─────────────
function RunwayLine({
  label, col, airborneHeight, fouled, peerRunup,
}: {
  label: string;
  col: number;
  airborneHeight: number;
  fouled: boolean;
  peerRunup?: boolean;
}) {
  if (peerRunup) {
    return (
      <Box flexDirection="row">
        <Text>{label.padEnd(8)}</Text>
        <Text color="gray">{'·'.repeat(TRACK_LEN)}</Text>
        <Text>|</Text>
        <Text color="gray">  running...</Text>
      </Box>
    );
  }
  const colInt = Math.floor(col);
  // Build the runway as TRACK_LEN cells, then COLLAPSE runs of consecutive
  // same-color cells into single Text nodes. One Text per cell × 40 cells
  // × 2 lanes overwhelms Yoga's flex layout and triggers an
  // "Out of bounds memory access" WASM crash mid-runup. With runs collapsed,
  // a typical runway frame is ~5 Text nodes instead of 40.
  type Cell = { ch: string; color: string };
  const cells: Cell[] = [];
  for (let i = 0; i < TRACK_LEN; i++) {
    if (i === colInt && airborneHeight === 0) {
      cells.push({ ch: fouled ? '✗' : '→', color: fouled ? 'red' : 'cyan' });
    } else if (i === FOUL_COL) {
      cells.push({ ch: '|', color: 'red' });
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
  // Height rows above runway — pet rides the arc when airborne.
  const heightRows = 3;
  const arcRows: React.ReactElement[] = [];
  for (let r = heightRows; r >= 1; r--) {
    const glyph = airborneHeight === r ? '●' : ' ';
    arcRows.push(
      <Box flexDirection="row" key={`h${r}`}>
        <Text>{' '.repeat(8 /* label width */)}</Text>
        <Text>{' '.repeat(colInt) + glyph}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {arcRows}
      <Box flexDirection="row">
        <Text>{label.padEnd(8)}</Text>
        {runs.map((r, i) => <Text key={i} color={r.color}>{r.text}</Text>)}
        <Text>|</Text>
      </Box>
    </Box>
  );
}

// ───────────── finished sprites ─────────────
function FinishedSprites({
  pet, peerPet, result, yourName, peerName,
  selfDistance, peerDistance, selfFouled, peerFouled,
}: {
  pet: PetState;
  peerPet: PetState;
  result: 'me' | 'you' | 'tie' | 'pending';
  yourName: string;
  peerName: string;
  selfDistance: number | null;
  peerDistance: number | null;
  selfFouled: boolean;
  peerFouled: boolean;
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
        <Text color={selfFouled ? 'red' : 'cyan'}>
          {selfDistance === null ? '...' : selfFouled ? 'FOUL' : `${selfDistance.toFixed(2)}m`}
        </Text>
      </Box>
      <Box flexDirection="column" width={22}>
        <Text>friend{result === 'you' ? ' ★' : ''}</Text>
        <Text> </Text>
        {peerSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{peerName}</Text>
        <Text color={peerFouled ? 'red' : 'cyan'}>
          {peerDistance === null ? '...' : peerFouled ? 'FOUL' : `${peerDistance.toFixed(2)}m`}
        </Text>
      </Box>
    </Box>
  );
}
