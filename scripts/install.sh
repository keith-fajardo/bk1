#!/usr/bin/env bash
#
# bk1 installer — builds the native sidecar binaries (Rust lint, Go playroom),
# installs them into the bk1 skill directory, and installs the Bun dependencies.
#
# Usage:  bash scripts/install.sh
#         bun run setup
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="${HOME}/.bk1"
BINARY_DEST="${SKILL_DIR}/bk1-lint"
PLAYROOM_DEST="${SKILL_DIR}/bk1-playroom"

step()  { printf "\n\033[1;36m==>\033[0m %s\n" "$*"; }
info()  { printf "    %s\n" "$*"; }
fail()  { printf "\n\033[1;31mError:\033[0m %s\n" "$*" >&2; exit 1; }

# ── Prereq checks ────────────────────────────────────────────────────────────
# bun is required for `bun install` (JS deps) and for the dev-time `build:kimball` rebuild.
# Kimball asset deployment itself doesn't need bun anymore — the DB is committed to the repo.
# cargo and go are soft-required: skip the corresponding native build if the toolchain
# is missing AND the matching binary already exists at its destination. Lets asset-only
# updates ship without forcing every contributor to install every toolchain.
step "Checking prerequisites"

# bun is sometimes installed in ~/.bun/bin and missing from a subshell's PATH. Probe common
# install locations and prepend whichever one we find before failing.
if ! command -v bun >/dev/null 2>&1; then
  for candidate in "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun" "/usr/local/bin/bun"; do
    if [[ -x "$candidate" ]]; then
      PATH="$(dirname "$candidate"):$PATH"
      export PATH
      break
    fi
  done
fi
command -v bun >/dev/null 2>&1 || fail "bun is required — install from https://bun.sh"
info "bun:   $(bun --version)"

HAVE_CARGO=0
if command -v cargo >/dev/null 2>&1; then
  HAVE_CARGO=1
  info "cargo: $(cargo --version | awk '{print $2}')"
else
  # Migration path: bk1 used to install assets to ~/.claude/skills/dbt/. If the user
  # is running this after the rename to ~/.bk1/ and doesn't have cargo, salvage their
  # previously-built binary from the old location before failing.
  LEGACY_BINARY="${HOME}/.claude/skills/dbt/bk1-lint"
  if [[ ! -x "$BINARY_DEST" && -x "$LEGACY_BINARY" ]]; then
    mkdir -p "$SKILL_DIR"
    cp "$LEGACY_BINARY" "$BINARY_DEST"
    chmod +x "$BINARY_DEST"
    info "cargo: not installed — migrated existing bk1-lint from $LEGACY_BINARY"
  elif [[ -x "$BINARY_DEST" ]]; then
    info "cargo: not installed — using existing $BINARY_DEST (install Rust from https://rustup.rs to rebuild)"
  else
    fail "cargo is required (no existing $BINARY_DEST to fall back to) — install from https://rustup.rs"
  fi
fi

HAVE_GO=0
if command -v go >/dev/null 2>&1; then
  HAVE_GO=1
  info "go:    $(go version | awk '{print $3}')"
elif [[ -x "$PLAYROOM_DEST" ]]; then
  info "go:    not installed — using existing $PLAYROOM_DEST (install Go from https://go.dev/dl/ to rebuild)"
else
  fail "go is required (no existing $PLAYROOM_DEST to fall back to) — install from https://go.dev/dl/"
fi

# ── Build Rust binary (only if cargo is available) ───────────────────────────
if [[ $HAVE_CARGO -eq 1 ]]; then
  step "Building bk1-lint (release)"
  cd "$REPO_ROOT/sidecars/lint"
  cargo build --release --quiet
  [[ -f target/release/bk1-lint ]] || fail "cargo build did not produce target/release/bk1-lint"

  step "Installing binary to $BINARY_DEST"
  mkdir -p "$SKILL_DIR/data"
  cp target/release/bk1-lint "$BINARY_DEST"
  chmod +x "$BINARY_DEST"
  info "$($BINARY_DEST --help 2>&1 | head -1 || echo installed)"
else
  step "Skipping bk1-lint build (cargo unavailable)"
  mkdir -p "$SKILL_DIR/data"
  info "using existing $BINARY_DEST"
fi

# ── Build Go playroom sidecar (only if go is available) ──────────────────────
if [[ $HAVE_GO -eq 1 ]]; then
  step "Building bk1-playroom"
  cd "$REPO_ROOT/sidecars/playroom"
  go build -o "$PLAYROOM_DEST" .
  [[ -x "$PLAYROOM_DEST" ]] || fail "go build did not produce $PLAYROOM_DEST"
  info "installed to $PLAYROOM_DEST"
else
  step "Skipping bk1-playroom build (go unavailable)"
  info "using existing $PLAYROOM_DEST"
fi

# ── Install bundled skill assets (kimball DB + knowledge base) ───────────────
step "Installing bundled skill assets to $SKILL_DIR"
bash "$SCRIPT_DIR/deploy_assets.sh"

# ── Install Bun dependencies ─────────────────────────────────────────────────
step "Installing JS dependencies"
cd "$REPO_ROOT"
bun install --silent

step "Done"
info "Start the TUI:  bun src/app.tsx"
info "Run tests:       bun test"
