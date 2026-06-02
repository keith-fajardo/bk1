import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { executeTool } from '../src/tools';
import { getProjectDir } from '../src/project-dir';

// Relative paths (what the agent actually passes) and their absolute equivalents.
const TMP_REL  = 'tests/.tmp';
const TMP_ABS  = join(getProjectDir(), TMP_REL);
const SMALL_REL = `${TMP_REL}/small.txt`;
const HUGE_REL  = `${TMP_REL}/huge.txt`;
const TARGET_ABS = join(getProjectDir(), 'target');
const MANIFEST_REL = 'target/manifest.json';
const RUN_RESULTS_REL = 'target/run_results.json';

// Track which files we created so teardown only deletes those — never anything pre-existing.
const created: string[] = [];

function writeIfAbsent(absPath: string, content: string) {
  if (existsSync(absPath)) return;
  mkdirSync(absPath.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(absPath, content);
  created.push(absPath);
}

beforeAll(() => {
  mkdirSync(TMP_ABS, { recursive: true });
  writeFileSync(join(TMP_ABS, 'small.txt'), 'hello\n');
  created.push(join(TMP_ABS, 'small.txt'));
  // 110 KB — comfortably above the 100 KB default cap
  writeFileSync(join(TMP_ABS, 'huge.txt'), 'x'.repeat(110_000));
  created.push(join(TMP_ABS, 'huge.txt'));

  // Create stub manifest.json + run_results.json only if they don't already exist
  // (running tests from a real dbt-aware workspace shouldn't overwrite real files).
  writeIfAbsent(join(TARGET_ABS, 'manifest.json'),     '{"stub": true}');
  writeIfAbsent(join(TARGET_ABS, 'run_results.json'), '{"stub": true}');
});

afterAll(() => {
  for (const p of created) {
    try { rmSync(p); } catch {}
  }
  // Only remove tests/.tmp if we created it. target/ may have been pre-existing.
  try { rmSync(TMP_ABS, { recursive: true }); } catch {}
});

describe('read_file size guard', () => {
  test('small file under the cap is returned normally', async () => {
    const result = await executeTool('read_file', { path: SMALL_REL });
    expect(result).toBe('hello\n');
  });

  test('file over the cap is refused with a size + cap message', async () => {
    const result = await executeTool('read_file', { path: HUGE_REL });
    expect(result).toContain('refused');
    expect(result).toContain('110000');
    expect(result).toContain('cap');
  });

  test('target/manifest.json is refused with a redirect to query_manifest', async () => {
    const result = await executeTool('read_file', { path: MANIFEST_REL });
    expect(result).toContain('refused');
    expect(result).toContain('query_manifest');
  });

  test('target/run_results.json is refused with a redirect to query_run_results', async () => {
    const result = await executeTool('read_file', { path: RUN_RESULTS_REL });
    expect(result).toContain('refused');
    expect(result).toContain('query_run_results');
  });

  test('non-existent file returns the standard not-found message', async () => {
    const result = await executeTool('read_file', { path: 'tests/.tmp/does-not-exist.txt' });
    expect(result).toContain('File not found');
  });

  test('path outside the project directory is rejected', async () => {
    const result = await executeTool('read_file', { path: '../../../etc/passwd' });
    expect(result.toLowerCase()).toContain('outside project');
  });
});
