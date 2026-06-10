#!/usr/bin/env bash
#
# Builds the bk1-colibri sidecar: dbt-colibri frozen into a single self-contained
# binary via PyInstaller, so end users get column-level lineage with NO Python
# toolchain. Mirrors sidecars/lint (Rust → bk1-lint). Output: dist/bk1-colibri.
#
# PyInstaller cannot cross-compile — the binary targets the host arch only. CI
# therefore builds it on native-arch legs (darwin-arm64, linux-x64) and skips the
# cross-compiled darwin-x64 leg; that platform falls back to bk1's built-in tracer.
#
# Usage:  bash sidecars/colibri/build.sh      (PYTHON=python3.11 to pick an interpreter)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "error: $PY not found (set PYTHON=...)" >&2; exit 1; }

VENV="$HERE/.venv"
"$PY" -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"

python -m pip install --upgrade pip wheel >/dev/null
python -m pip install -r requirements.txt pyinstaller

# sqlglot[c] is sqlglot compiled via mypyc — the accelerator ships as `.so` submodules
# INSIDE the sqlglot package (not a separate importable module), so --collect-all sqlglot
# bundles the compiled binaries along with the pure-Python fallback.
rm -rf build dist
pyinstaller --onefile --name bk1-colibri --clean --noconfirm \
  --collect-all dbt_colibri \
  --collect-all sqlglot \
  entry.py

BIN="$HERE/dist/bk1-colibri"
[[ -x "$BIN" ]] || { echo "error: PyInstaller did not produce $BIN" >&2; exit 1; }
"$BIN" --help >/dev/null && echo "built + smoke-tested: $BIN"
