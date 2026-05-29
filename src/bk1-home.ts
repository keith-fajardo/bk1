// Path helpers for bk1's two distinct on-disk locations.
//
//   BK1_HOME   — durable per-user state (auth.json, pet.json, usage.db,
//                ide-context.json). Always ~/.bk1 so it survives across bk1
//                versions and across install methods (standalone vs.
//                VS Code extension auto-download). Env-overridable for
//                testing / per-project sandboxing.
//
//   BK1_ASSETS_DIR — bundled binaries + databases shipped with each bk1
//                release (bk1-lint, kimball/kimball.db). Resolved
//                sibling-of-binary first so the VS Code extension's
//                per-version install (<globalStorage>/bk1/<version>/) works
//                without any env var coordination. Falls back to ~/.bk1
//                for the legacy install.sh layout, then to the repo for
//                `bun src/app.tsx` dev mode.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const BK1_HOME = process.env.BK1_HOME ?? join(homedir(), '.bk1');

export function bk1AssetsDir(): string {
  // When bk1 is run as the compiled binary, process.execPath is that binary,
  // so its siblings are the release-tarball assets (extension-managed install).
  const siblingDir = dirname(process.execPath);
  if (existsSync(join(siblingDir, 'bk1-lint'))) return siblingDir;
  // Standalone install layout (scripts/install.sh).
  if (existsSync(join(BK1_HOME, 'bk1-lint'))) return BK1_HOME;
  // Dev mode (`bun src/app.tsx`) — neither location has the binary; callers
  // surface their own "missing — run setup" messaging.
  return BK1_HOME;
}
