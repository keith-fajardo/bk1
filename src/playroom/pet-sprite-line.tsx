import React from 'react';
import { Text } from 'ink';

// Half-block cell table. Each key is one char from the encoded sprite (alphabet
// defined in pet.ts). Two stacked pixels are rendered into ONE terminal cell using
// the ▀ glyph: foreground paints the upper half, background paints the lower half.
// For cells where both halves are the same color, a space with that background is
// preferred — it fills the font line-leading so cells meet flush vertically
// (the original stripe-elimination trick, applied per cell).
export const PET_BODY  = '#9FE749';
const PET_EYE   = '#000000';
const PET_BLINK = '#FCD34D';

interface CellSpec { glyph: string; fg?: string; bg?: string; }
export const PET_CELLS: Record<string, CellSpec> = {
  B: { glyph: ' ', bg: PET_BODY },                 // body | body
  V: { glyph: '▀', fg: PET_EYE,   bg: PET_BODY },  // eye-open (top) | body
  M: { glyph: '▄', fg: PET_EYE,   bg: PET_BODY },  // body | eye-open (bottom)
  H: { glyph: '─', fg: PET_EYE,   bg: PET_BODY },  // thin horizontal line — closed-eye dash
  // Eating-mouth cells — chosen to be GUARANTEED 1 terminal cell wide so the body
  // outline stays rectangular while the mouth animates. Wide wave glyphs (U+301C
  // 〜 / U+FF5E ～) render as 1 cell in some fonts and 2 in others, which leaves a
  // notch on the side of the body whenever the terminal's idea of the char width
  // disagrees with the encoded row length.
  W: { glyph: '~', fg: PET_EYE,   bg: PET_BODY },  // ASCII tilde — eating frame A (wavy mouth)
  T: { glyph: '—', fg: PET_EYE,   bg: PET_BODY },  // ASCII em dash — eating frame B (flat mouth)
  // Right-cheek paren — sits to the LEFT of the eating mouth so the face reads as
  // a profile munch: `)` (cheek) then `~` / `-` (mouth in motion).
  ')': { glyph: ')', fg: PET_EYE, bg: PET_BODY },
  Y: { glyph: '▀', fg: PET_BLINK, bg: PET_BODY },  // eye-blink | body
  U: { glyph: '▀', fg: PET_BODY },                 // body | empty (legacy: legs / sprite top)
  L: { glyph: '▄', fg: PET_BODY },                 // empty | body  (leg hanging below body)
  S: { glyph: '꩜', fg: PET_EYE,  bg: PET_BODY },  // U+AA5C spiral — hungry-mood eye glyph
  ' ': { glyph: ' ' },                              // empty | empty
};

export const PET_SPRITE_SENTINEL = '​'; // zero-width space — sprite-line marker

export function PetSpriteLine({ line, bodyColor }: { line: string; bodyColor?: string }) {
  const payload = line.startsWith(PET_SPRITE_SENTINEL) ? line.slice(1) : line;
  // Per-pet color override: PET_BODY is the only color that varies across pets
  // (eyes / blink stay default). Any cell whose fg or bg is PET_BODY gets
  // remapped to the override; everything else passes through unchanged.
  const swap = (c: string | undefined): string | undefined =>
    bodyColor && c === PET_BODY ? bodyColor : c;
  return (
    <Text>
      {[...payload].map((ch, i) => {
        const spec = PET_CELLS[ch];
        if (!spec) return <Text key={i}>{ch}</Text>;
        const bg = swap(spec.bg);
        const fg = swap(spec.fg);
        if (bg && fg) return <Text key={i} color={fg} backgroundColor={bg}>{spec.glyph}</Text>;
        if (bg)       return <Text key={i} backgroundColor={bg}>{spec.glyph}</Text>;
        if (fg)       return <Text key={i} color={fg}>{spec.glyph}</Text>;
        return <Text key={i}>{spec.glyph}</Text>;
      })}
    </Text>
  );
}
