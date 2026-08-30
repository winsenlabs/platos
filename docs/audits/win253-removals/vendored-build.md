# WIN-253 vendored build/SDK retirement

## Result

The assembled tree removes exactly six inherited Trigger workspaces from integration base `34c41bc10bd23c90271e83592148fab3bf26aa38`:

- `packages/trigger-sdk` (`@platos/sdk`)
- `internal-packages/sdk-compat-tests` (`@internal/sdk-compat-tests`)
- `packages/build` (`@platos/build`)
- `packages/python` (`@platos/python`)
- `packages/rsc` (`@platos/rsc`)
- `packages/schema-to-json` (`@platos/schema-to-json`)

The executable receipt derives 122 deleted files and 626057 bytes from Git. The restore argv in `docs/audits/win253-removals/vendored-build.json` restores every deleted blob from the integration base and is exercised byte-for-byte by `scripts/vendored-build-audit.test.mjs`.

## Reviewed-source provenance

Git derives 120 reviewed deletions from `fcf39fa227cb9265b7e532f14ef181a3b65ff061..e720b7618e58b27d3ff4f9aff5a5ca9ac6670130`; all 120 are represented in the current integration-base deletion set. The only primary-base path additions are `packages/rsc/LICENSE` and `packages/schema-to-json/LICENSE`, each explicitly explained in the JSON receipt.

## Consumer and tombstone proof

All manifest, import, dynamic-load, filesystem-load, TypeScript-reference, script, CI, Docker, test-config, and active-doc channels are empty. The only surviving retired package-name references are the two explicit production negative guards recorded in the JSON receipt. Tombstone checks inspect tracked, untracked, ignored, and empty retired roots.

Durable runtime examples map `task`, `tasks`, `runs`, `schedules`, and `wait` to `@trigger.dev/sdk`. `PlatosClient` and the Platos REST/WebSocket surface map to `@platosdev/client`; the audit rejects either boundary when routed through the other package.

## Protected Platos SDKs

| Tree | Integration-base tree | Files | Byte-identical |
| --- | --- | ---: | --- |
| `packages/platools-js` | `7d34644e66e4ec98a1158539db78df1f7c2ee4be` | 41 | yes |
| `packages/platos-client` | `82e0fbb9b2d32e8168a731856034695a2f0235e5` | 21 | yes |
| `packages/platos-embed` | `d19dd2ef79dd240e3a48321f90d5647824fe793c` | 6 | yes |
| `packages/platos-react-widget` | `18bf2d9326a82789154f1eec407848539816dad0` | 12 | yes |
| `packages/platos-token-mint` | `0fcd94ddd1c45d4dfda4563389f3a43c1a5291fc` | 6 | yes |
| `packages/platools-py` | `fdb5617a39bdc95c0f6b2ef7b0060d98cb96748a` | 46 | yes |
| `packages/platos-client-py` | `88b67ab00e4073390951b8b59d645782784ac599` | 13 | yes |

## Shared artifacts

The current lockfile, changesets, vocabulary exceptions, V1 ledger fingerprint, workspace reachability report, SBOM/licence receipts, root manifest, docs, and ignore files are regenerated or checked on the assembled tree. The obsolete `packages.pin.browser-entry` ledger rule is absent.

## Rollback

Execute the exact `restore.argv` array from `docs/audits/win253-removals/vendored-build.json` without shell interpolation. It restores only the 122 Git-derived deletion paths from `34c41bc10bd23c90271e83592148fab3bf26aa38`.
