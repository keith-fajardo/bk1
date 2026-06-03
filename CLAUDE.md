# bk1

bk1 is a Terminal UI coding agent for dbt projects. The name comes from "bakawan" — the
Filipino word for mangrove — after Mangrove, the company building it.

This file is context for agents working **on bk1's source code**. For the conventions
bk1 enforces on *target* dbt projects, see [src/system-prompt.ts](src/system-prompt.ts)
and the Rust rule set in [sidecars/lint/src/checks.rs](sidecars/lint/src/checks.rs).

## Tech stack

- Runtime: Bun (TypeScript first-class — no separate build step for dev)
- UI: React + Ink (terminal rendering)
- API: `@anthropic-ai/sdk` — main agent on `claude-sonnet-4-6`, sub-agents on `claude-haiku-4-5-20251001`
- State: `bun:sqlite` (per-project DB at `<dbt_project>/target/bk1_state.db`)
- Sidecar binaries: source under [sidecars/](sidecars/), installed under `~/.bk1/`.
  - `bk1-lint` — Rust (Cargo), source in [sidecars/lint/](sidecars/lint/), installed to `~/.bk1/bk1-lint` (alongside the bundled kimball SQLite index at `~/.bk1/kimball/kimball.db`).
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
sidecars/
  lint/             Rust mechanical linter — emits violations.json
vscode-ext/         Optional VS Code companion extension — streams the active file
                    path + selection to ~/.bk1/ide-context.json, which
                    src/ide-context.ts reads and injects as a <system-reminder>
                    each turn (mirrors Claude Code's <ide_opened_file>).
                    Also auto-downloads the bk1 binary + sidecars from GitHub
                    Releases on first activation (see "Distribution" below).
scripts/install.sh  One-shot setup: builds binary, installs to skill dir, bun install
.github/workflows/  release.yml builds per-platform tarballs + GitHub Release
                    when package.json's version advances on a push to main
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

### Lint pipeline ([src/state.ts](src/state.ts) + [sidecars/lint/](sidecars/lint/))
1. `incrementalSync` stats every SQL file, reads/hashes only changed ones — this is what
   keeps re-runs cheap on large projects.
2. `lintRun` is a fused tool: sync → batch queue → spawn binary → aggregate violations.
   It exists to eliminate ~4 LLM round-trips per `/lint`.
3. The batch query is `lint_status IN ('pending', 'needs_recheck', 'violations')`.
   Models with prior violations stay in the queue until explicitly `mark_linted` as clean.
4. `aggregateViolations` is a pure function — extracted so the response-shape logic is
   unit-testable without spawning the binary.
5. The binary doubles as a headless CI linter. `--stdout` prints violations.json to
   stdout; `--fail-on <blocker|major|minor>` exits non-zero past a severity threshold.
   Both are opt-in — the no-flag path (write to `<binary_dir>/data`, always exit 0) is
   what `lintRun` relies on, so do not change that default. Sample workflow:
   [.github/workflows/dbt-lint.yml](.github/workflows/dbt-lint.yml).

### Headless PR review ([src/headless-review.ts](src/headless-review.ts))
`bk1-review` is a SECOND compiled binary (entry: [src/headless-review.ts](src/headless-review.ts),
built via `bun run build:review`, staged into the release tarball next to `bk1`/`bk1-lint`).
It's Ink-free — it drives the same `runAgent` loop the TUI uses, with console callbacks, then
posts a Copilot-style PR review (inline comments where findings map to changed diff lines, a
summary comment for the rest). It NEVER edits files.

The split that makes it reliable: **mechanical findings come straight from `lintRun` in-process
(deterministic, no LLM); the agent only runs the semantic pass.** An earlier all-LLM version
dropped deterministic findings and intermittently emitted no JSON — don't route mechanical
violations back through the model. The semantic half is the `lint-deep-headless` skill
(internal, filtered from `/help` via `INTERNAL_SKILLS`); the binary passes it the queue via
args and it returns a JSON array of semantic findings only. The pure glue (diff parse, line
match, payload build, score) lives in [src/review-mapping.ts](src/review-mapping.ts) and is
unit-tested in [tests/review-mapping.test.ts](tests/review-mapping.test.ts) without the agent
or network. GitHub I/O is the thin `fetch` layer in [src/github-review.ts](src/github-review.ts).
Gotchas baked into the code: `--commit` must be the PR HEAD sha (not the merge commit) or
inline comments 422; `--project-dir` goes through `setProjectDir` (project-dir.ts resolves at
import, so a late env mutation wouldn't take); the batched review folds comments into the body
on a 422 so a run never silently posts nothing. Sample workflow:
[.github/workflows/dbt-review.yml](.github/workflows/dbt-review.yml).

### Skills ([src/skills.ts](src/skills.ts))
Each skill's `expand(args)` returns a prompt string injected as a user message. **Skills
are LLM instructions, not code.** They are brittle by nature — when a skill references a
structured field of a tool response, add a contract test (see below).

### Impact-aware editing ([src/tools.ts](src/tools.ts))
`write_file` is not a dumb writer. When it edits an *existing* model SQL file and the
content actually changed, it derives the downstream blast radius from the manifest
(`blastRadiusFor` → `queryImpactData`, the same pure path `query_manifest impact` uses) and
appends a report — affected models by layer, tests at risk, the `dbt build --select model+`
re-test selector — to the `Wrote ...` result. This is structural, not a prompt suggestion:
the DAG decides what's affected so the agent can't skip it under pressure. Read-derived and
deterministic; the agent only narrates. No-op rewrites and brand-new files take the plain
path (no manifest parse). The report-formatting half is `formatBlastRadius` (pure, tested in
[tests/impact-blast-radius.test.ts](tests/impact-blast-radius.test.ts)). Behavior rule 5 in
[src/system-prompt.ts](src/system-prompt.ts) tells the agent to treat the report as
authoritative and scope re-tests to it.

Column-level is two-trigger because the tracer needs *compiled* SQL and `write_file` runs
before the edit is compiled:
  1. **On write_file** — `diffColumns` (pure, [src/lineage.ts](src/lineage.ts)) compares old
     vs new *raw* SQL output columns: removed/added are reliable name-level (no ref()
     resolution needed), redefined only when both sides trace cleanly. Summarized inline via
     `formatColumnDiff` and persisted via `recordColumnChanges` → the `pending_column_changes`
     JSON column on the `models` table ([src/state.ts](src/state.ts)). `incrementalSync` never
     writes that column, so it survives a sync.
  2. **On run_dbt_command** — after a successful `compile`/`build`/`run` (exit 0),
     `postCompileColumnTaint` drains the pending changes for the models that command touched
     (parsed from `--select`/`-s`/`--models`, else project-wide) and runs `propagateColumnTaint`
     against the now-fresh `target/compiled` SQL, appending the accurate downstream column taint.
     This fires only on the agent's *own* explicit dbt call — `write_file` never shells out to
     dbt itself, preserving the "agent decides when to run dbt" invariant.
`diffColumns` is unit-tested ([tests/column-diff.test.ts](tests/column-diff.test.ts)); the
record/drain SQLite round-trip and `postCompileColumnTaint`'s manifest glue are typed but not
yet covered by a test (no dbt fixture project in-repo). Exposures still aren't in either report
(manifest exposure shape unverified — no compiled manifest present to check against).

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

## Adding or changing a model

When introducing a new Claude model (or changing the default), update all of these so the
picker, cost tracking, and defaults stay in sync. Verify the exact model ID against the
API first (the bare alias, e.g. `claude-opus-4-8`, not a guessed date suffix):

- [src/app.tsx](src/app.tsx) — add `{ id, label }` to the `MODELS` picker list and a
  matching line in the `MODEL_DESCS` map.
- [src/pricing.ts](src/pricing.ts) — add the ID to `MODEL_RATES` with its rate tier.
  `rateFor` only strips `-YYYYMMDD` suffixes, so a new alias that isn't a date variant of
  an existing entry must be added explicitly or cost tracking falls through.
- [src/agent.ts](src/agent.ts) — only if changing the default `MODEL` / `SUB_AGENT_MODEL`.
  Otherwise the ID is selectable via the picker or `ANTHROPIC_MODEL` env var.

## Distribution

bk1 ships two ways. The bk1 source has to support both, which is why path
resolution is split between user data and bundled assets.

**Standalone** — user runs `scripts/install.sh` (or `bun run build:all`). bk1
binary lands in `~/.local/bin/bk1`, sidecars and bundled DB in `~/.bk1/`,
user data also in `~/.bk1/`. Single directory for everything.

**VS Code extension** — extension auto-downloads the platform-matched release
tarball to `<extension-globalStorage>/bk1/<version>/` on first activation
(see [vscode-ext/src/bk1-loader.ts](vscode-ext/src/bk1-loader.ts)). bk1
binary + sidecars + kimball.db all live there; user data stays at `~/.bk1/`
so it survives extension upgrades.

The two locations are reconciled in [src/bk1-home.ts](src/bk1-home.ts):

- `BK1_HOME` — always `~/.bk1` (env-overridable). User data only:
  auth.json, pet.json, usage.db, ide-context.json (written by the extension,
  read by bk1).
- `bk1AssetsDir()` — sibling-of-binary first, then `~/.bk1`. Returns where
  to find bk1-lint and kimball/kimball.db. Used by
  [src/skills.ts](src/skills.ts), [src/kimball.ts](src/kimball.ts), and the
  `lintBuilt` status check in [src/app.tsx](src/app.tsx).

**Releasing.** Run `bun run bump <x.y.z>` (see [scripts/bump.ts](scripts/bump.ts)),
commit, and push to main — no hand-tagging. [.github/workflows/release.yml](.github/workflows/release.yml)
gates on the version: when package.json's version has no matching `v<x.y.z>`
tag yet, it builds darwin-arm64, darwin-x64, and linux-x64 tarballs (bk1,
bk1-lint, kimball/kimball.db at the tarball root), creates the tag + GitHub
Release at that commit, and pushes the homebrew formula. Pushes that don't
change the version no-op at the gate. Two things **must** match per release —
`bun run bump` keeps them in sync and refuses to run if they've drifted:

- `version` in [package.json](package.json) — shown in the banner via
  [src/version.ts](src/version.ts) which imports the JSON. Bun bundles this
  into the compiled binary at build time. Also the value the gate releases on.
- `BK1_VERSION` in [vscode-ext/src/bk1-loader.ts](vscode-ext/src/bk1-loader.ts) —
  drives the URL the extension fetches: `bk1-<BK1_VERSION>-<platform>.tar.gz`
  from the `v<BK1_VERSION>` release. Mismatch = 404 on first activation.

The `v<x.y.z>` git tag is created automatically by CI from package.json's
version, so it can't drift — there's nothing to tag by hand.

The `version` in [vscode-ext/package.json](vscode-ext/package.json) is independent
of the above — it's the marketplace version of the extension itself and can
bump out of lockstep with the bk1 release (e.g. ship a cosmetic extension
update without rebuilding bk1).

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
