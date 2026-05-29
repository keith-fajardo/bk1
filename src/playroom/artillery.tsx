// Artillery — Gunbound-style turn-based duel for the playroom.
//
// Two pets on either side of a flat battlefield. On their turn, the active
// player adjusts angle (←/→) and power (↑/↓), checks the wind indicator,
// and fires (space). Projectile arcs under gravity + wind drag. Damage =
// falloff function of impact-distance from the opponent's column. First to
// HP=0 loses.
//
// Multiplayer model: only the COMMITTED shot ({angle, power}) crosses the
// wire. Wind is derived from a shared formula keyed on turn number, so both
// clients agree without messaging. Trajectory and damage are computed
// identically on both sides → no resolution mismatches possible.
//
// matchEndedRef / onMatchDismiss follow the same pattern as Jakenpoy/Race:
// natural end (someone hits 0) → silent dismiss; esc mid-match → broadcast
// artillery_quit (forfeit).

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PetSpriteLine } from '../app';
import { petSprite, petSpriteHappy, petSpriteSad, type PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import type { PlayerRole } from './relay-protocol';
import { encodeMessage, parseGameMessage } from './messages';

// ───────────── tuning constants ─────────────
const BATTLEFIELD_WIDTH = 60;
const SKY_HEIGHT = 10;           // rows of sky above the pet level
const HOST_POS = 5;              // host pet's column on the battlefield
const JOINER_POS = 54;           // joiner pet's column
const PET_HEAD_HEIGHT = 0;       // world-y where projectile launches from — 0 = just above the pet sprite, so the barrel reads as coming out of the pet rather than floating in mid-air
const STARTING_HP = 100;
const GRAVITY = 9.8;             // world-units / sec²  (downward)
// ax = wind / WIND_ACCEL_SCALE. Higher = wind has less effect. We bumped
// from 5 to 10 because the original made -10 wind shave ~15 cells off the
// range of a clean shot — same power+angle felt inconsistent turn to turn.
// 10 keeps wind meaningful (~5 cell deflection across the field) without
// dominating the dial-in.
const WIND_ACCEL_SCALE = 10;
// v0 = power / POWER_TO_VELOCITY. Tuned so max-power max-range (~45° angle)
// is ~255 cells — far past the 49-cell distance between players. This makes
// power dial-in the dominant skill: a clean hit at 45° lands at ~50–55%
// power; 100% is intentional overkill territory so high-angle / windy
// shots still reach without feeling underpowered.
const POWER_TO_VELOCITY = 2;
const ANGLE_MIN = 10;
const ANGLE_MAX = 170;
const POWER_MIN = 10;
const POWER_MAX = 100;
const ANGLE_STEP = 2;
const POWER_STEP = 2;
const ANGLE_STEP_BIG = 10;       // shift + arrow
const POWER_STEP_BIG = 10;
const PROJECTILE_FRAME_MS = 50;
const TRAJECTORY_DT = 0.08;
const MAX_TRAJECTORY_STEPS = 300;
// Default to a SHALLOW angle so the initial shot reaches AND stays
// on-screen. At 30°, peak height stays under SKY_HEIGHT for any reasonable
// power. Steeper angles still work but their arcs visibly exit the top of
// the sky (that's the cost of lofting shots — like real artillery).
const INITIAL_ANGLE = 30;
const INITIAL_POWER = 50;

// Damage curve — max 30 at direct hit, falls off by 4 per cell of miss.
// Wider radius means near-misses still chip away at HP, rewarding "close
// enough" shots and making the game less punishing when you're off by a
// few cells of power tuning.
//   0 cells = 30,  3 = 18,  5 = 10,  7 = 2,  8+ = 0
function damageForDistance(d: number): number {
  return Math.max(0, Math.round(30 - 4 * d));
}

// Deterministic per-turn wind in [-10, +10]. Same formula both sides ⇒ no
// extra protocol message needed for wind sync.
function windFor(turn: number): number {
  const x = Math.sin(turn * 12.9898) * 43758.5453;
  const frac = x - Math.floor(x);
  return Math.round(frac * 20 - 10);
}

// ───────────── phase state ─────────────
interface Point { col: number; row: number; }

type Phase =
  | { kind: 'ready'; selfReady: boolean; peerReady: boolean }
  | { kind: 'countdown'; count: 3 | 2 | 1 | 0 }
  | {
      // Battle is one continuous phase; sub-state distinguishes "I'm aiming"
      // vs "their turn" vs "projectile in flight." The phase object holds
      // all the game-state numbers in one place so React re-renders see a
      // single source of truth.
      kind: 'battle';
      turn: number;             // 0, 1, 2, ... — even = host's shot, odd = joiner's
      selfHp: number;
      peerHp: number;
      angle: number;            // local aim — only meaningful when isMyTurn
      power: number;
      inFlight: null | {
        firedBy: 'host' | 'joiner';
        trajectory: Point[];
        frame: number;          // index into trajectory
        landingCol: number;     // final col where projectile hit ground/exited
      };
    }
  | { kind: 'finished'; selfHp: number; peerHp: number };

interface Props {
  pet: PetState;
  peerPet: PetState;
  sidecar: PlayroomSidecar;
  role: PlayerRole | null;     // 'host' | 'joiner' (spectators don't reach this path)
  onExit: () => void;
  onMatchDismiss?: () => void;
}

export function Artillery({ pet, peerPet, sidecar, role, onExit, onMatchDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready', selfReady: false, peerReady: false });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Same pattern as Jakenpoy/Race: gates the unmount cleanup artillery_quit
  // so a natural end (someone hits 0 HP) lets each side dismiss the
  // finished screen independently. Mid-match esc still broadcasts a
  // forfeit.
  const matchEndedRef = useRef(false);
  const iAmHost = role === 'host';

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

  // Whose turn it is. Host fires even turns, joiner fires odd. Both sides
  // derive this from the same number → no need to send "it's your turn"
  // messages.
  const isMyTurn = (turn: number): boolean => {
    return (turn % 2 === 0) === iAmHost;
  };

  // Watch for finished transition.
  useEffect(() => {
    if (phase.kind === 'finished') {
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
          return {
            kind: 'battle',
            turn: 0,
            selfHp: STARTING_HP,
            peerHp: STARTING_HP,
            angle: INITIAL_ANGLE,
            power: INITIAL_POWER,
            inFlight: null,
          };
        }
        return { kind: 'countdown', count: (p.count - 1) as 3 | 2 | 1 | 0 };
      });
    }, 1000);
    return () => clearTimeout(id);
  }, [phase]);

  // Projectile animator — advances inFlight.frame every PROJECTILE_FRAME_MS.
  // When we hit the end of the trajectory, apply damage + switch turns.
  useEffect(() => {
    if (phase.kind !== 'battle' || !phase.inFlight) return;
    const id = setInterval(() => {
      updatePhase(p => {
        if (p.kind !== 'battle' || !p.inFlight) return p;
        // Skip frames where the projectile is invisibly off-screen (either
        // above SKY_HEIGHT or outside the battlefield horizontally). Without
        // this, a high-arc shot animates frame-by-frame through invisible
        // cells for several seconds — looks like the projectile vanished.
        // We advance forward until we find a visible cell OR run out of
        // frames, then render that next visible point at normal cadence.
        let nextFrame = p.inFlight.frame + 1;
        while (nextFrame < p.inFlight.trajectory.length) {
          const pt = p.inFlight.trajectory[nextFrame]!;
          const visible = pt.row >= 0 && pt.row < SKY_HEIGHT
            && pt.col >= 0 && pt.col < BATTLEFIELD_WIDTH;
          if (visible) break;
          nextFrame++;
        }
        if (nextFrame < p.inFlight.trajectory.length) {
          return { ...p, inFlight: { ...p.inFlight, frame: nextFrame } };
        }
        // Trajectory done — apply damage. Both clients reach this branch
        // with the same numbers because the trajectory was computed
        // deterministically.
        const targetCol = p.inFlight.firedBy === 'host' ? JOINER_POS : HOST_POS;
        const targetIsMe = (p.inFlight.firedBy === 'host') !== iAmHost;
        const dist = Math.abs(p.inFlight.landingCol - targetCol);
        const dmg = damageForDistance(dist);
        const nextSelfHp = targetIsMe ? Math.max(0, p.selfHp - dmg) : p.selfHp;
        const nextPeerHp = !targetIsMe ? Math.max(0, p.peerHp - dmg) : p.peerHp;
        if (nextSelfHp === 0 || nextPeerHp === 0) {
          return { kind: 'finished', selfHp: nextSelfHp, peerHp: nextPeerHp };
        }
        // Switch turns: next turn, reset aim to defaults so neither side
        // accidentally re-uses the previous shot's settings.
        return {
          kind: 'battle',
          turn: p.turn + 1,
          selfHp: nextSelfHp,
          peerHp: nextPeerHp,
          angle: INITIAL_ANGLE,
          power: INITIAL_POWER,
          inFlight: null,
        };
      });
    }, PROJECTILE_FRAME_MS);
    return () => clearInterval(id);
  }, [phase.kind === 'battle' && phase.inFlight !== null]);

  // Peer message handler — registered once.
  useEffect(() => {
    const offMessage = sidecar.on('peer_message', ({ line }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'artillery_quit') { onExit(); return; }
      if (msg.type === 'artillery_ready') {
        updatePhase(p => p.kind === 'ready' ? { ...p, peerReady: true } : p);
        queueMicrotask(maybeStartCountdown);
        return;
      }
      if (msg.type === 'artillery_fire') {
        // Peer committed their shot. Spawn the trajectory on our side too.
        updatePhase(p => {
          if (p.kind !== 'battle' || p.inFlight) return p;
          // Only the inactive player should ACT on this message — the
          // active player already started their own animation when they
          // pressed space.
          if (isMyTurn(p.turn)) return p;
          const firedBy: 'host' | 'joiner' = (p.turn % 2 === 0) ? 'host' : 'joiner';
          const wind = windFor(p.turn);
          const traj = computeTrajectory(firedBy, msg.angle, msg.power, wind);
          return {
            ...p,
            inFlight: { firedBy, trajectory: traj.points, frame: 0, landingCol: traj.landingCol },
          };
        });
        return;
      }
    });
    return () => {
      offMessage();
      if (!matchEndedRef.current) {
        sidecar.send(encodeMessage({ type: 'artillery_quit' })).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_input, key) => {
    if (key.escape) { onExit(); return; }

    if (phase.kind === 'ready') {
      if (key.return && !phase.selfReady) {
        sidecar.send(encodeMessage({ type: 'artillery_ready' })).catch(() => {});
        updatePhase(p => p.kind === 'ready' ? { ...p, selfReady: true } : p);
        queueMicrotask(maybeStartCountdown);
      }
      return;
    }

    if (phase.kind === 'battle' && !phase.inFlight && isMyTurn(phase.turn)) {
      // Aim controls — only when it's my turn AND no projectile is in
      // flight. Shift modifies step size for coarse adjustments.
      const angleStep = key.shift ? ANGLE_STEP_BIG : ANGLE_STEP;
      const powerStep = key.shift ? POWER_STEP_BIG : POWER_STEP;
      if (key.leftArrow) {
        updatePhase(p => p.kind === 'battle' ? { ...p, angle: Math.max(ANGLE_MIN, p.angle - angleStep) } : p);
        return;
      }
      if (key.rightArrow) {
        updatePhase(p => p.kind === 'battle' ? { ...p, angle: Math.min(ANGLE_MAX, p.angle + angleStep) } : p);
        return;
      }
      if (key.upArrow) {
        updatePhase(p => p.kind === 'battle' ? { ...p, power: Math.min(POWER_MAX, p.power + powerStep) } : p);
        return;
      }
      if (key.downArrow) {
        updatePhase(p => p.kind === 'battle' ? { ...p, power: Math.max(POWER_MIN, p.power - powerStep) } : p);
        return;
      }
      if (_input === ' ' || key.return) {
        // Fire! Broadcast first so the peer sees the same values; then
        // start our own animation. Both sides land on the same trajectory.
        const angle = phase.angle;
        const power = phase.power;
        sidecar.send(encodeMessage({ type: 'artillery_fire', angle, power })).catch(() => {});
        const firedBy: 'host' | 'joiner' = iAmHost ? 'host' : 'joiner';
        const wind = windFor(phase.turn);
        const traj = computeTrajectory(firedBy, angle, power, wind);
        updatePhase(p => {
          if (p.kind !== 'battle') return p;
          return { ...p, inFlight: { firedBy, trajectory: traj.points, frame: 0, landingCol: traj.landingCol } };
        });
        return;
      }
    }

    if (phase.kind === 'finished' && key.return) {
      (onMatchDismiss ?? onExit)();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Header phase={phase} iAmHost={iAmHost} />
      <Box flexDirection="column" marginY={1} paddingX={1}>
        <Body phase={phase} pet={pet} peerPet={peerPet} iAmHost={iAmHost} />
      </Box>
      <Box paddingX={1}>
        <Text color="gray">
          {phase.kind === 'finished' ? 'esc / ↵  return to playroom' :
           phase.kind === 'battle' && !phase.inFlight && isMyTurn(phase.turn)
             ? '←/→ angle · ↑/↓ power · shift = ×5 · [space] fire · esc quit'
             : 'esc  quit'}
        </Text>
      </Box>
    </Box>
  );
}

// ───────────── header ─────────────
function Header({ phase, iAmHost }: { phase: Phase; iAmHost: boolean }) {
  let status = '';
  if (phase.kind === 'ready') status = 'ready?';
  else if (phase.kind === 'countdown') status = phase.count === 0 ? 'go!' : `${phase.count}...`;
  else if (phase.kind === 'battle') {
    const mine = (phase.turn % 2 === 0) === iAmHost;
    status = phase.inFlight ? 'projectile in flight...' : (mine ? 'your turn' : "friend's turn");
  } else status = 'finished';
  return (
    <Box>
      <Text color="cyan" bold>artillery</Text>
      <Box flexGrow={1} />
      <Text color="gray">{status}</Text>
    </Box>
  );
}

// ───────────── body ─────────────
function Body({ phase, pet, peerPet, iAmHost }: { phase: Phase; pet: PetState; peerPet: PetState; iAmHost: boolean }) {
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
      <Box flexDirection="column" minHeight={SKY_HEIGHT + 5}>
        <Battlefield phase={phase} pet={pet} peerPet={peerPet} iAmHost={iAmHost} />
        <Text> </Text>
        <Text bold color="cyan">           get ready... {phase.count === 0 ? 'GO!' : phase.count}</Text>
      </Box>
    );
  }

  if (phase.kind === 'battle') {
    const wind = windFor(phase.turn);
    return (
      <Box flexDirection="column">
        <WindHpBar phase={phase} wind={wind} yourName={yourName} peerName={peerName} iAmHost={iAmHost} />
        <Battlefield phase={phase} pet={pet} peerPet={peerPet} iAmHost={iAmHost} />
        <AimDisplay phase={phase} iAmHost={iAmHost} wind={wind} />
      </Box>
    );
  }

  // finished
  const iWon = phase.peerHp === 0 && phase.selfHp > 0;
  const result: 'me' | 'you' = iWon ? 'me' : 'you';
  return (
    <Box flexDirection="column">
      <FinishedSprites pet={pet} peerPet={peerPet} result={result} yourName={yourName} peerName={peerName} selfHp={phase.selfHp} peerHp={phase.peerHp} />
      <Text> </Text>
      <Text bold color={result === 'me' ? 'green' : 'red'}>
        {result === 'me' ? `${yourName} wins!` : `${peerName} wins!`}
      </Text>
      <Text> </Text>
      <Text color="gray">press ↵ to return to playroom</Text>
    </Box>
  );
}

// ───────────── battlefield render ─────────────
function Battlefield({ phase, pet, peerPet, iAmHost }: { phase: Phase; pet: PetState; peerPet: PetState; iAmHost: boolean }) {
  // Sky rows: SKY_HEIGHT rows above the pets. Each row may contain the
  // projectile if it's currently at that row.
  const projectile = phase.kind === 'battle' && phase.inFlight
    ? phase.inFlight.trajectory[phase.inFlight.frame]
    : null;
  // Aim point: a single marker positioned at fixed distance from the pet
  // in the dialed angle direction. Cell aspect compensation (sin/2) makes
  // the marker's VISUAL angle track the dialed degrees. One point gives
  // much more angular resolution than a multi-cell line — at distance 6,
  // the marker can land in ~14 distinct cells across 0°-90° (vs. ~7 for
  // a Bresenham line of the same length). Doesn't reflect power or wind
  // — purely "where is the gun pointing." Only shown on my turn between
  // shots.
  let aimPoint: { col: number; row: number } | null = null;
  if (phase.kind === 'battle' && !phase.inFlight && ((phase.turn % 2 === 0) === iAmHost)) {
    const launchCol = iAmHost ? HOST_POS : JOINER_POS;
    // Joiner aims left, so mirror the angle (matches computeTrajectory).
    const effectiveAngle = iAmHost ? phase.angle : 180 - phase.angle;
    const AIM_DISTANCE = 8;
    const rad = effectiveAngle * Math.PI / 180;
    aimPoint = {
      col: Math.round(launchCol + Math.cos(rad) * AIM_DISTANCE),
      row: Math.round(PET_HEAD_HEIGHT + Math.sin(rad) * AIM_DISTANCE / 2),
    };
  }
  // Trail: every prior trajectory point stays visible for the duration of
  // the flight, so the full arc is drawn rather than a single moving dot.
  // Dots get progressively brighter toward the active projectile — gives a
  // sense of "the recent path is fresher than the early path" without
  // changing the underlying timing.
  const trail: { col: number; row: number; intensity: number }[] = [];
  if (phase.kind === 'battle' && phase.inFlight) {
    const total = phase.inFlight.frame;
    for (let i = 0; i < total; i++) {
      const p = phase.inFlight.trajectory[i];
      if (!p) continue;
      // intensity: 0..1, oldest = 0, most recent = 1
      const intensity = total <= 1 ? 1 : i / (total - 1);
      trail.push({ col: p.col, row: p.row, intensity });
    }
  }
  const skyRows: React.ReactElement[] = [];
  // Render sky rows top-down. world-y 0 = ground, SKY_HEIGHT-1 = top of sky.
  // Screen row 0 (top) = world-y SKY_HEIGHT-1.
  // Per-cell rendering with brightness bands (gray for old trail, blue for
  // mid, cyan for fresh) so the arc reads as direction-of-motion, not just
  // a static dotted line. Consecutive same-color cells are merged into
  // single Text runs to keep the React tree small during animation.
  type Cell = { ch: string; color: string };
  for (let screenRow = 0; screenRow < SKY_HEIGHT; screenRow++) {
    const worldY = SKY_HEIGHT - 1 - screenRow;
    const cells: Cell[] = [];
    for (let i = 0; i < BATTLEFIELD_WIDTH; i++) cells.push({ ch: ' ', color: 'gray' });
    // Aim point — single yellow marker showing where the gun is pointing.
    // Drawn before the in-flight trail so the live shot's cyan glyph wins
    // any cell overlap.
    if (aimPoint && aimPoint.row === worldY && aimPoint.col >= 0 && aimPoint.col < BATTLEFIELD_WIDTH) {
      cells[aimPoint.col] = { ch: '●', color: 'yellow' };
    }
    // Trail dots — intensity-banded colors.
    for (const p of trail) {
      if (p.row !== worldY) continue;
      if (p.col < 0 || p.col >= BATTLEFIELD_WIDTH) continue;
      const color = p.intensity > 0.7 ? 'cyanBright'
                  : p.intensity > 0.3 ? 'cyan'
                  : 'gray';
      cells[p.col] = { ch: '·', color };
    }
    // Active projectile sits on top of the trail.
    if (projectile && projectile.row === worldY && projectile.col >= 0 && projectile.col < BATTLEFIELD_WIDTH) {
      cells[projectile.col] = { ch: '*', color: 'cyanBright' };
    }
    // Collapse runs of same-color cells into single Text nodes.
    const runs: { color: string; text: string }[] = [];
    for (const c of cells) {
      const last = runs[runs.length - 1];
      if (last && last.color === c.color) last.text += c.ch;
      else runs.push({ color: c.color, text: c.ch });
    }
    skyRows.push(
      <Box flexDirection="row" key={`sky${screenRow}`}>
        {runs.map((r, i) => <Text key={i} color={r.color}>{r.text}</Text>)}
      </Box>
    );
  }

  // Pet rows: render both pets side by side. The petSprite returns 4 rows
  // (3 body + 1 legs). We compose a row container with spacing between the
  // two pets so they sit at HOST_POS and JOINER_POS columns visually.
  const hostSprite = petSprite(iAmHost ? pet : peerPet);
  const joinerSprite = petSprite(iAmHost ? peerPet : pet);
  // Sprite is 9 cols wide; we want host's center to be at HOST_POS. Center
  // means col offset = HOST_POS - 4.
  const hostLeftPad = Math.max(0, HOST_POS - 4);
  const gap = Math.max(1, JOINER_POS - 4 - (HOST_POS + 4) - 1);

  const petRows: React.ReactElement[] = [];
  for (let i = 0; i < hostSprite.length; i++) {
    petRows.push(
      <Box flexDirection="row" key={`pet${i}`}>
        <Text>{' '.repeat(hostLeftPad)}</Text>
        <PetSpriteLine line={hostSprite[i]!} />
        <Text>{' '.repeat(gap)}</Text>
        <PetSpriteLine line={joinerSprite[i]!} />
      </Box>
    );
  }

  // Ground line
  const ground = '═'.repeat(BATTLEFIELD_WIDTH);

  return (
    <Box flexDirection="column">
      {skyRows}
      {petRows}
      <Text color="gray">{ground}</Text>
    </Box>
  );
}

// ───────────── wind/HP bar ─────────────
function WindHpBar({ phase, wind, yourName, peerName, iAmHost }: {
  phase: Extract<Phase, { kind: 'battle' }>;
  wind: number;
  yourName: string;
  peerName: string;
  iAmHost: boolean;
}) {
  const hostName = iAmHost ? yourName : peerName;
  const joinerName = iAmHost ? peerName : yourName;
  const hostHp = iAmHost ? phase.selfHp : phase.peerHp;
  const joinerHp = iAmHost ? phase.peerHp : phase.selfHp;
  const windArrow = wind === 0 ? '·' : wind > 0 ? '→' : '←';
  const windColor = wind === 0 ? 'gray' : Math.abs(wind) > 6 ? 'red' : 'yellow';
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="gray">turn {phase.turn + 1}  ·  wind </Text>
        <Text color={windColor}>{windArrow} {Math.abs(wind)}</Text>
      </Box>
      <Box flexDirection="row">
        <Text>{hostName.padEnd(12)} </Text>
        <HpBar hp={hostHp} />
        <Text>     </Text>
        <Text>{joinerName.padEnd(12)} </Text>
        <HpBar hp={joinerHp} />
      </Box>
    </Box>
  );
}

function HpBar({ hp }: { hp: number }) {
  const width = 12;
  const filled = Math.round((hp / STARTING_HP) * width);
  const color = hp > 60 ? 'green' : hp > 25 ? 'yellow' : 'red';
  return (
    <Box flexDirection="row">
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(width - filled)}</Text>
      <Text> {hp}</Text>
    </Box>
  );
}

// ───────────── aim display ─────────────
function AimDisplay({ phase, iAmHost, wind }: { phase: Extract<Phase, { kind: 'battle' }>; iAmHost: boolean; wind: number }) {
  const mine = (phase.turn % 2 === 0) === iAmHost;
  if (!mine || phase.inFlight) {
    return (
      <Box>
        <Text color="gray">{phase.inFlight ? 'projectile in flight...' : "waiting for friend's shot..."}</Text>
      </Box>
    );
  }
  // Preview the takeoff direction with a small arrow keyed off the angle.
  // Useful so the user has an at-a-glance sense of "am I aiming up or
  // sideways" without doing trig in their head.
  const arrow = arrowForAngle(phase.angle);
  return (
    <Box flexDirection="row">
      <Text>angle </Text><Text color="cyan" bold>{phase.angle.toString().padStart(3)}°</Text>
      <Text>   power </Text><Text color="cyan" bold>{phase.power.toString().padStart(3)}</Text>
      <Text>   aim </Text><Text color="cyan">{arrow}</Text>
      <Text color="gray">  (wind {wind > 0 ? '→' : wind < 0 ? '←' : '·'}{Math.abs(wind)})</Text>
    </Box>
  );
}

function arrowForAngle(angle: number): string {
  // 8-way compass from absolute angle. 0/180 = horizontal, 90 = up.
  if (angle < 25)  return '→';
  if (angle < 65)  return '↗';
  if (angle < 115) return '↑';
  if (angle < 155) return '↖';
  return '←';
}

// ───────────── trajectory math ─────────────
// Returns the integrated trajectory as a list of (col, row) screen-space
// points, plus the final landing column. Deterministic: same {firedBy,
// angle, power, wind} always produces the same trajectory on both clients.
function computeTrajectory(
  firedBy: 'host' | 'joiner',
  angleDeg: number,
  power: number,
  wind: number,
): { points: Point[]; landingCol: number } {
  const startX = firedBy === 'host' ? HOST_POS : JOINER_POS;
  const startY = PET_HEAD_HEIGHT;
  const v0 = power / POWER_TO_VELOCITY;
  // Joiner shoots to the LEFT — we mirror their angle around 90° so
  // "angle 60°" feels the same for both players (up-and-forward toward
  // opponent). Without this, joiners would have to dial 120° to aim at host.
  const effectiveAngle = firedBy === 'joiner' ? 180 - angleDeg : angleDeg;
  const rad = effectiveAngle * Math.PI / 180;
  let vx = v0 * Math.cos(rad);
  let vy = v0 * Math.sin(rad);
  const ax = wind / WIND_ACCEL_SCALE;
  let x = startX, y = startY;
  const points: Point[] = [];
  let landingCol = startX;
  for (let i = 0; i < MAX_TRAJECTORY_STEPS; i++) {
    points.push({ col: Math.round(x), row: Math.round(y) });
    // Only terminate when the projectile actually hits the ground (y<0).
    // We DON'T stop at the horizontal battlefield edge — letting overshoots
    // travel past x=BATTLEFIELD_WIDTH means "too much power" registers as
    // a far miss instead of clipping at the wall and silently landing
    // dist-6 from the joiner. The render layer already skips off-screen
    // cells, so visually you see the arc exit the right side of the sky.
    if (y < 0) { landingCol = Math.round(x); break; }
    vx += ax * TRAJECTORY_DT;
    vy -= GRAVITY * TRAJECTORY_DT;
    x += vx * TRAJECTORY_DT;
    y += vy * TRAJECTORY_DT;
  }
  return { points, landingCol };
}

// ───────────── finished sprites ─────────────
function FinishedSprites({
  pet, peerPet, result, yourName, peerName, selfHp, peerHp,
}: {
  pet: PetState;
  peerPet: PetState;
  result: 'me' | 'you';
  yourName: string;
  peerName: string;
  selfHp: number;
  peerHp: number;
}) {
  const myMood: 'happy' | 'sad' = result === 'me' ? 'happy' : 'sad';
  const theirMood: 'happy' | 'sad' = result === 'you' ? 'happy' : 'sad';
  const spriteFor = (p: PetState, m: 'happy' | 'sad') =>
    m === 'happy' ? petSpriteHappy(p) : petSpriteSad(p);
  const mineSprite = spriteFor(pet, myMood);
  const peerSprite = spriteFor(peerPet, theirMood);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={22}>
        <Text>you{result === 'me' ? ' ★' : ''}</Text>
        <Text> </Text>
        {mineSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{yourName}</Text>
        <Text color={selfHp > 0 ? 'green' : 'red'}>HP {selfHp}</Text>
      </Box>
      <Box flexDirection="column" width={22}>
        <Text>friend{result === 'you' ? ' ★' : ''}</Text>
        <Text> </Text>
        {peerSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{peerName}</Text>
        <Text color={peerHp > 0 ? 'green' : 'red'}>HP {peerHp}</Text>
      </Box>
    </Box>
  );
}
