#!/usr/bin/env bash
#
# Copies bk1's bundled skill assets from the repo to the runtime location at
# ~/.bk1/. Called by scripts/install.sh and by `bun run build:all`.
#
# Pure copy — no toolchain dependencies (no bun, no cargo). The pre-built kimball.db
# is committed to the repo, so this script just moves it into place. The markdown
# sources in skills_data/kimball/knowledge_base/ stay in the repo as the DB's source
# of truth but are NOT deployed — the runtime only reads the SQLite DB.
#
# To regenerate the DB after editing the markdown sources, run `bun run build:kimball`
# (separate from install — that's a dev-time step).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="${HOME}/.bk1"
KIMBALL_SRC="$REPO_ROOT/skills_data/kimball"

info() { printf "    %s\n" "$*"; }

if [[ ! -f "$KIMBALL_SRC/kimball.db" ]]; then
  info "kimball: no built DB found at $KIMBALL_SRC/kimball.db — skipping (run \`bun run build:kimball\` first)"
  exit 0
fi

mkdir -p "$SKILL_DIR/kimball"
cp "$KIMBALL_SRC/kimball.db" "$SKILL_DIR/kimball/kimball.db"

# Clean up the markdown copy if a previous install deployed it. The runtime no longer
# reads it — keeping the stale copy around just confuses things.
if [[ -d "$SKILL_DIR/kimball/knowledge_base" ]]; then
  rm -rf "$SKILL_DIR/kimball/knowledge_base"
fi

info "kimball: indexed DB at $SKILL_DIR/kimball/kimball.db ($(stat -f%z "$SKILL_DIR/kimball/kimball.db" 2>/dev/null || stat -c%s "$SKILL_DIR/kimball/kimball.db") bytes)"
