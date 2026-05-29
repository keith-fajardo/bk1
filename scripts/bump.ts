#!/usr/bin/env bun
// Programmatic version bumper. Keeps the bk1 app's version sources in lockstep
// so a release never drifts across files. Edits files only — review the diff,
// then commit and push to main. .github/workflows/release.yml detects the new
// version, creates the `v<version>` tag, builds the per-platform tarballs +
// GitHub Release, and pushes the refreshed homebrew formula. No hand-tagging.
//
//   bun run bump <version> [ext-version]
//       Bump the bk1 app to <version>: package.json `version` AND BK1_VERSION
//       in vscode-ext/src/bk1-loader.ts (these must already match — the script
//       refuses to proceed if they've drifted). Also advances the VS Code
//       extension's marketplace version, since a new BK1_VERSION only reaches
//       users through a newly published extension. The extension goes to
//       [ext-version] if given, otherwise a patch bump of its current value.
//
//   bun run bump ext <ext-version>
//       Bump ONLY vscode-ext/package.json — an extension-only change with no
//       bk1 rebuild (the extension version is independent of the bk1 trio).

const ROOT     = new URL('..', import.meta.url).pathname;
const PKG      = `${ROOT}package.json`;
const EXT_PKG  = `${ROOT}vscode-ext/package.json`;
const LOADER   = `${ROOT}vscode-ext/src/bk1-loader.ts`;

const SEMVER = /^\d+\.\d+\.\d+$/;

function die(msg: string): never {
  console.error(`bump: ${msg}`);
  process.exit(1);
}

// Returns positive if a > b, negative if a < b, 0 if equal.
function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

function patchBump(v: string): string {
  const [maj, min, pat] = v.split('.').map(Number);
  return `${maj}.${min}.${pat! + 1}`;
}

function jsonVersion(text: string): string {
  const m = text.match(/"version":\s*"([^"]+)"/);
  if (!m) die('no "version" field found');
  return m![1]!;
}
const setJsonVersion = (text: string, v: string) =>
  text.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`);

function loaderVersion(text: string): string {
  const m = text.match(/BK1_VERSION\s*=\s*'([^']+)'/);
  if (!m) die('BK1_VERSION not found in bk1-loader.ts');
  return m![1]!;
}
const setLoaderVersion = (text: string, v: string) =>
  text.replace(/(BK1_VERSION\s*=\s*')[^']+(')/, `$1${v}$2`);

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`Usage:
  bun run bump <version> [ext-version]   bump the bk1 app (+ extension)
  bun run bump ext <ext-version>         bump only the VS Code extension`);
  process.exit(args.length === 0 ? 1 : 0);
}

// ── Extension-only bump ──────────────────────────────────────────────────────
if (args[0] === 'ext') {
  const next = args[1];
  if (!next || !SEMVER.test(next)) die('expected `bump ext <x.y.z>`');
  const extText = await Bun.file(EXT_PKG).text();
  const cur = jsonVersion(extText);
  if (cmp(next, cur) <= 0) die(`extension ${next} is not greater than current ${cur}`);
  await Bun.write(EXT_PKG, setJsonVersion(extText, next));
  console.log(`extension: ${cur} → ${next}  (vscode-ext/package.json)`);
  console.log('\nNext: rebuild + publish the extension (vsce). bk1 app version unchanged.');
  process.exit(0);
}

// ── bk1 app bump (+ coupled extension bump) ──────────────────────────────────
const next   = args[0]!;
const extArg = args[1];
if (!SEMVER.test(next)) die(`"${next}" is not a valid x.y.z version`);
if (extArg && !SEMVER.test(extArg)) die(`"${extArg}" is not a valid x.y.z ext-version`);

const pkgText    = await Bun.file(PKG).text();
const loaderText = await Bun.file(LOADER).text();
const extText    = await Bun.file(EXT_PKG).text();

const pkgCur    = jsonVersion(pkgText);
const loaderCur = loaderVersion(loaderText);
const extCur    = jsonVersion(extText);

// Drift guard: the bk1 trio must be coherent before we move it forward, or a
// bump would paper over an existing mismatch (the exact failure mode the
// lockstep rule exists to prevent).
if (pkgCur !== loaderCur) {
  die(`drift detected — package.json (${pkgCur}) and BK1_VERSION (${loaderCur}) disagree. Reconcile them first.`);
}
if (cmp(next, pkgCur) <= 0) die(`bk1 ${next} is not greater than current ${pkgCur}`);

const extNext = extArg ?? patchBump(extCur);
if (cmp(extNext, extCur) <= 0) die(`extension ${extNext} is not greater than current ${extCur}`);

await Bun.write(PKG, setJsonVersion(pkgText, next));
await Bun.write(LOADER, setLoaderVersion(loaderText, next));
await Bun.write(EXT_PKG, setJsonVersion(extText, extNext));

console.log(`bk1 app:   ${pkgCur} → ${next}  (package.json + bk1-loader BK1_VERSION)`);
console.log(`extension: ${extCur} → ${extNext}  (vscode-ext/package.json)`);
console.log(`\nNext, after reviewing the diff:`);
console.log(`  git commit -am "release v${next}"`);
console.log(`  git push                              # CI tags v${next}, builds + releases`);
