// Persistent API-key storage for bk1.
//
// Key resolution order (caller responsibility — we just provide the pieces):
//   1. process.env.ANTHROPIC_API_KEY  — for users who export it in their shell rc
//                                       (zshrc, bashrc) or CI pipelines.
//   2. ~/.bk1/auth.json               — written by the in-app login flow.
//   3. neither → show login screen.
//
// bk1 no longer loads .env files itself (removed when the login flow shipped). If you
// want bk1 to pick up a key from a file, either export it in your shell rc or paste
// it through /login.
//
// On-disk storage is JSON with chmod 0600 (owner-read-write only). That's adequate for
// a dev tool on a single-user machine. macOS Keychain via the `security` CLI would be
// more robust on shared boxes; can be added later behind the same API.

import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const AUTH_FILE = join(homedir(), '.bk1', 'auth.json');
const ADMIN_AUTH_FILE = join(homedir(), '.bk1', 'admin-auth.json');

interface StoredAuth {
  apiKey: string;
  storedAt: string;
}

// Path-parameterized variants — exported so tests can hit a temp file without
// touching ~/.bk1/auth.json on the dev box. Production callers should use the
// no-arg wrappers below.
export function readKeyFrom(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as StoredAuth;
    if (typeof data.apiKey === 'string' && data.apiKey.length > 0) return data.apiKey;
    return null;
  } catch {
    return null;
  }
}

export function writeKeyTo(path: string, key: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const data: StoredAuth = { apiKey: key.trim(), storedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  // chmod AFTER write — must restrict before any other process could read it.
  chmodSync(path, 0o600);
}

export function clearKeyAt(path: string): boolean {
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function getStoredKey(): string | null {
  // Env wins so shell-exported keys (zshrc / CI) still take precedence over the login file.
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().length > 0) {
    return process.env.ANTHROPIC_API_KEY;
  }
  return readKeyFrom(AUTH_FILE);
}

export function storeKey(key: string): void {
  writeKeyTo(AUTH_FILE, key);
}

export function clearStoredKey(): boolean {
  return clearKeyAt(AUTH_FILE);
}

// Loose shape check: Anthropic keys are `sk-ant-...` followed by 80+ chars. Don't over-validate
// (formats can change); the real validation happens when the SDK first makes a call.
export function isValidKeyShape(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.startsWith('sk-ant-') && trimmed.length >= 20;
}

export function authFilePath(): string {
  return AUTH_FILE;
}

export function getStoredAdminKey(): string | null {
  return readKeyFrom(ADMIN_AUTH_FILE);
}

export function storeAdminKey(key: string): void {
  writeKeyTo(ADMIN_AUTH_FILE, key);
}

export function adminAuthFilePath(): string {
  return ADMIN_AUTH_FILE;
}
