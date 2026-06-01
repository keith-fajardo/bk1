# bk1 — dbt coding agent

Run **bk1**, a terminal-native coding agent for **dbt Core** projects, right inside VS Code — and give it live awareness of the file you're looking at.

bk1 pairs a **deterministic Rust linter** (it mechanically checks your project against Kimball-flavored dbt conventions before spending a single LLM token) with a dbt-aware agent that investigates failed runs, explains and documents models, and answers dimensional-modeling questions grounded in *The Data Warehouse Toolkit*. This extension is the VS Code companion: it launches bk1 as an editor tab and streams your editor context to it.

## What this extension does

- **Opens bk1 as an editor tab** — click **Open bk1** (in the bk1 activity-bar view, the editor title bar, or the `bk1: Open bk1` command). It opens in a split beside your code, Claude Code–style.
- **Auto-installs bk1 on first use** — no manual setup. On first launch it downloads the platform-matched bk1 binary + sidecars from GitHub Releases into the extension's storage. No Bun or Rust toolchain required.
- **Streams IDE context to the agent** — the active file path and current selection are written to `~/.bk1/ide-context.json` (debounced). bk1 reads it at the start of each turn and injects it as context, so the agent knows what you're looking at without you pasting it.
- **Status & Activity Log views** — a sidebar panel shows the current file, language, selection range, and a recent log of file-open / selection / file-close events the agent is seeing.

## Requirements

- An **Anthropic API key** — bk1 prompts for it on first run and stores it at `~/.bk1/auth.json` (chmod 0600). bk1 is bring-your-own-key; it uses the Anthropic API directly with no cloud account.
- A **dbt Core project** — open a folder containing `dbt_project.yml` and bk1 launches against it.
- **Platform:** prebuilt binaries ship for **macOS (Apple Silicon)**, **macOS (Intel)**, and **Linux x64**. On other platforms, build bk1 from source ([instructions](https://github.com/keith-fajardo/bk1)).

## Getting started

1. Install this extension.
2. Open a dbt project folder in VS Code.
3. Click the **bk1** icon in the activity bar, then **Open bk1** (first launch downloads the binary).
4. Enter your Anthropic API key when prompted.
5. Type `/help` inside bk1 to see all skills (`/investigate`, `/explain`, `/docs`, `/lint`, `/lint-deep`, `/kimball`, and more).

## Keyboard shortcuts

These only apply while the bk1 terminal tab is focused — they leave every other terminal and editor untouched:

- `Ctrl+T` — toggle bk1's terminal/agent input mode
- `Ctrl+L` — clear bk1's screen

## Notes

- **User data lives at `~/.bk1`** (API key, usage history, pet state) — separate from the downloaded binary, so it survives extension upgrades.
- The extension and the standalone CLI share that `~/.bk1` directory, so authentication carries over if you also run bk1 directly in your terminal.
- Set the `BK1_BINARY` environment variable to an absolute path to use your own locally built bk1 instead of the auto-downloaded release (handy when developing bk1 itself).

## Learn more

bk1 is open source. Full documentation, the CLI, the Rust linter, and the bundled Kimball knowledge base all live in one repo: **https://github.com/keith-fajardo/bk1**

bk1 is built by [Mangrove](https://mangrovedigital.com.au/). The name is short for *bakawan* — Filipino for *mangrove*.
