// Wire protocol between a bk1 client and the playroom relay.
// One JSON message per WebSocket frame. The relay is intentionally dumb —
// once two peers are paired in a room, any `data` op is forwarded to the
// other peer unchanged. The relay does not parse game messages.

export type RelayClientMsg =
  | { op: 'create' }
  | { op: 'join'; pin: string }
  | { op: 'data'; payload: string };

export type RelayServerMsg =
  | { op: 'created'; pin: string }
  | { op: 'joined' }
  | { op: 'paired' }
  | { op: 'data'; payload: string }
  | { op: 'peer_left' }
  | { op: 'error'; msg: string };

// Pin charset: uppercase letters + digits minus visually confusing
// glyphs (0/O, 1/I/L). 32 symbols × 6 chars = ~1 billion combinations.
export const PIN_CHARSET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PIN_LENGTH = 6;

export function generatePin(): string {
  let out = '';
  for (let i = 0; i < PIN_LENGTH; i++) {
    out += PIN_CHARSET[Math.floor(Math.random() * PIN_CHARSET.length)];
  }
  return out;
}

export function isValidPin(s: string): boolean {
  if (s.length !== PIN_LENGTH) return false;
  for (const ch of s) if (!PIN_CHARSET.includes(ch)) return false;
  return true;
}
