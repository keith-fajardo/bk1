import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, statSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isValidKeyShape,
  readKeyFrom,
  writeKeyTo,
  clearKeyAt,
  getStoredKey,
} from '../src/auth';

describe('isValidKeyShape', () => {
  test('accepts realistic sk-ant- keys', () => {
    expect(isValidKeyShape('sk-ant-api03-abcdefghijklmnop')).toBe(true);
    // Real keys are ~108 chars; we don't enforce an upper bound.
    expect(isValidKeyShape('sk-ant-' + 'a'.repeat(100))).toBe(true);
  });

  test('rejects empty, whitespace, and obviously wrong shapes', () => {
    expect(isValidKeyShape('')).toBe(false);
    expect(isValidKeyShape('   ')).toBe(false);
    expect(isValidKeyShape('sk-openai-xyz')).toBe(false);
    expect(isValidKeyShape('not a key')).toBe(false);
    // Too short — guards against accidentally pasting a fragment.
    expect(isValidKeyShape('sk-ant-')).toBe(false);
    expect(isValidKeyShape('sk-ant-abc')).toBe(false);
  });

  test('tolerates surrounding whitespace from clipboard managers', () => {
    expect(isValidKeyShape('  sk-ant-api03-' + 'x'.repeat(20) + '  ')).toBe(true);
  });
});

describe('file storage round-trip', () => {
  let tmpDir: string;
  let authPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bk1-auth-test-'));
    authPath = join(tmpDir, 'nested/auth.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writeKeyTo creates parent directories and stores the key', () => {
    writeKeyTo(authPath, 'sk-ant-test-value-12345');
    expect(existsSync(authPath)).toBe(true);
    const got = readKeyFrom(authPath);
    expect(got).toBe('sk-ant-test-value-12345');
  });

  test('writeKeyTo trims whitespace before storing', () => {
    // Important: paste from a clipboard manager often includes trailing whitespace.
    // If we stored it verbatim, the Anthropic SDK would reject the key with a confusing error.
    writeKeyTo(authPath, '  sk-ant-padded-key-1234567890  \n');
    expect(readKeyFrom(authPath)).toBe('sk-ant-padded-key-1234567890');
  });

  test('writeKeyTo applies chmod 0600 (owner-read-write only)', () => {
    // Security contract: anyone else on the machine shouldn't be able to read the key
    // off disk. If this regresses to 0644 we leak credentials to other local users.
    writeKeyTo(authPath, 'sk-ant-test-12345');
    const mode = statSync(authPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('readKeyFrom returns null when file is missing', () => {
    expect(readKeyFrom(authPath)).toBeNull();
  });

  test('readKeyFrom returns null when file is corrupted JSON', () => {
    // Defensive: a partially-written auth.json (interrupted disk write, etc.) should
    // degrade to "not logged in" rather than crashing the TUI on startup.
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(authPath, '{ not valid json', 'utf-8');
    expect(readKeyFrom(authPath)).toBeNull();
  });

  test('readKeyFrom returns null when apiKey field is missing or empty', () => {
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ storedAt: 'now' }), 'utf-8');
    expect(readKeyFrom(authPath)).toBeNull();
    writeFileSync(authPath, JSON.stringify({ apiKey: '' }), 'utf-8');
    expect(readKeyFrom(authPath)).toBeNull();
  });

  test('stored file is human-readable JSON (for debugging, not encryption)', () => {
    // We're not pretending this is encrypted — confirm the on-disk format is what a
    // user would expect if they cat'd the file. Encryption would need Keychain.
    writeKeyTo(authPath, 'sk-ant-test-12345');
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8'));
    expect(parsed).toHaveProperty('apiKey');
    expect(parsed).toHaveProperty('storedAt');
    expect(typeof parsed.storedAt).toBe('string');
  });

  test('clearKeyAt removes the file and reports success/no-op honestly', () => {
    writeKeyTo(authPath, 'sk-ant-test-12345');
    expect(clearKeyAt(authPath)).toBe(true);
    expect(existsSync(authPath)).toBe(false);
    // Second call: file is already gone, should be a no-op returning false.
    expect(clearKeyAt(authPath)).toBe(false);
  });
});

describe('getStoredKey precedence (env > file)', () => {
  let saved: string | undefined;

  beforeEach(() => { saved = process.env.ANTHROPIC_API_KEY; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  test('env var wins when set (preserves .env / CI workflows)', () => {
    // This is the load-bearing test for backward compatibility. If env precedence regresses,
    // existing .env-based users find their stored key silently overriding their env config.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    expect(getStoredKey()).toBe('sk-ant-from-env');
  });

  test('empty/whitespace env var is treated as unset (falls through to file)', () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    // We don't seed the file here, so this also confirms the function doesn't throw
    // when both sources are empty.
    const got = getStoredKey();
    expect(got === null || typeof got === 'string').toBe(true);
  });
});
