import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { parseMouseEvents } from '../mouse';
import type { GameProps } from './types';

// Fetch mini-game. User clicks anywhere → small ripple at the click point, the
// pet hops over to fetch. After arrival the pet wanders idly in small random
// hops until the next click. Esc exits.
//
// Sprite system: front + side variants, both 8 wide × 3 tall so swapping
// between them is positionally seamless.
//   - FRONT (idle): 2 eyes wide apart at cols 1 and 6 (5 body cells between,
//     1 cell margin from each edge so the eyes never touch the silhouette).
//   - SIDE (running): one eye on the side it's facing (col 6 right, col 1
//     left); body occupies the other 7 cols; tail is a SIDEWAYS half-cell
//     protrusion on the opposite end (col 0 facing-right, col 7 facing-left)
//     in the middle row only. Tail glyphs `R`/`J` are vertical half-blocks
//     (▐ / ▌) so the body silhouette grows out HORIZONTALLY by half a cell
//     — reads as a tail tip sticking out the side, not a bump under the body.
//
// Position is stored as the sprite's CENTER (petCol, petRow). Both sprites
// share dimensions so the center stays put when they swap.

const PET_BODY  = '#9FE749';  // lime — matches the StatusFooter sprite palette
const PET_EYE   = '#000000';
const RIPPLE_FG = '#7DD3FC';
const HEADER_FG = '#B9FECF';
const DIM_FG    = '#3D6650';

const TICK_MS   = 80;
const STEP_COLS = 2;
const STEP_ROWS = 1;

// Small ripple — emphasises the click point without flooding the play area.
// Max radius is RIPPLE_SPEED * RIPPLE_LIFE_MS / 1000 ≈ 3 cells.
const RIPPLE_LIFE_MS = 320;
const RIPPLE_SPEED   = 10;

const WANDER_DELAY_MIN  = 1500;
const WANDER_DELAY_MAX  = 2800;
const WANDER_RANGE_COLS = 12;
const WANDER_RANGE_ROWS = 6;

interface Cell {
  char: string;
  fg?: string;
  bg?: string;
}

interface Target {
  col: number;
  row: number;
}

interface Ripple {
  col: number;
  row: number;
  startedAt: number;
}

interface SpriteDef {
  rows: string[];
  width: number;
  height: number;
}

// Front: 8 cells × 3 rows. Lengthwise rectangle with 2 eyes wide apart at
// cols 1 and 6. V cells put the eye on the TOP half of term row 1.
const SPRITE_FRONT: SpriteDef = {
  rows: [
    'BBBBBBBB',
    'BVBBBBVB',
    'BBBBBBBB',
  ],
  width: 8,
  height: 3,
};

// Sideways right: 8×3. Body fills cols 1-7; eye at col 6 row 1 (1 from right
// edge, on the side the pet is facing). Tail at col 0 BOTTOM row — `R` is a
// right-half-block (▐), so its body-colored half is adjacent to the body at
// col 1 and the silhouette grows half a cell LEFTWARD out the back-bottom.
const SPRITE_LOOK_R: SpriteDef = {
  rows: [
    ' BBBBBBB',
    ' BBBBBVB',
    'RBBBBBBB',
  ],
  width: 8,
  height: 3,
};

// Sideways left: mirror of right. Body cols 0-6, eye at col 1 row 1, tail at
// col 7 BOTTOM row using `J` (left-half-block ▌) — body-colored half adjacent
// to the body at col 6, silhouette grows half a cell RIGHTWARD out the
// back-bottom.
const SPRITE_LOOK_L: SpriteDef = {
  rows: [
    'BBBBBBB ',
    'BVBBBBB ',
    'BBBBBBBJ',
  ],
  width: 8,
  height: 3,
};

// All three sprite shapes are now the same dimensions, so clamping is a
// single shared value — no need to take the max across variants.
const HALF_W = Math.floor(SPRITE_FRONT.width  / 2);
const HALF_H = Math.floor(SPRITE_FRONT.height / 2);

function decodeSpriteCell(ch: string): Cell {
  if (ch === 'B') return { char: ' ', bg: PET_BODY };
  if (ch === 'M') return { char: '▄', fg: PET_EYE,  bg: PET_BODY };
  if (ch === 'V') return { char: '▀', fg: PET_EYE,  bg: PET_BODY };
  if (ch === 'U') return { char: '▀', fg: PET_BODY };  // body in TOP half, transparent bottom
  if (ch === 'L') return { char: '▄', fg: PET_BODY };  // body in BOTTOM half, transparent top
  if (ch === 'R') return { char: '▐', fg: PET_BODY };  // body in RIGHT half — tail protruding LEFT
  if (ch === 'J') return { char: '▌', fg: PET_BODY };  // body in LEFT  half — tail protruding RIGHT
  return { char: ' ' };
}

function pickSprite(target: Target | null, petCol: number): SpriteDef {
  if (!target) return SPRITE_FRONT;
  const dx = target.col - petCol;
  if (dx < 0) return SPRITE_LOOK_L;
  return SPRITE_LOOK_R;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function FetchGame({ pet, onExit }: GameProps) {
  const cols     = process.stdout.columns ?? 80;
  const rows     = process.stdout.rows    ?? 24;
  const playRows = Math.max(8, rows - 3);

  const clampCol = (c: number) => clamp(c, HALF_W, cols     - HALF_W);
  const clampRow = (r: number) => clamp(r, HALF_H, playRows - HALF_H);

  const [petCol, setPetCol] = useState(clampCol(Math.floor(cols     / 2)));
  const [petRow, setPetRow] = useState(clampRow(Math.floor(playRows / 2)));
  const [target, setTarget] = useState<Target | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [tick, setTick] = useState(0);
  const [hasThrown, setHasThrown] = useState(false);
  const [happinessGain, setHappinessGain] = useState(0);

  const targetRef = useRef<Target | null>(null);
  targetRef.current = target;

  // Click → set target (in center coords) + spawn ripple at the click point.
  // Mouse coords are 1-indexed global; subtract 1 for col and 2 for row (header
  // takes the top row).
  useEffect(() => {
    const handler = (data: Buffer) => {
      const events = parseMouseEvents(data.toString('utf8'));
      for (const ev of events) {
        if (ev.button !== 'left' || !ev.press) continue;
        const localCol = ev.col - 1;
        const localRow = ev.row - 2;
        if (localRow < 0 || localRow >= playRows) continue;
        setTarget({ col: clampCol(localCol), row: clampRow(localRow) });
        setHasThrown(true);
        setHappinessGain(g => Math.min(g + 2, 30));
        setRipples(prev => [...prev, { col: localCol, row: localRow, startedAt: Date.now() }]);
      }
    };
    process.stdin.on('data', handler);
    return () => { process.stdin.off('data', handler); };
  }, [cols, playRows]);

  // Movement loop. Asymmetric step (2 cols, 1 row) compensates for terminal cell
  // aspect ratio — diagonals look right that way.
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => (t + 1) % 1_000_000);
      const tgt = targetRef.current;
      if (tgt) {
        setPetCol(curr => {
          const dx = tgt.col - curr;
          if (Math.abs(dx) <= STEP_COLS) return tgt.col;
          return clampCol(curr + (dx > 0 ? STEP_COLS : -STEP_COLS));
        });
        setPetRow(curr => {
          const dy = tgt.row - curr;
          if (Math.abs(dy) <= STEP_ROWS) return tgt.row;
          return clampRow(curr + (dy > 0 ? STEP_ROWS : -STEP_ROWS));
        });
      }
      setRipples(prev => prev.filter(r => Date.now() - r.startedAt < RIPPLE_LIFE_MS));
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [cols, playRows]);

  // Clear target on arrival in its own effect so the move + stop happens in one
  // render frame — splitting it across the animation tick would briefly show
  // the pet at the target before switching back to the front sprite.
  useEffect(() => {
    if (target && petCol === target.col && petRow === target.row) {
      setTarget(null);
    }
  }, [petCol, petRow, target]);

  // Wander: once the user has thrown at least once, the pet drifts to a small
  // nearby point every few seconds whenever it's idle. A new click overrides
  // the wander timer because setTarget triggers this effect's cleanup.
  useEffect(() => {
    if (target || !hasThrown) return;
    const delay = WANDER_DELAY_MIN + Math.random() * (WANDER_DELAY_MAX - WANDER_DELAY_MIN);
    const id = setTimeout(() => {
      const nextCol = clampCol(petCol + Math.round((Math.random() - 0.5) * WANDER_RANGE_COLS * 2));
      const nextRow = clampRow(petRow + Math.round((Math.random() - 0.5) * WANDER_RANGE_ROWS * 2));
      setTarget({ col: nextCol, row: nextRow });
    }, delay);
    return () => clearTimeout(id);
  }, [target, hasThrown, petCol, petRow, cols, playRows]);

  useInput((_input, key) => {
    if (key.escape) onExit(happinessGain);
  });

  // Hop bounce: while travelling, lift the sprite -1 row every other tick.
  const hopOffset     = target && tick % 2 === 0 ? -1 : 0;
  const drawCenterRow = clampRow(petRow + hopOffset);
  const sprite        = pickSprite(target, petCol);
  const topLeftCol    = petCol        - Math.floor(sprite.width  / 2);
  const topLeftRow    = drawCenterRow - Math.floor(sprite.height / 2);

  const frame: Cell[][] = Array.from({ length: playRows }, () =>
    Array.from({ length: cols }, () => ({ char: ' ' })),
  );

  for (let sy = 0; sy < sprite.height; sy++) {
    const line = sprite.rows[sy] ?? '';
    for (let sx = 0; sx < sprite.width; sx++) {
      const c  = decodeSpriteCell(line[sx] ?? ' ');
      const fy = topLeftRow + sy;
      const fx = topLeftCol + sx;
      if (fy < 0 || fy >= playRows || fx < 0 || fx >= cols) continue;
      // Skip fully-empty cells so the spaces in the tail row don't overwrite
      // anything beneath them (no visible effect today, but matters if ripples
      // ever pass under the sprite).
      if (c.char === ' ' && !c.bg) continue;
      frame[fy]![fx] = c;
    }
  }

  // Small ripple — expands ~3 cells over 320ms. dy is multiplied by 2 when
  // measuring the ring so the circle reads as round (terminal cells ~2:1 t:w).
  const now = Date.now();
  for (const r of ripples) {
    const ageSec = (now - r.startedAt) / 1000;
    const radius = Math.floor(ageSec * RIPPLE_SPEED);
    if (radius < 1) continue;
    const t = ageSec * 1000 / RIPPLE_LIFE_MS;
    const char = t < 0.5 ? '·' : '∘';
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const adjustedDy = dy * 2;
        const d = Math.hypot(dx, adjustedDy);
        if (Math.abs(d - radius) > 0.6) continue;
        const fy = r.row + dy;
        const fx = r.col + dx;
        if (fy < 0 || fy >= playRows || fx < 0 || fx >= cols) continue;
        if (frame[fy]![fx]!.char !== ' ') continue;
        frame[fy]![fx] = { char, fg: RIPPLE_FG };
      }
    }
  }

  // Render row by row, merging adjacent identical-style cells into one Text so
  // a mostly-blank row collapses to ~3 spans instead of one per column.
  const renderRow = (row: Cell[], idx: number) => {
    const spans: React.ReactElement[] = [];
    let i = 0;
    while (i < row.length) {
      const cur = row[i]!;
      let j = i;
      while (j < row.length && row[j]!.fg === cur.fg && row[j]!.bg === cur.bg) j++;
      const text = row.slice(i, j).map(c => c.char).join('');
      spans.push(
        <Text key={i} color={cur.fg} backgroundColor={cur.bg}>{text}</Text>,
      );
      i = j;
    }
    return <Box key={idx}>{spans}</Box>;
  };

  const petLabel   = pet.name ?? 'your pet';
  const statusText = hasThrown ? `${petLabel} is fetching` : `click anywhere to throw`;

  // Project the live stats from the gain accumulated so far. Each 2 happiness
  // points the user has earned this session = 1 future tap of play(), which is
  // +20 happiness / -10 energy. We mirror onGameExit's `taps` math so the live
  // display matches whatever onExit will actually apply on quit.
  const projectedTaps   = Math.max(0, Math.floor(happinessGain / 2));
  const projectedHappy  = clamp(pet.happiness + projectedTaps * 20, 0, 100);
  const projectedEnergy = clamp(pet.energy    - projectedTaps * 10, 0, 100);

  return (
    <Box flexDirection="column">
      <Box paddingX={2} justifyContent="space-between">
        <Box gap={2}>
          <Text color={HEADER_FG} bold>fetch</Text>
          <Text color={DIM_FG}>click anywhere · Esc to quit</Text>
        </Box>
        <Box gap={2}>
          <Text color={DIM_FG}>🍗 {Math.round(pet.hunger)}%</Text>
          <Text color={DIM_FG}>😊 {Math.round(projectedHappy)}%</Text>
          <Text color={DIM_FG}>🔋 {Math.round(projectedEnergy)}%</Text>
        </Box>
      </Box>
      {frame.map((row, idx) => renderRow(row, idx))}
      <Box paddingX={2}>
        <Text color={DIM_FG}>{statusText}</Text>
      </Box>
    </Box>
  );
}
