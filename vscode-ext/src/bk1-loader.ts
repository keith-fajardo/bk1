// Auto-downloader for the bk1 binary + sidecars.
//
// Strategy: each released extension version targets a specific bk1 release (BK1_VERSION).
// On activation, the loader looks for a complete install at
//
//   <globalStorage>/bk1/<version>/{bk1, bk1-lint, kimball/kimball.db}
//
// If missing, it fetches the platform-matched tarball from GitHub Releases
//   https://github.com/keith-fajardo/bk1/releases/download/v<version>/bk1-<version>-<platform>.tar.gz
// extracts it, chmods the binaries, and returns the absolute path to bk1.
//
// The extension just uses that path as the terminal's shellPath — bk1 itself
// resolves bk1-lint + kimball.db sibling-of-binary (see src/bk1-home.ts in the
// bk1 repo), so no env-var coordination is needed. User data (auth.json,
// pet.json, usage.db) lives at ~/.bk1 regardless, so it survives extension
// upgrades and version directory rotation.
//
// Older version directories are intentionally left in place — they're small in
// aggregate and let users roll back the extension without re-downloading.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';

// Bumped in lockstep with extension releases. Each value here must correspond
// to a published GitHub release tag `v<BK1_VERSION>` with the per-platform
// tarballs attached.
export const BK1_VERSION = '0.4.14';

const REPO = 'keith-fajardo/bk1';

interface PlatformTag {
  tag: string;       // identifier used in the release asset filename
  label: string;     // human-readable, for error messages
}

function detectPlatform(): PlatformTag {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin' && a === 'arm64') return { tag: 'darwin-arm64', label: 'macOS (Apple Silicon)' };
  if (p === 'darwin' && a === 'x64')   return { tag: 'darwin-x64',   label: 'macOS (Intel)' };
  if (p === 'linux'  && a === 'x64')   return { tag: 'linux-x64',    label: 'Linux x64' };
  throw new Error(
    `bk1 doesn't ship a prebuilt binary for ${p}/${a} yet. ` +
    `Supported: macOS (Apple Silicon), macOS (Intel), Linux x64. ` +
    `For other platforms, build from source: https://github.com/${REPO}`
  );
}

function installRoot(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, 'bk1', BK1_VERSION);
}

function isInstalled(root: string): boolean {
  return fs.existsSync(path.join(root, 'bk1'))
      && fs.existsSync(path.join(root, 'bk1-lint'))
      && fs.existsSync(path.join(root, 'kimball', 'kimball.db'));
}

// Follows GitHub's release-asset redirect to S3. Resolves to the final body
// stream so we can pipe straight into tar. Surfaces non-200 responses as
// errors with the status code — opaque network failures during first-run
// install are the most user-hostile thing this loader can do.
function fetchStream(url: string): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': `bk1-context-vscode/${BK1_VERSION}` },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchStream(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

async function downloadAndExtract(
  url: string,
  destDir: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  progress.report({ message: 'downloading…' });
  const body = await fetchStream(url);

  // Stream gunzip+untar straight off the network — avoids buffering ~80MB
  // in memory or writing a tarball to disk just to delete it.
  const tar = spawn('tar', ['-xzf', '-', '-C', destDir], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  tar.stderr.on('data', (c) => { stderr += c.toString(); });

  const tarDone = new Promise<void>((resolve, reject) => {
    tar.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr}`)));
    tar.on('error', reject);
  });

  await pipeline(body, tar.stdin);
  await tarDone;

  for (const name of ['bk1', 'bk1-lint']) {
    const p = path.join(destDir, name);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }
}

export async function ensureBk1(ctx: vscode.ExtensionContext): Promise<string> {
  // Honor an existing standalone install if the user explicitly opted into it
  // via env. Keeps the "I built from source" workflow intact for developers.
  const override = process.env.BK1_BINARY;
  if (override && fs.existsSync(override)) return override;

  const platform = detectPlatform();
  const root = installRoot(ctx);
  if (isInstalled(root)) return path.join(root, 'bk1');

  const asset = `bk1-${BK1_VERSION}-${platform.tag}.tar.gz`;
  const url   = `https://github.com/${REPO}/releases/download/v${BK1_VERSION}/${asset}`;

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Installing bk1 v${BK1_VERSION} for ${platform.label}`,
    cancellable: false,
  }, async (progress) => {
    await downloadAndExtract(url, root, progress);
  });

  if (!isInstalled(root)) {
    throw new Error(
      `bk1 tarball extracted but expected files are missing under ${root}. ` +
      `Asset: ${asset}. Try removing that directory and reopening bk1.`
    );
  }

  return path.join(root, 'bk1');
}
