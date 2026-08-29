# `docs/audits/sbom/` — Platos dependency closure contract (WIN-250 / M0.5)

Machine-readable SBOMs, an advisory receipt, licence dispositions, and a deterministic,
non-vacuous gate — the executable closure of the `docs/audits/M0.5-dependency-sbom.md` report.
Everything is derived from `pnpm-lock.yaml` **without installing `node_modules`**.

Start with **`closure-contract.md`** — the narrative + full disposition ledger.

## Files

| file | kind | regenerate with |
|---|---|---|
| `closure-contract.md` | the contract: dispositions, multi-major, licence resolution, §6 ledger | — |
| `NON-VACUITY-PROOF.md` | proof the licence gate can fail | `pnpm audit:sbom:nonvacuity` |
| `platos-agent.cdx.json` | CycloneDX 1.5 SBOM — agent image (718 comps / 657 names) | `pnpm audit:sbom` |
| `platos-webapp.cdx.json` | CycloneDX 1.5 SBOM — webapp image (1637 comps / 1357 names) | `pnpm audit:sbom` |
| `closure-receipts.json` | per-image file/hash/count receipts + input hashes | `pnpm audit:sbom` |
| `license-index.json` | frozen registry licence snapshot (union closure) | `pnpm audit:licenses` (network) |
| `license-overlay.json` | curated licence elections/corrections (hand-maintained) | — |
| `license-policy.json` | copyleft/commercial gate + dispositioned baseline (hand-maintained) | — |
| `advisory/osv-report.json` | OSV vuln scan receipt for both closures (point-in-time) | `pnpm audit:advisory` (network) |

## Commands

```bash
pnpm audit:sbom            # regenerate both CycloneDX SBOMs + receipts (offline, deterministic)
pnpm audit:sbom:check      # FAIL on SBOM drift or an un-dispositioned copyleft/commercial dep (offline)
pnpm audit:sbom:nonvacuity # prove the licence gate can actually fail (offline)
pnpm test:sbom             # node --test: closure counts + drift + non-vacuity (offline, CI gate)

pnpm audit:advisory        # OSV scan of both closures -> advisory/osv-report.json (network)
pnpm audit:licenses        # refresh the frozen licence index from the registry (network, after a relock)
```

## How the closure is defined

`scripts/lib/pnpm-closure.mjs` walks each image's **production** closure
(`dependencies` + `optionalDependencies`, never `devDependencies`) as the image is actually built:

- **agent** — seeds from `apps/agent` only (`pnpm --filter platos-agent deploy --prod`); root deps do
  NOT reach it.
- **webapp** — seeds from `apps/webapp` only. The image installs
  `--filter webapp...`, so root release tooling—including GPL `breakword`—does not ship.

Same lockfile bytes → same SBOM bytes (verified byte-identical across regenerations). The only network
steps are `audit:advisory` and `audit:licenses`; both write timestamped receipts and are never on the
deterministic `check` path.

## Determinism & non-vacuity in one line each

- **Deterministic:** components, versions, purls and integrity hashes are a pure function of
  `pnpm-lock.yaml`; licences come from the committed `license-index.json` + `license-overlay.json`, not
  a live query. `check` regenerates and byte-compares.
- **Non-vacuous:** `check` fails on any copyleft/commercial dep in a shipping closure not in
  `license-policy.json`; proven by injecting a GPL canary (see `NON-VACUITY-PROOF.md`).

## Updating a disposition

To accept a new copyleft/commercial dependency (rare — prefer removal), add a reasoned entry to
`license-policy.json` → `dispositionedBaseline` with `package`, `version`, `class`, `owner`, `reason`,
`remediation`. To record a dual-licence election, add to `license-overlay.json`. Then run
`pnpm audit:sbom` to refresh the SBOMs and receipts, and `pnpm audit:sbom:check` to confirm green.
