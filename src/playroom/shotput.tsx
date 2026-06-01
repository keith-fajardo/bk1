// Shot Put — terminal mini-game for the playroom.
//
// Flow per attempt:
//   ready → countdown → aiming → charging → flying → finished
//
//   • aiming   — ←/→ adjusts release angle (25°–60°, peak distance at 42°).
//                [space] locks the angle and starts the charge phase.
//   • charging — alternating-key mash to build power (same enforcement as
//                Long Jump / Steeplechase: same key in a row is ignored).
//                Power decays slightly between presses so you have to keep
//                mashing. [space] releases at the current power.
//                If you hold longer than CHARGE_FOUL_AFTER_MS without
//                releasing, you OVER-ROTATE — automatic foul.
//   • flying   — animated parabolic arc, scaled so the shot lands at the
//                computed distance.
//   • finished — both pets shown side-by-side with happy/sad expressions
//                and final distances. Each side dismisses independently.
//
// Distance formula (from spec):
//   distance = MAX_DISTANCE_M × power_factor × angle_factor × timing_factor
//   power_factor   = power / 100
//   angle_factor   = max(0.2, 1 − |angle − 42| / 45)
//   timing_factor  = max(0.2, 1 − |power − 100| / 50)
//
// Multiplayer: single attempt per player (matches the existing single-shot
// games — Long Jump, Race). Each side runs its own local timer; the only
// thing on the wire is shotput_finished {distance_m, fouled}. The same
// matchEndedRef + onMatchDismiss pattern handles natural-end dismissal.

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PetSpriteLine } from '../app';
import { petSprite, petSpriteHappy, petSpriteSad, type PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import { encodeMessage, parseGameMessage } from './messages';

// ───────────── tuning ─────────────
const ANGLE_MIN = 25;
const ANGLE_MAX = 60;
const ANGLE_DEFAULT = 42;
const ANGLE_STEP = 1;
const ANGLE_STEP_BIG = 5;       // shift + arrow

const POWER_MAX = 130;          // power can overshoot 100 (foul risk zone)
const FOUL_POWER = 130;         // releasing at or above this is auto-foul
const POWER_PER_MASH = 5;       // velocity gain per alternating press
const POWER_DECAY_PER_SEC = 6;  // proportional drag would feel too sticky;
                                 // a small constant decay matches the
                                 // "you have to keep spinning" feel.

// Hold longer than this without releasing → over-rotation foul.
const CHARGE_FOUL_AFTER_MS = 4000;

const MAX_DISTANCE_M = 22.0;

// Visual arc — flight length on screen scales with the metres-thrown
// number, capped to keep within the battlefield.
const BATTLEFIELD_WIDTH = 60;
const SKY_HEIGHT = 8;
const THROWER_POS = 5;
const ARC_CELLS_PER_M = 2.4;     // 10m → 24 cells of arc
const MAX_ARC_CELLS = BATTLEFIELD_WIDTH - THROWER_POS - 2;

const FLY_FRAME_MS = 60;

const TICK_MS = 50;

// ───────────── phase state ─────────────
interface Point { col: number; row: number; }

type Phase =
  | { kind: 'ready'; selfReady: boolean; peerReady: boolean }
  | { kind: 'countdown'; count: 3 | 2 | 1 | 0 }
  | { kind: 'aiming'; angle: number }
  | { kind: 'charging'; angle: number; power: number; startedAt: number }
  | {
      kind: 'flying';
      angle: number;
      power: number;
      distance_m: number;
      fouled: boolean;
      trajectory: Point[];
      frame: number;
    }
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

export function ShotPut({ pet, peerPet, sidecar, onExit, onMatchDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready', selfReady: false, peerReady: false });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const matchEndedRef = useRef(false);
  // Alternation enforcement for the mash phase — same key in a row is
  // dropped, holds (auto-repeat) become no-ops.
  const lastMashKeyRef = useRef<string | null>(null);
  // Peer's broadcast result that landed before our own throw resolved.
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

  // Flip the natural-end flag when both distances are known. Gates the
  // cleanup quit broadcast so each side dismisses its own finished screen.
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
        if (p.count <= 0) return { kind: 'aiming', angle: ANGLE_DEFAULT };
        return { kind: 'countdown', count: (p.count - 1) as 3 | 2 | 1 | 0 };
      });
    }, 1000);
    return () => clearTimeout(id);
  }, [phase]);

  // Charging tick — apply power decay, check for auto-foul after the
  // CHARGE_FOUL_AFTER_MS deadline expires without a release press.
  useEffect(() => {
    if (phase.kind !== 'charging') return;
    const dt = TICK_MS / 1000;
    const id = setInterval(() => {
      updatePhase(p => {
        if (p.kind !== 'charging') return p;
        const now = Date.now();
        if (now - p.startedAt >= CHARGE_FOUL_AFTER_MS) {
          // Over-rotation foul. distance = 0.
          return startFlying(p.angle, p.power, true);
        }
        const nextPower = Math.max(0, p.power - POWER_DECAY_PER_SEC * dt);
        return { ...p, power: nextPower };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [phase.kind]);

  // Flying animator — steps through the trajectory frames; broadcasts the
  // result on landing and transitions to finished.
  useEffect(() => {
    if (phase.kind !== 'flying') return;
    const id = setInterval(() => {
      updatePhase(p => {
        if (p.kind !== 'flying') return p;
        const nextFrame = p.frame + 1;
        if (nextFrame >= p.trajectory.length) {
          const prevPeer = peerEarlyResultRef.current;
          peerEarlyResultRef.current = null;
          sidecar.send(encodeMessage({
            type: 'shotput_finished',
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
    }, FLY_FRAME_MS);
    return () => clearInterval(id);
  }, [phase.kind]);

  // Peer message handler.
  useEffect(() => {
    const offMessage = sidecar.on('peer_message', ({ line }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'shotput_quit') { onExit(); return; }
      if (msg.type === 'shotput_ready') {
        updatePhase(p => p.kind === 'ready' ? { ...p, peerReady: true } : p);
        queueMicrotask(maybeStartCountdown);
        return;
      }
      if (msg.type === 'shotput_finished') {
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
      if (!matchEndedRef.current) {
        sidecar.send(encodeMessage({ type: 'shotput_quit' })).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') process.exit(0);
    if (key.escape) { onExit(); return; }

    if (phase.kind === 'ready') {
      if (key.return && !phase.selfReady) {
        sidecar.send(encodeMessage({ type: 'shotput_ready' })).catch(() => {});
        updatePhase(p => p.kind === 'ready' ? { ...p, selfReady: true } : p);
        queueMicrotask(maybeStartCountdown);
      }
      return;
    }

    if (phase.kind === 'aiming') {
      if (key.ctrl || key.meta) return;
      const step = key.shift ? ANGLE_STEP_BIG : ANGLE_STEP;
      if (key.leftArrow) {
        updatePhase(p => p.kind === 'aiming' ? { ...p, angle: Math.max(ANGLE_MIN, p.angle - step) } : p);
        return;
      }
      if (key.rightArrow) {
        updatePhase(p => p.kind === 'aiming' ? { ...p, angle: Math.min(ANGLE_MAX, p.angle + step) } : p);
        return;
      }
      if (input === ' ' || key.return) {
        // Confirm angle; start charging.
        lastMashKeyRef.current = null;
        updatePhase(p => p.kind === 'aiming' ? { kind: 'charging', angle: p.angle, power: 0, startedAt: Date.now() } : p);
        return;
      }
      return;
    }

    if (phase.kind === 'charging') {
      if (key.ctrl || key.meta) return;
      // Space releases the throw at current power. Foul if the player
      // released past the foul threshold (over-charged + over-rotated).
      if (input === ' ') {
        updatePhase(p => {
          if (p.kind !== 'charging') return p;
          const fouled = p.power >= FOUL_POWER;
          return startFlying(p.angle, p.power, fouled);
        });
        return;
      }
      if (!input) return; // arrows / fn keys ignored
      // Alternation enforcement.
      if (lastMashKeyRef.current === input) return;
      lastMashKeyRef.current = input;
      updatePhase(p => {
        if (p.kind !== 'charging') return p;
        const nextPower = Math.min(POWER_MAX, p.power + POWER_PER_MASH);
        return { ...p, power: nextPower };
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
        <Text color="cyan" bold>SHOT PUT</Text>
        <Box flexGrow={1} />
        <Text color="gray">{headerStatus}</Text>
      </Box>
      <Box flexDirection="column" marginY={1} paddingX={1}>
        <Body phase={phase} pet={pet} peerPet={peerPet} />
      </Box>
      <Box paddingX={1}>
        <Text color="gray">
          {phase.kind === 'finished'        ? 'esc / ↵  return to playroom' :
           phase.kind === 'aiming'          ? '←/→ angle · shift = ×5 · [space] lock & charge · esc quit' :
           phase.kind === 'charging'        ? 'alternate two keys to charge · [space] release · esc quit' :
                                              'esc  quit'}
        </Text>
      </Box>
    </Box>
  );
}

// ───────────── pure helpers ─────────────

function startFlying(angle: number, power: number, fouled: boolean): Phase {
  const distance_m = fouled ? 0 : computeDistance(power, angle);
  const trajectory = computeTrajectory(angle, distance_m);
  return { kind: 'flying', angle, power, distance_m, fouled, trajectory, frame: 0 };
}

// distance = MAX_DISTANCE_M × power_factor × angle_factor × timing_factor
// All three terms peak when (power=100, angle=42).
function computeDistance(power: number, angle: number): number {
  const power_factor  = Math.max(0, power) / 100;
  const angle_factor  = Math.max(0.2, 1 - Math.abs(angle - 42) / 45);
  const timing_factor = Math.max(0.2, 1 - Math.abs(power - 100) / 50);
  const d = MAX_DISTANCE_M * power_factor * angle_factor * timing_factor;
  return Math.round(d * 100) / 100;
}

// Build a discrete parabolic arc from the thrower to the landing column.
// Horizontal length scales with distance_m (capped to fit the battlefield).
// Peak height scales with sin(angle) so higher-angle throws visibly arc
// taller — purely cosmetic, doesn't affect distance.
function computeTrajectory(angle: number, distance_m: number): Point[] {
  const visualLength = Math.max(2, Math.min(MAX_ARC_CELLS, Math.round(distance_m * ARC_CELLS_PER_M)));
  const peakHeight = Math.max(2, Math.round(Math.sin(angle * Math.PI / 180) * (SKY_HEIGHT - 1)));
  const points: Point[] = [];
  for (let i = 0; i <= visualLength; i++) {
    const t = i / visualLength;
    const col = THROWER_POS + i;
    const row = Math.round(4 * t * (1 - t) * peakHeight);
    points.push({ col, row });
  }
  return points;
}

function headerFor(phase: Phase): string {
  switch (phase.kind) {
    case 'ready':     return 'ready?';
    case 'countdown': return phase.count === 0 ? 'go!' : `${phase.count}...`;
    case 'aiming':    return 'aim angle';
    case 'charging':  return 'CHARGE!';
    case 'flying':    return phase.fouled ? 'FOUL!' : 'airborne!';
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
        <Text color="gray">press [↵] when ready — aim, mash to charge, [space] to release</Text>
      </Box>
    );
  }

  if (phase.kind === 'countdown') {
    return (
      <Box flexDirection="column">
        <Field pet={pet} />
        <MeterRow label="ANGLE " value={ANGLE_DEFAULT}  max={ANGLE_MAX} suffix={`° (ideal 42°)`} barColor="cyan" />
        <MeterRow label="POWER " value={0}  max={POWER_MAX} suffix="0%" barColor="gray" />
        <Text> </Text>
        <Text bold color="cyan">           get ready... {phase.count === 0 ? 'GO!' : phase.count}</Text>
      </Box>
    );
  }

  if (phase.kind === 'aiming') {
    return (
      <Box flexDirection="column">
        <Field pet={pet} angleArrow={phase.angle} />
        <MeterRow label="ANGLE " value={phase.angle} max={ANGLE_MAX} suffix={`${phase.angle}°  ${angleLabel(phase.angle)}`} barColor={angleColor(phase.angle)} />
        <MeterRow label="POWER " value={0} max={POWER_MAX} suffix="0%" barColor="gray" />
      </Box>
    );
  }

  if (phase.kind === 'charging') {
    const now = Date.now();
    const heldMs = now - phase.startedAt;
    const timeLeftPct = Math.max(0, 1 - heldMs / CHARGE_FOUL_AFTER_MS);
    return (
      <Box flexDirection="column">
        <Field pet={pet} angleArrow={phase.angle} charging />
        <MeterRow label="ANGLE " value={phase.angle} max={ANGLE_MAX} suffix={`${phase.angle}° (locked)`} barColor="cyan" />
        <MeterRow label="POWER " value={phase.power} max={POWER_MAX} suffix={`${Math.round(phase.power)}%  ${powerLabel(phase.power)}`} barColor={powerColor(phase.power)} foulZoneStart={FOUL_POWER} />
        <MeterRow label="TIMING" value={timeLeftPct * 100} max={100} suffix={timeLeftPct > 0.4 ? 'OK' : timeLeftPct > 0.15 ? 'NOW!' : 'FOUL SOON'} barColor={timeLeftPct > 0.4 ? 'green' : timeLeftPct > 0.15 ? 'yellow' : 'red'} />
      </Box>
    );
  }

  if (phase.kind === 'flying') {
    const point = phase.trajectory[phase.frame] ?? phase.trajectory[phase.trajectory.length - 1]!;
    return (
      <Box flexDirection="column">
        <Field pet={pet} projectile={point} fouled={phase.fouled} />
        <MeterRow label="ANGLE " value={phase.angle} max={ANGLE_MAX} suffix={`${phase.angle}°`} barColor="cyan" />
        <MeterRow label="POWER " value={phase.power} max={POWER_MAX} suffix={`${Math.round(phase.power)}%`} barColor={powerColor(phase.power)} />
        <Text> </Text>
        {phase.fouled
          ? <Text bold color="red">FOUL! over-rotation — no valid throw.</Text>
          : <Text bold color="cyan">in the air — projected {phase.distance_m.toFixed(2)}m</Text>}
      </Box>
    );
  }

  // finished
  return <FinishedBody phase={phase} pet={pet} peerPet={peerPet} yourName={yourName} peerName={peerName} />;
}

// ───────────── field (sky + pet + ground) ─────────────
function Field({
  pet, angleArrow, charging, projectile, fouled,
}: {
  pet: PetState;
  angleArrow?: number;
  charging?: boolean;
  projectile?: Point;
  fouled?: boolean;
}) {
  // Build sky rows. Each row may contain the projectile glyph (●) when
  // flying, or an angle indicator (·) when aiming/charging, to give the
  // player a sense of where the shot will go.
  type Cell = { ch: string; color: string };
  const rows: React.ReactElement[] = [];
  for (let screenRow = 0; screenRow < SKY_HEIGHT; screenRow++) {
    const worldY = SKY_HEIGHT - 1 - screenRow;
    const cells: Cell[] = [];
    for (let i = 0; i < BATTLEFIELD_WIDTH; i++) cells.push({ ch: ' ', color: 'gray' });

    // Angle indicator — small dots projecting from thrower in aim direction.
    if (angleArrow !== undefined) {
      const rad = angleArrow * Math.PI / 180;
      for (let r = 1; r <= 4; r++) {
        const c = Math.round(THROWER_POS + Math.cos(rad) * r * 2);
        const ry = Math.round(Math.sin(rad) * r);
        if (ry === worldY && c >= 0 && c < BATTLEFIELD_WIDTH) {
          cells[c] = { ch: '·', color: charging ? 'yellow' : 'gray' };
        }
      }
    }

    if (projectile && projectile.row === worldY && projectile.col >= 0 && projectile.col < BATTLEFIELD_WIDTH) {
      cells[projectile.col] = { ch: '●', color: fouled ? 'red' : 'cyan' };
    }

    // Run-length compression — same trick as Race / Steeplechase to keep
    // Yoga's flex layout from drowning in sibling nodes.
    const runs: { color: string; text: string }[] = [];
    for (const c of cells) {
      const last = runs[runs.length - 1];
      if (last && last.color === c.color) last.text += c.ch;
      else runs.push({ color: c.color, text: c.ch });
    }
    rows.push(
      <Box flexDirection="row" key={`sky${screenRow}`}>
        {runs.map((r, i) => <Text key={i} color={r.color}>{r.text}</Text>)}
      </Box>
    );
  }

  // Pet sprite — anchored at THROWER_POS with left padding.
  const sprite = petSprite(pet);
  const padLeft = Math.max(0, THROWER_POS - 4);
  const petRows: React.ReactElement[] = [];
  for (let i = 0; i < sprite.length; i++) {
    petRows.push(
      <Box flexDirection="row" key={`pet${i}`}>
        <Text>{' '.repeat(padLeft)}</Text>
        <PetSpriteLine line={sprite[i]!} />
      </Box>
    );
  }

  // Ground line. The thrower's circle sits under the pet (◯ at THROWER_POS).
  const ground = '═'.repeat(BATTLEFIELD_WIDTH);

  return (
    <Box flexDirection="column">
      {rows}
      {petRows}
      <Text color="gray">{ground}</Text>
    </Box>
  );
}

// ───────────── meters ─────────────
function MeterRow({
  label, value, max, suffix, barColor, foulZoneStart,
}: {
  label: string;
  value: number;
  max: number;
  suffix: string;
  barColor: string;
  // If set, cells whose value lands at/above this threshold render red,
  // showing the foul zone on the power meter.
  foulZoneStart?: number;
}) {
  const width = 18;
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  const foulCol = foulZoneStart !== undefined
    ? Math.round((foulZoneStart / max) * width)
    : width;
  // Two-segment fill: safe (barColor) up to foulCol, red beyond.
  const safeFilled = Math.min(filled, foulCol);
  const dangerFilled = Math.max(0, filled - foulCol);
  const empty = width - filled;
  return (
    <Box flexDirection="row">
      <Text>{label}  </Text>
      <Text color={barColor}>{'▓'.repeat(safeFilled)}</Text>
      <Text color="red">{'▓'.repeat(dangerFilled)}</Text>
      <Text color="gray">{'░'.repeat(empty)}</Text>
      <Text>  {suffix}</Text>
    </Box>
  );
}

function angleLabel(angle: number): string {
  if (angle >= 40 && angle <= 44) return 'PERFECT';
  if (angle >= 36 && angle <= 48) return 'good';
  if (angle >= 30 && angle <= 54) return 'ok';
  return 'poor';
}
function angleColor(angle: number): string {
  if (angle >= 40 && angle <= 44) return 'green';
  if (angle >= 36 && angle <= 48) return 'yellow';
  return 'red';
}

function powerLabel(power: number): string {
  if (power >= 95 && power <= 105) return 'PERFECT';
  if (power >= 85 && power <= 115) return 'good';
  if (power >= FOUL_POWER) return 'FOUL!';
  if (power >= 50) return 'building';
  return 'weak';
}
function powerColor(power: number): string {
  if (power >= FOUL_POWER) return 'red';
  if (power >= 95 && power <= 110) return 'green';
  if (power >= 70) return 'yellow';
  return 'gray';
}

// ───────────── finished body ─────────────
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
    if (phase.selfDistance === null) return `waiting for your throw...`;
    return `${peerName} hasn't thrown yet — waiting...`;
  }
  if (result === 'tie') {
    if (phase.selfFouled && phase.peerFouled) return 'both fouled — no measurement';
    return `dead heat at ${phase.selfDistance!.toFixed(2)}m`;
  }
  const winner = result === 'me' ? yourName : peerName;
  const loser  = result === 'me' ? peerName : yourName;
  const wDist  = result === 'me' ? phase.selfDistance : phase.peerDistance;
  const lFoul  = result === 'me' ? phase.peerFouled  : phase.selfFouled;
  if (lFoul) return `${winner} wins — ${loser} fouled`;
  const margin = Math.abs((phase.selfDistance ?? 0) - (phase.peerDistance ?? 0));
  return `${winner} wins · ${(wDist ?? 0).toFixed(2)}m  (+${margin.toFixed(2)}m)`;
}

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
