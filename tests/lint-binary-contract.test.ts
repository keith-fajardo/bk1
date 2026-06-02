import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Bug class this guards (the v.fix → suggested_fix crash):
// the Rust binary serializes each violation with field names from its `Violation`
// struct, but the TS side reads those fields off the parsed violations.json. If the
// two names drift, the TS field is silently `undefined` — and tsc does NOT catch it,
// because the JSON is parsed with a cast (`as LintOutput`), not validated. The first
// run that produces a violation then crashed report generation with
// `undefined is not an object (evaluating 's.replace')`.
//
// This test reads the actual Rust struct and the actual TS interface and asserts every
// field the TS interface declares exists on the Rust struct under the same name.

const root      = join(import.meta.dir, '..');
const rustSrc   = readFileSync(join(root, 'sidecars', 'lint', 'src', 'types.rs'), 'utf-8');
const stateSrc  = readFileSync(join(root, 'src', 'state.ts'), 'utf-8');

// Pull the field names out of `pub struct Violation { ... }` in types.rs. serde
// serializes each `pub <name>: ...` field under <name> verbatim (no rename attrs
// are used in this struct — if one is ever added this regex must learn about it).
function rustViolationFields(): string[] {
  const block = rustSrc.match(/pub struct Violation\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error('could not locate `pub struct Violation` in types.rs');
  return [...block[1]!.matchAll(/pub\s+([a-z_][a-z0-9_]*)\s*:/g)].map(m => m[1]!);
}

// Pull the field names out of `export interface LintViolation { ... }` in state.ts.
function tsViolationFields(): string[] {
  const block = stateSrc.match(/export interface LintViolation\s*\{([^}]*)\}/);
  if (!block) throw new Error('could not locate `export interface LintViolation` in state.ts');
  return [...block[1]!.matchAll(/([a-z_][a-z0-9_]*)\s*:/g)].map(m => m[1]!);
}

describe('LintViolation TS interface contract with the Rust binary output', () => {
  test('every TS LintViolation field exists on the Rust Violation struct', () => {
    const rust = new Set(rustViolationFields());
    const ts   = tsViolationFields();
    expect(rust.size).toBeGreaterThan(0);
    expect(ts.length).toBeGreaterThan(0);
    const missing = ts.filter(f => !rust.has(f));
    expect(missing).toEqual([]);
  });

  // Guard the specific regression: the TS side must read `suggested_fix`, never the
  // old short name `fix` the binary never emitted.
  test('TS interface uses suggested_fix, not the non-existent `fix`', () => {
    const ts = tsViolationFields();
    expect(ts).toContain('suggested_fix');
    expect(ts).not.toContain('fix');
  });

  // The report row that crashed must read a field that exists on the struct.
  test('writeLintReportHtml reads only fields present on the Rust struct', () => {
    const rust = new Set(rustViolationFields());
    // v.<field> references inside state.ts (the report generator's violation rows).
    const refs = [...stateSrc.matchAll(/\bv\.([a-z_][a-z0-9_]*)/g)].map(m => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    const unknown = [...new Set(refs)].filter(f => !rust.has(f));
    expect(unknown).toEqual([]);
  });
});
