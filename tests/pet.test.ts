import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, statSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  newPet, tickPet, stage, mood, petFace, petSprite,
  feed, play, petSleep, rename, autoFeedFromActivity,
  renderPetView,
  readPetFrom, writePetTo,
  type PetState,
} from '../src/pet';
import { writeFileSync } from 'fs';

const T0 = new Date('2025-01-01T00:00:00Z');
const minutesLater = (mins: number) => new Date(T0.getTime() + mins * 60_000);
const hoursLater   = (h: number)    => new Date(T0.getTime() + h * 3_600_000);
const daysLater    = (d: number)    => new Date(T0.getTime() + d * 86_400_000);

// born_at value that puts the pet past the 1h hatch threshold at T0. Interaction
// tests need this because feed/play/sleep/autoFeed are no-ops while the pet is
// still an egg — verifying the behavior requires a post-hatch pet.
const HATCHED_BORN_AT = new Date(T0.getTime() - 2 * 3_600_000).toISOString();

describe('newPet', () => {
  test('produces a fresh pet with null name and healthy stats', () => {
    // Null name is load-bearing: it's how /pet knows to prompt for naming on first view.
    // If newPet ever defaults to a literal name, that prompt disappears and the UX breaks.
    const p = newPet(T0);
    expect(p.name).toBeNull();
    expect(p.hunger).toBe(0);
    expect(p.happiness).toBe(80);
    expect(p.energy).toBe(100);
    expect(p.born_at).toBe(T0.toISOString());
    expect(p.last_seen).toBe(T0.toISOString());
  });
});

describe('tickPet (time-based decay)', () => {
  test('does not mutate the input state (purity contract)', () => {
    // Critical: if tickPet mutates, callers that hold a reference (React refs) see
    // stale data and rendering becomes inconsistent.
    const p = newPet(T0);
    tickPet(p, minutesLater(60));
    expect(p.hunger).toBe(0);
    expect(p.last_seen).toBe(T0.toISOString());
  });

  test('hunger increases linearly with elapsed minutes', () => {
    const p = newPet(T0);
    const t = tickPet(p, minutesLater(60));
    // 60 min × 0.20/min = 12
    expect(t.hunger).toBeCloseTo(12, 1);
  });

  test('happiness decreases over time toward zero', () => {
    const p = newPet(T0);
    const t = tickPet(p, hoursLater(10));
    // 600 min × 0.08/min = 48 → 80 - 48 = 32
    expect(t.happiness).toBeCloseTo(32, 1);
  });

  test('extended idle clamps stats at the bounds (no negative happiness, no >100 hunger)', () => {
    // Defensive: if a user opens bk1 after a multi-week break, we must not emit
    // negative happiness (renders garbage in stat bars) or >100 hunger.
    const p = newPet(T0);
    const t = tickPet(p, daysLater(30));
    expect(t.hunger).toBe(100);
    expect(t.happiness).toBe(0);
    expect(t.energy).toBe(100);
  });

  test('clock going backwards (system time anomaly) is treated as zero elapsed', () => {
    // Don't let a backwards system clock corrupt stats. Math.max(0, elapsed) in tickPet
    // guards this — pin the behavior.
    const p = newPet(minutesLater(60));
    const t = tickPet(p, T0);
    expect(t.hunger).toBe(p.hunger);
    expect(t.happiness).toBe(p.happiness);
  });
});

describe('stage classification by age', () => {
  test('< 1 hour old → egg', () => {
    const p = newPet(T0);
    expect(stage(p, minutesLater(30))).toBe('egg');
    expect(stage(p, minutesLater(59))).toBe('egg');
  });

  test('1h–24h old → baby', () => {
    const p = newPet(T0);
    expect(stage(p, minutesLater(60))).toBe('baby');
    expect(stage(p, hoursLater(12))).toBe('baby');
    expect(stage(p, hoursLater(23))).toBe('baby');
  });

  test('24h+ → adult', () => {
    const p = newPet(T0);
    expect(stage(p, hoursLater(24))).toBe('adult');
    expect(stage(p, daysLater(7))).toBe('adult');
  });
});

describe('mood classification by stats', () => {
  test('hunger over 80 overrides everything (most actionable signal)', () => {
    // If we ranked sad over hungry, a hungry-and-sad pet would tell the user to "play"
    // when they should "feed". Priority order matters.
    const s: PetState = { ...newPet(T0), hunger: 85, happiness: 10, energy: 10 };
    expect(mood(s)).toBe('hungry');
  });

  test('low happiness with no hunger → sad', () => {
    const s: PetState = { ...newPet(T0), hunger: 20, happiness: 20, energy: 80 };
    expect(mood(s)).toBe('sad');
  });

  test('low energy with healthy hunger and happiness → sleepy', () => {
    const s: PetState = { ...newPet(T0), hunger: 20, happiness: 70, energy: 20 };
    expect(mood(s)).toBe('sleepy');
  });

  test('healthy stats → happy', () => {
    const s: PetState = { ...newPet(T0), hunger: 30, happiness: 70, energy: 70 };
    expect(mood(s)).toBe('happy');
  });

  test('severe combined neglect (very low happiness AND meaningful hunger) → angry', () => {
    // The distinction from plain "sad" matters: angry tells the user the pet is past
    // patience, requiring both feed AND play. If we collapse angry into sad, that
    // signal disappears and the user might just /pet play without /pet feed.
    const s: PetState = { ...newPet(T0), hunger: 60, happiness: 10, energy: 70 };
    expect(mood(s)).toBe('angry');
  });

  test('high energy + middling happiness → wants_to_play (the "bored" signal)', () => {
    // Pet is fed and rested but lonely. Triggers /pet play as the obvious next action.
    const s: PetState = { ...newPet(T0), hunger: 20, happiness: 50, energy: 85 };
    expect(mood(s)).toBe('wants_to_play');
  });

  test('hungry beats angry (hungry is more actionable)', () => {
    // Priority pin: if hunger crosses the 80 threshold, "hungry" wins over "angry"
    // because feeding addresses both, but the user should be told the immediate fix.
    const s: PetState = { ...newPet(T0), hunger: 85, happiness: 5, energy: 50 };
    expect(mood(s)).toBe('hungry');
  });
});

describe('petFace renders different faces per (stage, mood)', () => {
  test('egg stage uses egg face regardless of mood', () => {
    const p = newPet(T0);
    expect(petFace(p, minutesLater(10))).toContain('◯');
  });

  test('baby and adult have visibly distinct faces', () => {
    // If a regression makes both stages return the same face, the lifecycle is
    // invisible to the user — defeats the whole "egg → baby → adult" feature.
    const p = newPet(T0);
    const babyFace = petFace(p, hoursLater(2));
    const adultFace = petFace(p, hoursLater(25));
    expect(babyFace).not.toBe(adultFace);
  });

  test('mood changes are visible in the rendered face', () => {
    const happy:  PetState = { ...newPet(T0), hunger: 20, happiness: 80, energy: 80 };
    const hungry: PetState = { ...newPet(T0), hunger: 90, happiness: 80, energy: 80 };
    expect(petFace(happy,  hoursLater(2))).not.toBe(petFace(hungry, hoursLater(2)));
  });
});

describe('petSprite (pixel-art body)', () => {
  test('returns a multi-line array, not a single-line string', () => {
    const p = newPet(T0);
    const sprite = petSprite(p, hoursLater(25));
    expect(Array.isArray(sprite)).toBe(true);
    expect(sprite.length).toBeGreaterThanOrEqual(2);
  });

  test('post-hatch sprite is encoded in exactly 4 terminal rows (3 body + 1 legs)', () => {
    // Sprite is no longer per-mood — adult and baby share one design. The 6-pixel-row
    // body is packed into 3 terminal rows using the ▀/▄ half-block trick; a 4th row
    // is appended with hanging-leg ▄ glyphs (L cells, fg=body no-bg) for character.
    const p = newPet(T0);
    expect(petSprite(p, hoursLater(2)).length).toBe(4);
    expect(petSprite(p, hoursLater(25)).length).toBe(4);
  });

  test('mood does not affect the post-hatch sprite (intentional after Clawd redesign)', () => {
    // Previously every mood varied eye glyphs — that variation was removed when we
    // switched to a solid silhouette. Pin "all moods look the same" so we don't
    // silently regress to per-mood sprites again.
    const moods: PetState[] = [
      { ...newPet(T0), hunger: 20, happiness: 80, energy: 80 },
      { ...newPet(T0), hunger: 90, happiness: 80, energy: 80 },
      { ...newPet(T0), hunger: 20, happiness: 80, energy: 10 },
      { ...newPet(T0), hunger: 20, happiness: 20, energy: 80 },
      { ...newPet(T0), hunger: 60, happiness: 5,  energy: 70 },
      { ...newPet(T0), hunger: 20, happiness: 50, energy: 85 },
    ];
    const sprites = moods.map(s => petSprite(s, hoursLater(25)).join('\n'));
    expect(new Set(sprites).size).toBe(1);
  });

  test('all sprite lines within a single sprite have equal width', () => {
    // Misaligned widths cause the sprite to look broken in the terminal. Both encoded
    // rows must be the same code-point length so the half-block alphabet decodes into
    // a uniform-width grid.
    const p = newPet(T0);
    for (const when of [hoursLater(0.5), hoursLater(2), hoursLater(25)]) {
      const sprite = petSprite(p, when);
      const lengths = sprite.map(l => [...l].length);
      const allEqual = lengths.every(n => n === lengths[0]);
      expect(allEqual).toBe(true);
    }
  });

  test('post-hatch sprite uses the documented encoding (sentinel prefix + BVMLU alphabet)', () => {
    // app.tsx decodes the sprite by stripping the leading zero-width-space sentinel
    // and mapping each char (B body, V eye-top, M eye-bottom, L leg-bottom, U legacy
    // body-top, ' ' empty). If the sprite stops emitting these, the renderer silently
    // falls back to plain text.
    const SENTINEL = '​';
    for (const line of petSprite(newPet(T0), hoursLater(25))) {
      expect(line.startsWith(SENTINEL)).toBe(true);
      const payload = line.slice(SENTINEL.length);
      expect(payload).toMatch(/^[BVMLU ]+$/);
    }
  });
});

describe('interactions', () => {
  test('feed reduces hunger and bumps happiness slightly', () => {
    const p: PetState = { ...newPet(T0), born_at: HATCHED_BORN_AT, hunger: 60, happiness: 50 };
    const after = feed(p, T0);
    expect(after.hunger).toBeLessThan(p.hunger);
    expect(after.happiness).toBeGreaterThan(p.happiness);
  });

  test('feed cannot drive hunger below zero', () => {
    const p: PetState = { ...newPet(T0), born_at: HATCHED_BORN_AT, hunger: 5 };
    expect(feed(p, T0).hunger).toBe(0);
  });

  test('play increases happiness and decreases energy', () => {
    const p: PetState = { ...newPet(T0), born_at: HATCHED_BORN_AT, happiness: 50, energy: 80 };
    const after = play(p, T0);
    expect(after.happiness).toBeGreaterThan(p.happiness);
    expect(after.energy).toBeLessThan(p.energy);
  });

  test('sleep restores energy to 100 even if pet was exhausted', () => {
    const p: PetState = { ...newPet(T0), born_at: HATCHED_BORN_AT, energy: 5 };
    expect(petSleep(p, T0).energy).toBe(100);
  });

  test('rename sets the name and trims/truncates input', () => {
    const p = newPet(T0);
    const named = rename(p, '  Pippin  ', T0);
    expect(named.name).toBe('Pippin');
  });

  test('rename ignores empty / whitespace-only input', () => {
    const p: PetState = { ...newPet(T0), name: 'Pippin' };
    expect(rename(p, '   ', T0).name).toBe('Pippin');
  });

  test('rename truncates absurdly long names so the StatusFooter does not break', () => {
    const p = newPet(T0);
    const long = 'x'.repeat(500);
    const named = rename(p, long, T0);
    expect(named.name!.length).toBeLessThanOrEqual(32);
  });

  test('autoFeedFromActivity feeds the pet (negative hunger delta) — not the other way', () => {
    // Sign-bug regression target: an early draft had AUTO_FEED_HUNGER positive, which
    // made each agent turn MAKE THE PET HUNGRIER. Catastrophic for the "your tokens
    // feed the pet" mental model. Pin the direction explicitly.
    const p: PetState = { ...newPet(T0), born_at: HATCHED_BORN_AT, hunger: 50 };
    const after = autoFeedFromActivity(p, T0);
    expect(after.hunger).toBeLessThan(p.hunger);
  });

  test('interactions are no-ops while the pet is still an egg', () => {
    // Eggs don't have meaningful hunger/happiness/energy — interactions must leave
    // those stats untouched. Only last_seen advances. Without this guard, the UI
    // would show stat decay on an egg, implying it was already alive.
    const p: PetState = { ...newPet(T0), hunger: 30, happiness: 50, energy: 70 };
    const later = minutesLater(10);
    for (const fn of [feed, play, petSleep, autoFeedFromActivity]) {
      const after = fn(p, later);
      expect(after.hunger).toBe(p.hunger);
      expect(after.happiness).toBe(p.happiness);
      expect(after.energy).toBe(p.energy);
      expect(after.last_seen).toBe(later.toISOString());
    }
  });
});

describe('persistence', () => {
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'bk1-pet-'));
    path = join(tmp, 'nested/pet.json');
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('writePetTo creates parent dirs and round-trips state', () => {
    const p = newPet(T0);
    writePetTo(path, p);
    expect(existsSync(path)).toBe(true);
    expect(readPetFrom(path)).toEqual(p);
  });

  test('writePetTo applies chmod 0600 (same security treatment as auth.json)', () => {
    // The pet file isn't sensitive, but consistency with auth.json's 0600 keeps the
    // ~/.bk1/ directory under uniform perms — easier to audit, no surprises.
    writePetTo(path, newPet(T0));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('readPetFrom returns null when file is missing or corrupted', () => {
    expect(readPetFrom(path)).toBeNull();
    writePetTo(path, newPet(T0));
    // Now corrupt it
    require('fs').writeFileSync(path, 'not json', 'utf-8');
    expect(readPetFrom(path)).toBeNull();
  });
});

describe('renderPetView', () => {
  test('mentions name, stage, age, and includes stat bars', () => {
    const p: PetState = { ...newPet(T0), name: 'Pippin', hunger: 50, happiness: 75, energy: 60 };
    const out = renderPetView(p, hoursLater(2));
    expect(out).toContain('Pippin');
    expect(out).toContain('baby');
    expect(out).toContain('hunger');
    expect(out).toContain('happiness');
    expect(out).toContain('energy');
    expect(out).toContain('█'); // filled bar segment
  });

  test('unnamed pet shows the naming prompt', () => {
    // First-launch UX: the user must discover /pet name <name>. If the prompt regresses
    // the pet stays "(unnamed)" forever and no one realizes they can rename it.
    const p = newPet(T0);
    const out = renderPetView(p, T0);
    expect(out).toContain('/pet name');
  });
});

describe('legacy pet.json compat', () => {
  test('readPetFrom strips deprecated cosmetic/head_shape fields and still loads the pet', () => {
    // Pre-Clawd-redesign pet.json files have cosmetic + head_shape fields that the new
    // schema doesn't include. Loader must ignore them rather than treat them as corruption.
    const tmp = mkdtempSync(join(tmpdir(), 'bk1-legacy-'));
    const path = join(tmp, 'pet.json');
    const legacy = {
      name: 'Old Pet',
      born_at:   T0.toISOString(),
      last_seen: T0.toISOString(),
      hunger: 10, happiness: 80, energy: 90,
      cosmetic: 'ribbon',          // deprecated
      head_shape: 'wavy',          // deprecated
    };
    writeFileSync(path, JSON.stringify(legacy), 'utf-8');

    const loaded = readPetFrom(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Old Pet');
    expect(loaded!.hunger).toBe(10);
    expect('cosmetic' in loaded!).toBe(false);
    expect('head_shape' in loaded!).toBe(false);

    rmSync(tmp, { recursive: true, force: true });
  });
});
