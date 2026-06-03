import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LINT_RESPONSE_VIOLATIONS_FIELDS } from '../src/state';
import { SKILLS } from '../src/skills';

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

describe('lint-deep-headless contract with the bk1-review parser', () => {
  // The skill takes the queue via args; pass a representative one for the assertions.
  const headless = SKILLS['lint-deep-headless']!.expand('models/staging/stg_a.sql\nmodels/staging/stg_a.yml');

  // This is the SEMANTIC half only — the binary runs the mechanical linter itself. The
  // skill must never run lint_run (the binary owns that), never edit, never mark_linted.
  test('never instructs lint_run, file edits, or mark_linted', () => {
    expect(headless).toMatch(/NEVER edit/i);
    expect(headless).toMatch(/NEVER call mark_linted/i);
    expect(headless).toMatch(/NEVER call lint_run/i);
    expect(headless).not.toMatch(/action="mark_linted"/);
    expect(headless).not.toMatch(/action="lint_run"/);
  });

  // The agent wandered into run_dbt_command/bash in early testing; the prompt restricts
  // tools to fetch_content + sub-agents. Guard that restriction stays.
  test('restricts tools to fetch_content and agent', () => {
    expect(headless).toMatch(/ONLY tools you may use are model_state action="fetch_content" and the agent tool/i);
    expect(headless).toMatch(/NEVER call .*run_dbt_command/i);
  });

  // The bk1-review parser (extractFindingsArray) takes the last fenced ```json block and
  // parses it as a JSON ARRAY. If the prompt stops asking for an array, the parser breaks.
  test('instructs a single fenced json ARRAY', () => {
    expect(headless).toContain('```json');
    expect(headless).toMatch(/JSON ARRAY/i);
  });

  // Inline placement depends on evidence being a verbatim source line.
  test('requires verbatim evidence so it can be located in the diff', () => {
    expect(headless).toMatch(/verbatim/i);
  });

  // The empty-queue path must short-circuit with no tool calls.
  test('short-circuits to [] when the file list is empty', () => {
    const empty = SKILLS['lint-deep-headless']!.expand('');
    expect(empty).toMatch(/do NOT call any tool/i);
  });
});
