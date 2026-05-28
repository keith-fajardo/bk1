# bk1

bk1 is a Terminal UI coding agent for dbt projects. The name comes from "bakawan" — the
Filipino word for mangrove — after Mangrove, the company building it.

This file is context for agents working **on bk1's source code**. For the conventions
bk1 enforces on *target* dbt projects, see [src/system-prompt.ts](src/system-prompt.ts)
and the Rust rule set in [lint/src/checks.rs](lint/src/checks.rs).

## Tech stack

- Runtime: Bun (TypeScript first-class — no separate build step for dev)
- UI: React + Ink (terminal rendering)
- API: `@anthropic-ai/sdk` — main agent on `claude-sonnet-4-6`, sub-agents on `claude-haiku-4-5-20251001`
- State: `bun:sqlite` (per-project DB at `<dbt_project>/target/bk1_state.db`)
- Lint binary: Rust (Cargo), source in [lint/](lint/), installed to `~/.bk1/bk1-lint` (alongside the bundled kimball SQLite index at `~/.bk1/kimball/kimball.db`)
- Tests: `bun test`

Prefer Bun APIs (`Bun.spawn`, `Bun.Glob`, `Bun.file`) over Node equivalents when both work.

## Layout

```
src/
  app.tsx           Ink TUI — main loop, input handling, message rendering
  agent.ts          Anthropic SDK loop, sub-agent throttle, 429 retry, prompt caching
  tools.ts          Tool definitions + executors exposed to the agent
  state.ts          SQLite model state, incremental sync, lint aggregation
  skills.ts         Slash-command expansions (LLM instructions, not code)
  system-prompt.ts  Static system prompt for the main agent
lint/               Rust mechanical linter — emits violations.json
scripts/install.sh  One-shot setup: builds binary, installs to skill dir, bun install
tests/              bun:test suites (aggregation correctness, skill contract)
```

## Commands

    bun run setup       Build Rust binary + install skill dir + bun install
    bun run dev         Start the TUI in $CWD (must contain dbt_project.yml)
    bun test            Run all tests
    bun run build:lint  Rebuild the Rust binary only
    bun run build:all   Compile single binary to ~/.local/bin/bk1

`DBT_PROJECT_DIR` overrides the working directory bk1 operates against.

## Architecture notes

### Agent loop ([src/agent.ts](src/agent.ts))
- Main agent has all tools. Sub-agents (`agent` tool) inherit all tools *except* `agent`
  itself — prevents recursive fan-out.
- Sub-agents are throttled to 2 concurrent via a semaphore. The throttle exists to stay
  under Anthropic's 30K input-tokens/minute limit — do not raise without confirming the
  account's current rate caps.
- Prompt caching is applied to (a) the resolved system prompt and (b) the last tool
  definition (Anthropic caches up to and including the marked block). Caching is the
  single biggest cost lever — do not break the `withToolCache` / `cachedSystem` pattern.

### Lint pipeline ([src/state.ts](src/state.ts) + [lint/](lint/))
1. `incrementalSync` stats every SQL file, reads/hashes only changed ones — this is what
   keeps re-runs cheap on large projects.
2. `lintRun` is a fused tool: sync → batch queue → spawn binary → aggregate violations.
   It exists to eliminate ~4 LLM round-trips per `/lint`.
3. The batch query is `lint_status IN ('pending', 'needs_recheck', 'violations')`.
   Models with prior violations stay in the queue until explicitly `mark_linted` as clean.
4. `aggregateViolations` is a pure function — extracted so the response-shape logic is
   unit-testable without spawning the binary.

### Skills ([src/skills.ts](src/skills.ts))
Each skill's `expand(args)` returns a prompt string injected as a user message. **Skills
are LLM instructions, not code.** They are brittle by nature — when a skill references a
structured field of a tool response, add a contract test (see below).

### Response shape contract
The lint_run response field names are pinned by `LINT_RESPONSE_VIOLATIONS_FIELDS` in
[src/state.ts](src/state.ts). [tests/skill-contract.test.ts](tests/skill-contract.test.ts)
parses [src/skills.ts](src/skills.ts) for `violations.<field>` references and fails if
any reference isn't on the allowlist. This guards against the prior bug where the skill
silently referenced a non-existent field and the LLM fell back to the wrong one.

## Conventions for editing this codebase

- Plain text only in the agent's *responses to users* — no markdown, no code fences, no
  bullet asterisks. This rule is in [src/system-prompt.ts](src/system-prompt.ts) and is
  intentional UX, not laziness. Do not loosen it.
- Comments only when the *why* is non-obvious. Don't restate what the code does.
- No defensive null-checks at internal boundaries. Validate at system boundaries only.
- Don't add backwards-compat shims when changing internal APIs — just update callers.
- Match the surrounding style. The codebase trends concise.

## Things to avoid

- Don't modify a target dbt project's CLAUDE.md from inside any skill. bk1 reads it as
  context; it never writes it.
- Don't rename fields on `lint_run` without updating `LINT_RESPONSE_VIOLATIONS_FIELDS`
  *and* the skill references — the contract test will fail loudly, which is the point.
- Don't add a new tool without deciding if it should be in `SUB_AGENT_TOOLS`. The default
  filter excludes only `agent`; anything that could trigger expensive fan-out (new tool
  spawning, long-running shell) should be reviewed before sub-agents get it.
- Don't bypass `safeResolvePath` in any file-handling tool.

## Testing

Two suites, both fast (~20ms total):

- [tests/lint-aggregation.test.ts](tests/lint-aggregation.test.ts) — covers
  `aggregateViolations`: severity sort order (blocker → major → minor), batch vs.
  project scoping, count tallies, semantic-queue intersection, empty inputs.
- [tests/skill-contract.test.ts](tests/skill-contract.test.ts) — the response-shape
  guard described above.

When adding a new skill that consumes structured tool output, add a contract test in the
same file. The pattern is: parse the skill source for the field references, assert each
exists on the exported allowlist.
