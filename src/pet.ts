// /pet — Tamagotchi-style pixel pet for bk1.
//
// The pet is a tiny pixel-art creature with a fixed silhouette: it ages, gets hungry,
// gets sleepy, and reacts to your bk1 activity (each turn slightly feeds + cheers it up).
//
// State lives at ~/.bk1/pet.json with chmod 0600. Lifecycle is:
//   0–1h        → egg     ( ◯ )
//   1h–24h      → baby    (•‿•)
//   24h+        → adult   ᕙ(◕‿◕)ᕗ
//
// Mood is independent of stage and derived from current stats:
//   hunger ≥ 80                   → hungry
//   happiness ≤ 30                → sad
//   energy ≤ 30                   → sleepy
//   otherwise                     → happy
//
// Mood drives the StatusFooter kaomoji and the "feeling X" text label only — the big
// pixel sprite is the same shape regardless of mood. Was previously varied per-mood
// with eye glyphs, but the Clawd-style solid silhouette reads cleaner.
//
// All state transitions are pure functions parameterized by `now: Date` so unit tests
// can inject arbitrary times without timer mocking or sleep().

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const PET_FILE = join(homedir(), '.bk1', 'pet.json');

export interface PetState {
  name: string | null;          // null until /pet name <name> is run
  born_at: string;              // ISO timestamp
  last_seen: string;            // ISO — updated on save; drives offline decay
  hunger: number;               // 0 (fed) ... 100 (starving)
  happiness: number;            // 0 (miserable) ... 100 (overjoyed)
  energy: number;               // 0 (exhausted) ... 100 (energetic)
}

export type Stage = 'egg' | 'baby' | 'adult';
export type Mood  = 'happy' | 'hungry' | 'sleepy' | 'sad' | 'angry' | 'wants_to_play';

const STAGE_BABY_AT_MS  = 60 * 60 * 1000;        // 1 hour
const STAGE_ADULT_AT_MS = 24 * 60 * 60 * 1000;   // 24 hours

// Decay rates per minute of real-world elapsed time. Tuned so a session of light use
// keeps the pet in good shape, but a multi-hour absence noticeably changes its mood.
const HUNGER_PER_MIN     = 0.20;   // +1 per 5 minutes idle
const HAPPINESS_PER_MIN  = 0.08;   // -1 per 12.5 minutes idle
const ENERGY_RECOVER_MIN = 0.40;   // recovers when idle (resting)

// Per-turn auto-feed deltas: each LLM turn slightly improves stats. Small enough that
// the user still has incentive to /pet feed and /pet play; large enough that an active
// session keeps the pet content without intervention. Signs reflect direction: negative
// hunger = pet gets fed; positive happiness = pet gets happier; negative energy = work tires it.
const AUTO_FEED_HUNGER   = -1.5;
const AUTO_FEED_HAPPY    = +0.5;
const AUTO_FEED_ENERGY   = -0.3;

const FEED_HUNGER_DELTA    = -30;
const PLAY_HAPPY_DELTA     = +20;
const PLAY_ENERGY_DELTA    = -10;
const SLEEP_ENERGY_TARGET  = 100;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function newPet(now: Date = new Date()): PetState {
  return {
    name: null,
    born_at: now.toISOString(),
    last_seen: now.toISOString(),
    hunger: 0,
    happiness: 80,
    energy: 100,
  };
}

// Pure: advance the pet's stats based on real-world minutes elapsed since last_seen.
// Returns a NEW state — never mutates input — so callers can reason about freshness.
// Eggs are inert: they don't decay, since hunger/happiness/energy are meaningless until
// the crab hatches. last_seen still advances so post-hatch decay measures from the
// correct baseline.
export function tickPet(state: PetState, now: Date = new Date()): PetState {
  if (stage(state, now) === 'egg') {
    return { ...state, last_seen: now.toISOString() };
  }
  const lastSeen = new Date(state.last_seen).getTime();
  const elapsedMin = Math.max(0, (now.getTime() - lastSeen) / 60_000);
  return {
    ...state,
    hunger:    clamp(state.hunger    + HUNGER_PER_MIN     * elapsedMin, 0, 100),
    happiness: clamp(state.happiness - HAPPINESS_PER_MIN  * elapsedMin, 0, 100),
    energy:    clamp(state.energy    + ENERGY_RECOVER_MIN * elapsedMin, 0, 100),
    last_seen: now.toISOString(),
  };
}

export function stage(state: PetState, now: Date = new Date()): Stage {
  const ageMs = now.getTime() - new Date(state.born_at).getTime();
  if (ageMs < STAGE_BABY_AT_MS)  return 'egg';
  if (ageMs < STAGE_ADULT_AT_MS) return 'baby';
  return 'adult';
}

export function mood(state: PetState): Mood {
  // Priority order matters — most-actionable moods first so /pet tells the user what to
  // do next. "Angry" is reserved for severe combined neglect (very low happiness AND
  // meaningful hunger), distinct from plain "sad" (just lonely).
  if (state.hunger    >= 80)                               return 'hungry';
  if (state.happiness <= 15 && state.hunger >= 50)         return 'angry';
  if (state.happiness <= 30)                               return 'sad';
  if (state.energy    <= 30)                               return 'sleepy';
  // High energy + middling happiness = bored. Pet wants attention even though basics
  // are met. Acts as a gentle nudge to /pet play.
  if (state.energy    >= 70 && state.happiness < 60)       return 'wants_to_play';
  return 'happy';
}

// Compact ASCII for the StatusFooter — kept short so it doesn't push the cost
// estimate off narrow terminals. Each mood has its own kaomoji so the always-visible
// footer signals what the pet needs without forcing the user to run /pet.
const FACES: Record<Stage, Record<Mood, string>> = {
  egg: {
    happy:         '( ◯ )',
    hungry:        '( ◯ )...',
    sleepy:        '( ◯ )',
    sad:           '( ◯ )',
    angry:         '( ◯ )',
    wants_to_play: '( ◯ )',
  },
  baby: {
    happy:         '(•‿•)',
    hungry:        '(◕﹏◕)',
    sleepy:        '(-‿-)zz',
    sad:           '(╥﹏╥)',
    angry:         '(╬◣_◢)',
    wants_to_play: '(=^•^=)',
  },
  adult: {
    happy:         'ᕙ(◕‿◕)ᕗ',
    hungry:        'ᕙ(◕﹏◕)ᕗ',
    sleepy:        '( -‿- )zz',
    sad:           'ᕙ(╥﹏╥)ᕗ',
    angry:         'ᕙ(╬ಠ益ಠ)ᕗ',
    wants_to_play: 'ᕙ(=^•^=)ᕗ',
  },
};

export function petFace(state: PetState, now: Date = new Date()): string {
  return FACES[stage(state, now)][mood(state)];
}

// ─── Pixel sprite (rendered in /pet view) ───────────────────────────────────────
//
// Adult sprite is designed at 7 wide × 3 tall in "logical pixels" but encoded as
// half-block packed terminal cells so it only takes 2 terminal rows. Each char in
// the encoded output is one terminal cell carrying TWO stacked pixel colors via
// the ▀ glyph (upper half = foreground, lower half = background).
//
// Logical design (the actual picture):
//   █▓▓█▓▓█    row 0  eyes (2-wide each, bright)
//   ███████    row 1  body
//   █ █ █ █    row 2  legs
//
// Pair (row0, row1) and (row2, ∅) per column → encoded chars:
//   B = body|body              renders as ' ' bg=body         (line-leading filled)
//   V = eye-open|body          renders as '▀' fg=eyeOpen bg=body
//   Y = eye-blink|body         renders as '▀' fg=eyeBlink bg=body
//   U = body|empty             renders as '▀' fg=body         (legs / sprite top)
//   ' ' = empty|empty          renders as ' '
//
// Sentinel ​ prefixes each terminal row so RichLine in app.tsx can identify
// sprite output without a brittle alphabet regex (lines like "BVUW" might otherwise
// appear in normal text). The renderer strips the sentinel before decoding.
export const PET_SPRITE_SENTINEL: string = '​';

// Open-eyes (normal). 9 wide × 4 pixel rows, packed into 2 terminal rows. Eyes sit
// at logical row 1 (one row down from the top) so they can shift UP to row 0 or DOWN
// to row 2 for vertical mouse tracking — a top-row default would have no headroom.
//
// Every cell uses bg=body (lime). No transparent cells = no alternating bg = no
// dotted line at terminal-row boundaries (was the "stripe" artifact in the legs-
// row design that mixed B and U cells in the same row).
//
// Logical pixels:
//   █████████    row 0  forehead / body top
//   ██▓███▓██    row 1  eyes at cols 2 and 6  (default vertical position)
//   █████████    row 2  body
//   █████████    row 3  body bottom
//
// 3-row design (6 logical pixel rows). Eyes default to logical row 2 (top half of
// the middle terminal row); LOOK_UP and LOOK_DOWN shift by exactly ONE logical
// pixel (row 1 / row 3) — i.e. half a terminal cell. That matches the horizontal
// shift distance (1 column = ~1 half-cell visually) so all 8 directions have the
// same "step." Combined with 4 diagonals, the pet tracks 8 compass directions +
// center.
//
// Eye positions:
//   row 1: UP, UL, UR     (encoded in term row 1 bottom half → M cells)
//   row 2: L,  *,  R      (encoded in term row 2 top half    → V cells)
//   row 3: DL, D, DR      (encoded in term row 2 bottom half → M cells)
//
// Cell encoding:
//   M = body|eye → '▄' fg=eye bg=body. Top half body (from bg), bottom half eye.
//   V = eye|body → '▀' fg=eye bg=body. Top half eye, bottom half body.
const ADULT_SPRITE: string[] = [
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBVBBBVBB',  // eyes at row 2, cols 2 and 6
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

// Blink: eyes closed. All three terminal rows are all-body cells.
const ADULT_SPRITE_BLINK: string[] = [
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

// Cardinal — eyes shift by 1 col / 1 logical pixel from NORMAL.
const ADULT_SPRITE_LOOK_LEFT: string[] = [
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BVBBBVBBB',  // row 2, cols 1 and 5
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

const ADULT_SPRITE_LOOK_RIGHT: string[] = [
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBBVBBBVB',  // row 2, cols 3 and 7
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

const ADULT_SPRITE_LOOK_UP: string[] = [
  PET_SPRITE_SENTINEL + 'BBMBBBMBB',  // row 1 (term row 1 bottom half), cols 2 and 6
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

const ADULT_SPRITE_LOOK_DOWN: string[] = [
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBMBBBMBB',  // row 3 (term row 2 bottom half), cols 2 and 6
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

// Diagonal — combine the cardinal vertical row (1 or 3) with the cardinal column
// shift (-1 or +1). Each uses M cells (eye in bottom half of its terminal row).
const ADULT_SPRITE_LOOK_UL: string[] = [
  PET_SPRITE_SENTINEL + 'BMBBBMBBB',  // row 1, cols 1 and 5
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

const ADULT_SPRITE_LOOK_UR: string[] = [
  PET_SPRITE_SENTINEL + 'BBBMBBBMB',  // row 1, cols 3 and 7
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

const ADULT_SPRITE_LOOK_DL: string[] = [
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BMBBBMBBB',  // row 3, cols 1 and 5
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

const ADULT_SPRITE_LOOK_DR: string[] = [
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
  PET_SPRITE_SENTINEL + 'BBBMBBBMB',  // row 3, cols 3 and 7
  PET_SPRITE_SENTINEL + 'BBBBBBBBB',
];

// Egg: pre-hatch, doesn't share the body design. Kept compact since incubation has
// its own dedicated view (no stats, no mood) — the sprite is decorative only.
const EGG_SPRITE: string[] = [
  '  ▄▀▀▀▄  ',
  '  █ ◯ █  ',
  '  ▀▄▄▄▀  ',
];

// Legs row — appended to every adult sprite variant (not part of the static body
// constants, so it doesn't need to be re-encoded inside each look-direction).
// 'L' cells are '▄' fg=body with NO bg, so the top half is transparent (matching
// the body row's leading above it) and the bottom half is body color — looks like
// half-cell legs hanging below the body. Uniform-bg row → no dotted boundary with
// the all-body row above.
const LEGS_ROW: string = PET_SPRITE_SENTINEL + 'L L L L L';

// Helper: take a 3-row body sprite and tack on the legs row. All adult petSprite*
// exports route through this so legs come "for free" without editing every variant.
function withLegs(body: string[]): string[] {
  return [...body, LEGS_ROW];
}

export function petSprite(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE);
}

// Blink variant — exported so the StatusFooter's animation loop can swap to it
// briefly without going through stage logic twice.
export function petSpriteBlink(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_BLINK);
}

// Look-right variant — exported for the same reason. Eggs don't have eyes to move,
// so the egg sprite is returned unchanged.
export function petSpriteLookRight(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_LOOK_RIGHT);
}

// Look-left variant — mirror of look-right, used when the mouse cursor is to the
// left of the pet's center.
export function petSpriteLookLeft(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_LOOK_LEFT);
}

// Look-up variant — eyes shift up by exactly 1 logical pixel (half a terminal cell).
export function petSpriteLookUp(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_LOOK_UP);
}

// Look-down variant — eyes shift down by exactly 1 logical pixel.
export function petSpriteLookDown(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_LOOK_DOWN);
}

// Diagonals — combine vertical (up/down by 1 px) with horizontal (left/right by 1 col).
export function petSpriteLookUL(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_LOOK_UL);
}
export function petSpriteLookUR(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_LOOK_UR);
}
export function petSpriteLookDL(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_LOOK_DL);
}
export function petSpriteLookDR(state: PetState, now: Date = new Date()): string[] {
  return stage(state, now) === 'egg' ? EGG_SPRITE : withLegs(ADULT_SPRITE_LOOK_DR);
}

function statBar(value: number, width = 10): string {
  const filled = Math.round(clamp(value, 0, 100) / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function ageString(state: PetState, now: Date = new Date()): string {
  const seconds = Math.floor((now.getTime() - new Date(state.born_at).getTime()) / 1000);
  if (seconds < 60)      return `${seconds}s`;
  if (seconds < 3600)    return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)   return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

// Compact "Xm Ys" countdown — only used for the egg incubation line so we don't show
// a misleading mood/stat block before the crab actually hatches.
function untilHatchString(state: PetState, now: Date = new Date()): string {
  const hatchAt = new Date(state.born_at).getTime() + STAGE_BABY_AT_MS;
  const remainMs = Math.max(0, hatchAt - now.getTime());
  const totalSec = Math.floor(remainMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins <= 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

// Long-form /pet output — header line, stat bars, action hints. The post-hatch
// sprite is NOT included here: it lives permanently in the StatusFooter
// (PetSpritePanel) and rendering it again inline would duplicate the same art
// twice on screen each time /pet is invoked. The egg view keeps its sprite since
// eggs aren't represented in the footer animation (footer always shows the adult).
export function renderPetView(state: PetState, now: Date = new Date()): string {
  const s = stage(state, now);
  const m = mood(state);
  const label = state.name ?? '(unnamed)';
  const stageLabel = s === 'egg' ? 'egg' : (s === 'baby' ? 'baby' : 'adult');

  if (s === 'egg') {
    const lines: string[] = [
      `${label} — ${stageLabel}, ${ageString(state, now)} old`,
      '',
      ...petSprite(state, now),
      '',
      `🥚 incubating · hatches in ${untilHatchString(state, now)}`,
      '',
    ];
    if (state.name === null) {
      lines.push('You can name your egg now:');
      lines.push('  /pet name <name>');
    } else {
      lines.push('Nothing to do but wait. Check back after it hatches.');
    }
    return lines.join('\n');
  }

  const moodLabel = m === 'wants_to_play' ? 'wants to play' : m;
  const lines: string[] = [
    `${label} — ${stageLabel}, ${ageString(state, now)} old, feeling ${moodLabel}`,
    '',
    `🍗 hunger     ${statBar(state.hunger)}  ${Math.round(state.hunger)}%`,
    `😊 happiness  ${statBar(state.happiness)}  ${Math.round(state.happiness)}%`,
    `🔋 energy     ${statBar(state.energy)}  ${Math.round(state.energy)}%`,
    '',
  ];

  if (state.name === null) {
    lines.push('Your pet has no name yet. Give it one:');
    lines.push('  /pet name <name>');
  } else {
    lines.push('Try: /pet feed · /pet play · /pet sleep · /pet name <new-name>');
  }
  return lines.join('\n');
}

// ─── Interactions ─────────────────────────────────────────────────────────────────
// Each interaction first ticks the pet (so stats reflect elapsed time), then applies
// its effect, then updates last_seen. Returns a NEW state — caller is responsible for
// persisting via savePet(). Interactions are no-ops while the pet is an egg — only
// last_seen advances (via tickPet) so the caller can still show a fresh view.

export function feed(state: PetState, now: Date = new Date()): PetState {
  const ticked = tickPet(state, now);
  if (stage(state, now) === 'egg') return ticked;
  return {
    ...ticked,
    hunger: clamp(ticked.hunger + FEED_HUNGER_DELTA, 0, 100),
    happiness: clamp(ticked.happiness + 3, 0, 100), // small joy from being fed
  };
}

export function play(state: PetState, now: Date = new Date()): PetState {
  const ticked = tickPet(state, now);
  if (stage(state, now) === 'egg') return ticked;
  return {
    ...ticked,
    happiness: clamp(ticked.happiness + PLAY_HAPPY_DELTA, 0, 100),
    energy:    clamp(ticked.energy + PLAY_ENERGY_DELTA, 0, 100),
  };
}

export function petSleep(state: PetState, now: Date = new Date()): PetState {
  const ticked = tickPet(state, now);
  if (stage(state, now) === 'egg') return ticked;
  return { ...ticked, energy: SLEEP_ENERGY_TARGET };
}

export function rename(state: PetState, name: string, now: Date = new Date()): PetState {
  const cleaned = name.trim().slice(0, 32);
  if (cleaned.length === 0) return state;
  const ticked = tickPet(state, now);
  return { ...ticked, name: cleaned };
}

// Small effect applied automatically on every bk1 turn — your activity feeds the pet
// thematically (tokens become its food). Tuned to be noticeable but not free.
// No-op while egg: an egg doesn't react to your activity yet.
export function autoFeedFromActivity(state: PetState, now: Date = new Date()): PetState {
  const ticked = tickPet(state, now);
  if (stage(state, now) === 'egg') return ticked;
  return {
    ...ticked,
    hunger:    clamp(ticked.hunger    + AUTO_FEED_HUNGER, 0, 100),
    happiness: clamp(ticked.happiness + AUTO_FEED_HAPPY,  0, 100),
    energy:    clamp(ticked.energy    + AUTO_FEED_ENERGY, 0, 100),
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────────
// Path-parameterized variants exposed so tests can hit a temp file without touching
// the dev box's real ~/.bk1/pet.json.

export function readPetFrom(path: string): PetState | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PetState>;
    // Soft validation — extra fields from older schemas (cosmetic, head_shape) are
    // silently ignored; missing required fields are treated as corruption.
    if (typeof data.born_at === 'string' &&
        typeof data.last_seen === 'string' &&
        typeof data.hunger === 'number' &&
        typeof data.happiness === 'number' &&
        typeof data.energy === 'number') {
      return {
        name:      data.name ?? null,
        born_at:   data.born_at,
        last_seen: data.last_seen,
        hunger:    data.hunger,
        happiness: data.happiness,
        energy:    data.energy,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writePetTo(path: string, state: PetState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  chmodSync(path, 0o600);
}

export function loadPet(): PetState | null { return readPetFrom(PET_FILE); }
export function savePet(state: PetState): void { writePetTo(PET_FILE, state); }
export function petFilePath(): string { return PET_FILE; }
