# bk1

A **deterministic dbt linter with a coding agent attached** — for **dbt Core**, in your terminal. By [Mangrove](https://gridland.io).

dbt Cloud users get **dbt Copilot** inside the dbt Cloud IDE. Everyone on **dbt Core** — the open-source CLI most teams actually run — has had to choose between generic coding agents that don't understand dbt conventions, or VS Code plugins that lock them into one editor. bk1 is the dbt-native option for the terminal: it runs locally against your project on disk, uses your own Anthropic key, and requires no Cloud account.

The name is short for **bakawan** — Filipino for *mangrove*.

What sets bk1 apart in the dbt Core + terminal space:

- **A real linter, not a prompt.** A native Rust binary ([`lint/`](lint/)) mechanically checks your project against Kimball-flavored conventions before a single LLM token is spent. Cursor, Aider, and Claude Code can *talk about* dbt style; bk1 *enforces* it deterministically and in milliseconds.
- **Manifest-aware by default.** Tools like `query_manifest` read `manifest.json` directly, so the agent doesn't burn tokens rediscovering your project on every turn.
- **Opinionated dbt conventions baked into the system prompt** — first-draft output already conforms to `stg_ / int_ / dim_ / fct_` patterns, SCD typing, schema placement, and YAML structure.
- **Cost-aware architecture.** Prompt caching on the system prompt and tool definitions; sub-agents on Haiku, throttled to 2 concurrent; per-project SQLite state for incremental sync so re-runs stay cheap on 1,000+ model repos.
- **Bundled Kimball knowledge base.** *The Data Warehouse Toolkit (3rd ed.)* indexed via SQLite + FTS5 — ask dimensional-modeling questions and get grounded answers.

Everything ships in one repo: the agent, the linter, an optional VS Code companion extension, and the Kimball knowledge base. Fixes are only applied with your approval.

```
┌──────────────────────────────────────────────────────────┐
│  PLAN >  Sonnet 4.6                                      │
│                                                          │
│        ████████   motchi: (•‿•)  ·  ~$0.31 session       │
│        ██ ██ ██   balance ↗ console.anthropic.com/...    │
│        ████████                                          │
│                                                          │
│  ↵ send   Tab switch mode   ↑↓ navigate   Ctrl+C exit    │
└──────────────────────────────────────────────────────────┘
```

## What it does

- **Investigate failed dbt runs** — diagnoses every failed model from the last `dbt run`, distinguishes upstream cascades from root causes, proposes fixes in dependency order.
- **Explain models** — purpose, lineage, columns, SQL walkthrough, recent change history.
- **Document models** — generates YAML with descriptions and conservative tests, waits for approval before writing.
- **Lint mechanically** — Rust binary scans the project against the rules in [`lint/src/checks.rs`](lint/src/checks.rs), emits an [HTML report](#html-lint-reports) and a tabular summary.
- **Lint-deep (semantic)** — fans out to sub-agents that each enforce one rule across the relevant files, then aggregates a health score and prioritized fix plan.
- **Kimball consultancy** — answers dimensional-modeling questions grounded in *The Data Warehouse Toolkit (3rd ed.)*, indexed via a bundled SQLite + FTS5 library.
- **Refactor with guardrails** — never runs `dbt build` / `dbt run`, never touches `CLAUDE.md`, never deletes a model file. All edits gated on explicit user approval.

## How bk1 compares

|                                              | **bk1**                | dbt Copilot         | Claude Code / Cursor + dbt MCP | dbt-power-user (VS Code) |
|----------------------------------------------|------------------------|---------------------|--------------------------------|--------------------------|
| Works with dbt **Core**                      | ✅                     | ❌ Cloud only       | ✅                             | ✅                       |
| Runs locally, no cloud account               | ✅                     | ❌                  | ✅                             | ✅                       |
| Terminal-first (TUI)                         | ✅                     | ❌ (web IDE)        | ✅ Claude Code / ❌ Cursor      | ❌ (VS Code only)        |
| dbt-aware conventions out of the box         | ✅                     | ✅                  | ⚠️ via MCP, no opinions        | ⚠️ partial               |
| Mechanical linter (deterministic, pre-LLM)   | ✅                     | ❌                  | ❌                             | ⚠️ SQLFluff integration  |
| Bundled Kimball knowledge base               | ✅                     | ❌                  | ❌                             | ❌                       |
| Manifest-aware tools (incremental sync)      | ✅                     | ✅                  | ⚠️ via MCP                     | ✅                       |
| Semantic / multi-agent lint                  | ✅                     | ❌                  | ❌                             | ❌                       |
| Bring-your-own API key                       | ✅ (Anthropic)         | ❌ (bundled)        | ✅                             | ✅ (OpenAI)              |
| Cost model                                   | Pay-per-token only     | Per-seat Cloud tier | Pay-per-token + tool sub       | Free + own key           |

If you're on dbt Cloud, dbt Copilot is the obvious choice. If you're on dbt Core and live in the terminal, bk1 is built for you — it's the only option in that segment that pairs a dbt-aware agent with a deterministic Rust linter and a manifest-first toolset. If you're on Core but live in VS Code, `dbt-power-user` covers a lot of ground; bk1 complements it by adding the lint-first agent loop and Kimball reasoning.

## Quickstart

Requires [Bun](https://bun.sh), [Rust](https://rustup.rs), and an Anthropic API key.

```sh
git clone https://github.com/keith-fajardo/bk1.git
cd bk1
bun run setup            # builds Rust linter, installs to ~/.bk1, runs bun install
export DBT_PROJECT_DIR=/path/to/your/dbt-project  # or just `cd` into it
bun run dev              # launches the TUI
```

On first run bk1 prompts for your Anthropic API key (stored at `~/.bk1/auth.json`, chmod 0600). Type `/help` once you're in to see all available skills.

To install a single compiled binary for system-wide use:

```sh
bun run build:all        # produces ~/.local/bin/bk1
```

## Modes

Switch with `Tab`:

- **PLAN** — Claude proposes; you approve every file write before it lands.
- **BUILD** — file writes are applied immediately; reads and tool calls still streamed.
- **AUTO** — fully autonomous within the per-project tool allowlist.

The mode persists across turns but resets to PLAN at launch.

## Skills

Each skill is a slash command that expands to an LLM instruction with a fixed contract. The most commonly used:

| Skill | Purpose |
|---|---|
| `/investigate` | Triage failed models from the most recent dbt run |
| `/explain <model>` | Full walkthrough — purpose, lineage, SQL, recent changes |
| `/docs <model>` | Generate or update YAML with descriptions + conservative tests |
| `/lint` | Mechanical scan + clickable HTML report |
| `/lint-deep` | Semantic checks, health score, fix recommendations |
| `/kimball <q>` | Dimensional-modeling consultant grounded in DWT 3rd ed. |
| `/pet` | The pet (see below) |
| `/usage` | Per-turn token + USD breakdown for the session |
| `/model` | Switch Claude model (↑↓ to pick) |
| `/clear` | Reset conversation |
| `/logout` | Clear stored API key |

See [`src/skills.ts`](src/skills.ts) for the full set.

## HTML lint reports

`/lint` writes a self-contained, dark-themed HTML report to:

```
<dbt_project>/.bk1/lint-report.html
```

Open it in any browser or VS Code's preview. Inline CSS, no assets, no JS — just a sortable view of the rule summary and per-violation details (severity, file, evidence, suggested fix). Re-running `/lint` overwrites it. Re-running `/lint-deep` checks for the file first and asks before running the (expensive) semantic pass again — saves tokens when you already have a recent baseline.

## Pet

bk1 keeps a tiny Tamagotchi-style pixel pet in the status footer. It blinks, tracks the mouse cursor, ages from egg → baby → adult, and has discrete moods (`happy`, `hungry`, `sleepy`, `sad`, `angry`, `wants_to_play`).

Interactions:

- `/pet` — show stats
- `/pet feed` / `/pet play` / `/pet sleep` / `/pet name <name>` — interact
- Click on the pet (when awake) to play with it
- **Scrolling the wheel auto-puts the pet to sleep** — this is the mechanic that releases xterm mouse capture so you can scroll the terminal, select text, and copy normally. Any keypress wakes the pet back up.

State persists at `~/.bk1/pet.json`.

## VS Code IDE context (optional)

In [`vscode-ext/`](vscode-ext/) is a companion VS Code extension that streams the currently active file path and selection to `~/.bk1/ide-context.json`. The bk1 TUI reads it at the start of each turn and injects it as a `<system-reminder>` block — same shape Claude Code uses for `<ide_opened_file>` / `<ide_selection>` — so the model knows what you were looking at.

Install (sideload):

```sh
cd vscode-ext
npm install
npm run build
code --install-extension .
```

Without the extension installed, bk1 just sends prompts unchanged.

## Architecture

```
src/
  app.tsx           Ink TUI — main loop, input, message rendering, footer
  agent.ts          Anthropic SDK loop, sub-agent throttle, 429 retry, prompt caching
  tools.ts          Tool definitions + executors exposed to the agent
  state.ts          SQLite per-project state, incremental sync, lint aggregation,
                    HTML report generation
  skills.ts         Slash-command expansions (LLM instructions, not code)
  system-prompt.ts  Static system prompt for the main agent
  pet.ts            Tamagotchi state machine + pixel-art sprites
  mouse.ts          xterm SGR mouse-tracking integration
  ide-context.ts    Reader for the VS Code extension's ~/.bk1/ide-context.json
  pricing.ts        Per-model USD estimation
  usage.ts          Per-turn token attribution + breakdown report
  auth.ts           Anthropic API key storage (~/.bk1/auth.json, chmod 0600)
  kimball.ts        SQLite + FTS5 wrapper around the Data Warehouse Toolkit index
  lineage.ts        Compiled-SQL lineage for /explain and downstream-impact analysis

lint/               Rust mechanical linter — emits violations.json
vscode-ext/         VS Code companion extension (IDE context bridge)
skills_data/        Pre-built knowledge bases (e.g. kimball.db)
scripts/install.sh  One-shot setup: build binary, deploy assets, bun install
tests/              bun:test suites
```

### Key design decisions

- **Prompt caching is the biggest cost lever.** The system prompt and the last tool definition are marked as cacheable on every request; do not break the `withToolCache` / `cachedSystem` pattern in [`src/agent.ts`](src/agent.ts).
- **Sub-agents are throttled to 2 concurrent** to stay under Anthropic's 30K input-tokens/minute limit. Don't raise this without confirming current account caps.
- **Lint is incremental.** [`incrementalSync`](src/state.ts) stats every SQL file but only reads/hashes changed ones. Models with prior violations stay in the queue until explicitly cleared. This is what keeps re-runs cheap on large projects.
- **`lint_run` is fused** — one call does `sync → batch queue → spawn binary → aggregate violations → write HTML`, eliminating ~4 LLM round-trips per `/lint`.
- **The pet's sleep state is also the "give the terminal back" mechanism.** While the pet is awake, mouse modes 1000/1003/1006 are on for eye-tracking; the moment the pet sleeps (manually or via wheel-scroll), those modes are released so native scroll + selection work.

## Tech stack

- **Runtime:** Bun (TypeScript first-class, no separate build step in dev)
- **UI:** React + [Ink](https://github.com/vadimdemedes/ink) (terminal rendering)
- **API:** [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) — main agent on `claude-sonnet-4-6`, sub-agents on `claude-haiku-4-5-20251001`
- **State:** [`bun:sqlite`](https://bun.sh/docs/api/sqlite) (per-project at `<dbt_project>/target/bk1_state.db`)
- **Lint:** Rust (Cargo) — source in [`lint/`](lint/), binary installed to `~/.bk1/bk1-lint`
- **Tests:** `bun test`

Prefer Bun APIs (`Bun.spawn`, `Bun.Glob`, `Bun.file`) over Node equivalents when both work.

## Development

```sh
bun test                 # ~80ms, runs all suites
bun run dev              # TUI against $DBT_PROJECT_DIR (or $CWD)
bun run build:lint       # rebuild Rust binary only
bun run build:all        # full single-binary build → ~/.local/bin/bk1
```

The TUI prints to stdout, so use `tee` or a separate terminal if you need to capture output while interacting.

See [`CLAUDE.md`](CLAUDE.md) for conventions when modifying bk1 itself (vs. dbt projects bk1 operates against).

## Compatibility

- macOS, Linux. Windows untested (Bun + Ink should both work; mouse tracking depends on the terminal).
- Tested terminals: iTerm2, Terminal.app, VS Code integrated, Ghostty, Kitty. tmux requires `set -g mouse on` for the pet's eye-tracking to fire.
- Mouse-tracking gracefully degrades in older terminals — clicks may be ignored but everything else works.

## License

TBD.
