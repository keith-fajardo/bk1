// Single source of truth for the bk1 product version, sourced from package.json
// so a release only has to bump one file. Bun bundles the JSON import into the
// compiled binary, so this resolves at startup without filesystem access.
//
// On each release: bump `version` in package.json AND tag the commit with the
// matching `v<x.y.z>`. The git tag drives the GitHub release artifacts that
// the VS Code extension's loader fetches; package.json drives what users see
// in the bk1 banner and `/menu` Version row.

import pkg from '../package.json' with { type: 'json' };

export const BK1_VERSION: string = pkg.version;
