# `docs/audits/sbom/` — Platos dependency closure contract (WIN-250 / M0.5)

Machine-readable SBOMs, an advisory receipt, licence dispositions, and a deterministic,
non-vacuous gate — the executable closure of the `docs/audits/M0.5-dependency-sbom.md` report.
The agent SBOM is derived from `pnpm-lock.yaml`; the webapp SBOM is grounded in the committed,
deterministically sorted package inventory captured from its exact Docker `production-deps` stage.

Start with **`closure-contract.md`** — the narrative + full disposition ledger.

## Files

| file | kind | regenerate with |
|---|---|---|
| `closure-contract.md` | the contract: dispositions, multi-major, licence resolution, §6 ledger | — |
| `NON-VACUITY-PROOF.md` | proof the licence gate can fail | `pnpm audit:sbom:nonvacuity` |
| `platos-agent.cdx.json` | CycloneDX 1.5 SBOM — agent image (718 comps / 657 names) | `pnpm audit:sbom` |
| `platos-webapp.cdx.json` | CycloneDX 1.5 SBOM — exact webapp image inventory (330 comps / 303 names) | `pnpm audit:sbom` |
| `platos-webapp.image-inventory.json` | exact name/version pairs installed in the Docker `production-deps` stage | `scripts/image-package-inventory.mjs` against the built stage |
| `closure-receipts.json` | per-image SBOM/inventory hashes, exact counts, roots, and input hashes | `pnpm audit:sbom` |
| `license-index.json` | frozen registry licence snapshot (883-component lock closure plus two linked first-party workspaces) | `pnpm audit:licenses` (network) |
| `license-overlay.json` | curated licence elections/corrections (hand-maintained) | — |
| `license-policy.json` | copyleft/commercial gate + dispositioned baseline (hand-maintained) | — |
| `advisory/osv-report.json` | OSV receipt for the agent lock closure plus exact verified webapp image inventory | `pnpm audit:advisory` (network) |

## Commands

```bash
pnpm audit:sbom            # regenerate both CycloneDX SBOMs + receipts (offline, deterministic)
pnpm audit:sbom:check      # FAIL on SBOM drift or an un-dispositioned copyleft/commercial dep (offline)
pnpm audit:sbom:nonvacuity # prove the licence gate can actually fail (offline)
pnpm test:sbom             # node --test: closure counts + drift + non-vacuity (offline, CI gate)
pnpm audit:webapp-image-inventory # gate-only: verify production-deps + exact downloaded candidate archive

pnpm audit:advisory        # OSV scan of both closures -> advisory/osv-report.json (network)
pnpm audit:advisory:check  # fail if lock/inventory bytes, hash, platform, counts, scan set, or finding membership drift
pnpm audit:licenses        # refresh the frozen licence index from the registry (network, after a relock)
```

Capture the webapp inventory after an exact `linux/amd64` `production-deps` build, then regenerate
the SBOM. The `build-images.yml` gate invokes `pnpm audit:webapp-image-inventory` with the downloaded
webapp candidate archive: it builds only `production-deps`, imports the already-built immutable final
candidate, requires revision/build-input labels, byte-compares both inventories, and retains evidence
under the candidate manifest digest with the source run ID and attempt. The gate then starts that
archive-derived verified final image. Publication executes
`scripts/verify-webapp-publication-provenance.mjs` before registry authentication; fixture and semantic
mutation tests cover every candidate, archive, platform, revision, input, inventory, image, and source-run
binding enforced by that validator.

```bash
docker run --rm \
  -v "$PWD/scripts/image-package-inventory.mjs:/audit/image-package-inventory.mjs:ro" \
  --entrypoint node <production-deps-image> \
  /audit/image-package-inventory.mjs /platos/node_modules/.pnpm \
  --importer-node-modules /platos/apps/webapp/node_modules --root /platos \
  > docs/audits/sbom/platos-webapp.image-inventory.json
pnpm audit:sbom
```

## How the closure is defined

`scripts/lib/pnpm-closure.mjs` walks each image's **production** closure
(`dependencies` + `optionalDependencies`, never `devDependencies`) as the image is actually built:

- **agent** — seeds from `apps/agent` only (`pnpm --filter platos-agent deploy --prod`); root deps do
  NOT reach it.
- **webapp** — the lock walker seeds from `apps/webapp`, while the shipping SBOM uses the exact
  `linux/amd64` image inventory. Before the frozen filtered install, Docker removes root dependency sections
  from both the production manifest and root lock importer and retains only webapp-reachable patches;
  root release tooling—including GPL `breakword`—therefore does not ship.

Reverse reconciliation is exact. External lock snapshots minus installed image inventory must be
precisely the seven reviewed non-`linux/amd64` `@sentry/cli-*` optionals, while the linked workspace
set must exactly match importer links and local manifests. The inventory must include
`@internal/workload-identity@0.0.1` and `@platos/tenancy-database@0.0.1`; any additional image-only or
lock-only package, or a missing linked workspace, fails the audit.

Same lockfile + inventory bytes → same SBOM bytes (verified byte-identical across regenerations). The only network
steps are `audit:advisory` and `audit:licenses`; both write timestamped receipts. Advisory refreshes
use bounded OSV requests and a content-addressed cache, and record any cache fallback. The offline
`audit:advisory:check` command validates the committed receipt against current exact inputs.

## Determinism & non-vacuity in one line each

- **Deterministic:** agent components come from `pnpm-lock.yaml`; webapp components come from the
  sorted, committed exact-image inventory and are reconciled in both directions against its
  production lock closure. Licences come from committed data, not a live query. `check` regenerates
  and byte-compares; CI independently rebuilds and verifies both Docker stages.
- **Non-vacuous:** `check` fails on any copyleft/commercial dep in a shipping closure not in
  `license-policy.json`; proven by injecting a GPL canary (see `NON-VACUITY-PROOF.md`).

## Updating a disposition

To accept a new copyleft/commercial dependency (rare — prefer removal), add a reasoned entry to
`license-policy.json` → `dispositionedBaseline` with `package`, `version`, `class`, `owner`, `reason`,
`remediation`. To record a dual-licence election, add to `license-overlay.json`. Then run
`pnpm audit:sbom` to refresh the SBOMs and receipts, and `pnpm audit:sbom:check` to confirm green.
