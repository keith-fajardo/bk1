// Single source of truth for the bk1 product version, sourced from package.json
// so a release only has to bump one file. Bun bundles the JSON import into the
// compiled binary, so this resolves at startup without filesystem access.
//
// On each release: run `bun run bump <x.y.z>` (bumps this via package.json and
// BK1_VERSION in the extension loader, in lockstep), then commit and push to
// main. CI detects the new version, tags `v<x.y.z>`, and builds the release
// artifacts the extension's loader fetches by tag. package.json drives what
// users see in the bk1 banner and `/menu` Version row.

import pkg from '../package.json' with { type: 'json' };

export const BK1_VERSION: string = pkg.version;
