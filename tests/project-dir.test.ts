import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getProjectDir, setProjectDir, isDbtProject, checkProjectAccess } from '../src/project-dir';

// The dir bk1 launched in. Captured before any test mutates it so afterEach can
// restore it — the project dir is module-global, so a leaked change would
// corrupt other suites that read getProjectDir().
const LAUNCH_DIR = getProjectDir();

// Temp dir that either is or isn't a dbt project (presence of dbt_project.yml).
const created: string[] = [];
function makeDir(isProject: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'bk1-projdir-'));
  if (isProject) writeFileSync(join(dir, 'dbt_project.yml'), 'name: test\n', 'utf-8');
  created.push(dir);
  return dir;
}

afterEach(() => {
  try { setProjectDir(LAUNCH_DIR); } catch { /* launch dir may not be a dbt project — fine */ }
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('isDbtProject', () => {
  test('true only when dbt_project.yml is present', () => {
    expect(isDbtProject(makeDir(true))).toBe(true);
    expect(isDbtProject(makeDir(false))).toBe(false);
  });

  test('false for a path that does not exist', () => {
    expect(isDbtProject('/no/such/path/anywhere-xyz')).toBe(false);
  });
});

describe('setProjectDir', () => {
  test('switches the active dir to a valid dbt project and returns the resolved path', () => {
    const dir = makeDir(true);
    expect(setProjectDir(dir)).toBe(dir);
    expect(getProjectDir()).toBe(dir);
  });

  test('rejects a non-dbt directory and leaves the active dir unchanged', () => {
    const good = makeDir(true);
    setProjectDir(good);
    const bad = makeDir(false);
    expect(() => setProjectDir(bad)).toThrow(/not a dbt project/i);
    expect(getProjectDir()).toBe(good);  // failed switch must not mutate state
  });
});

describe('checkProjectAccess', () => {
  test('ok when dbt_project.yml is readable', () => {
    expect(checkProjectAccess(makeDir(true))).toEqual({ ok: true });
  });

  // Regression: existsSync (so isDbtProject) passes but readFileSync throws —
  // the macOS-TCC case that used to crash the TUI on /project switch. The
  // `denied` flag is what drives the guided Full Disk Access flow.
  test('flags a permission denial when dbt_project.yml exists but is unreadable', () => {
    const dir = makeDir(true);
    const file = join(dir, 'dbt_project.yml');
    chmodSync(file, 0o000);
    try {
      const access = checkProjectAccess(dir);
      // Skip the assertion if the runner can read it anyway (e.g. running as root).
      if (!access.ok) {
        expect(access.denied).toBe(true);
        expect(access.message).toMatch(/permission denied/i);
      }
    } finally {
      chmodSync(file, 0o644);  // restore so afterEach can rm the temp dir
    }
  });
});
