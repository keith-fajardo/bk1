import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LINT_RESPONSE_VIOLATIONS_FIELDS } from '../src/state';

const skillsPath = join(import.meta.dir, '..', 'src', 'skills.ts');
const skillsSrc  = readFileSync(skillsPath, 'utf-8');

describe('skills.ts contract with lint_run response shape', () => {
  // Bug class: skill instructions reference a field (e.g. `violations.project_by_rule`)
  // that does not exist on the lint_run response — the LLM silently falls back to a
  // similarly-named field and produces wrong output. This regression test parses every
  // `violations.<field>` reference in skills.ts and asserts the field is in the
  // exported allowlist.
  test('every violations.<field> reference resolves to an exported field', () => {
    const allowlist: readonly string[] = LINT_RESPONSE_VIOLATIONS_FIELDS;
    // 'json' is the binary's output filename (violations.json), not a response field.
    const filenameSuffixes = new Set(['json']);
    const refs = [...skillsSrc.matchAll(/violations\.([a-z_][a-z0-9_]*)/g)]
      .map(m => m[1]!)
      .filter(r => !filenameSuffixes.has(r));
    expect(refs.length).toBeGreaterThan(0);
    const unknown = refs.filter(r => !allowlist.includes(r));
    expect(unknown).toEqual([]);
  });

  // Guard against the specific regression: the old field `by_rule` (batch-scoped)
  // must never reappear in skills.ts. The display table must use project_by_rule.
  test('skills.ts does not reference the removed `violations.by_rule` field', () => {
    const stillReferenced = /violations\.by_rule\b/.test(skillsSrc);
    expect(stillReferenced).toBe(false);
  });

  // /lint instructs the LLM to format the summary table using project_by_rule.
  // If this line is ever removed or weakened, the bug recurs.
  test('skills.ts instructs use of violations.project_by_rule for the table', () => {
    expect(skillsSrc).toContain('violations.project_by_rule');
  });
});
