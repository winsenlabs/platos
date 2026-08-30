# Platos V1 — M0.5 Dependency Closure Contract

**WIN-250 · closure of the M0.5 audit** · repo `/Users/tejassuds/work/platos-oss` @ `89c12b8`

The M0.5 report (`docs/audits/M0.5-dependency-sbom.md`) is analysis. **This directory is the
closure**: real machine-readable SBOMs, a real advisory scan with receipts, licence and
multi-major dispositions, an update-automation policy, and a committed, non-vacuous check that
regenerates the SBOMs and fails the build on drift or on a new copyleft/commercial dependency in a
shipping runtime image.

Everything here derives from `pnpm-lock.yaml` **without installing** `node_modules`. The closure
walker (`scripts/lib/pnpm-closure.mjs`) parses the lockfile's `importers` / `snapshots` / `packages`
sections and walks each image's production closure exactly as the image is built.

---

## 1. Artifacts (committed) and their hashes

| artifact | what it is | sha256 |
|---|---|---|
| `platos-agent.cdx.json` | CycloneDX 1.5 SBOM — agent image production closure (**718 components / 657 names**) | `c7e201258465a659…` |
| `platos-webapp.cdx.json` | CycloneDX 1.5 SBOM — webapp image production closure (**1637 components / 1357 names**) | `1f844390d9262e7b…` |
| `closure-receipts.json` | machine-readable receipts: per-image file, sha256, counts, roots; input hashes | regenerated |
| `license-index.json` | frozen registry.npmjs.org licence snapshot for the 1897-component union closure | `e1cfaf45f18403ab…` |
| `license-overlay.json` | curated licence elections/corrections (dompurify→Apache-2.0, etc.) | `cabf35d68abfbf7a2…` |
| `license-policy.json` | machine-readable copyleft/commercial gate + dispositioned baseline | `2c47d8ec03aed511…` |
| `advisory/osv-report.json` | OSV vulnerability scan receipt for both closures (point-in-time) | timestamped receipt |

Hashes are recomputed and cross-checked by `pnpm audit:sbom:check`. The exact current values live in
`closure-receipts.json`; the truncations above are for the eye.

### Closure numbers vs the M0.5 report
The corrected walker computes **agent 718/657 and webapp 1637/1357**. The webapp reduction is
intentional: its production stage now installs only `--filter webapp...`, and two unused direct
dependencies were removed. Root release tooling, GPL `breakword`, the proprietary Fingerprint SDK,
and unused PostHog browser code no longer enter the runtime closure.

---

## 2. Licence resolution (M0.5 deliverable #3)

### 2.1 LICENSE (Apache-2.0) vs NOTICE (MIT) — RESOLVED → Apache-2.0

**Decision: Apache-2.0 governs. `NOTICE` has been corrected.** This is not a close legal call:

- `LICENSE` contains the full **Apache-2.0** text (its appendix reads `Copyright [2023] [Trigger.dev]
  … Apache License, Version 2.0`).
- Upstream **trigger.dev is itself Apache-2.0** — so the old NOTICE claim that upstream is "MIT" was
  simply factually wrong.
- Five `@platosdev/*` packages already declare `Apache-2.0`.

The prior `NOTICE` asserted MIT in two places; both are corrected to Apache-2.0, an explanatory note
records the fix, and licence elections are recorded (below). No human legal call is required to pick
the licence; the only remaining human item is cosmetic (§2.5).

### 2.2 Copyleft and unused commercial dependencies — REMOVED

The production image now installs only `--filter webapp...`; root release tooling no longer enters
the runner, so `@changesets/cli → tty-table → smartwrap → breakword@1.0.5` and its GPL-2.0
obligation are absent from the shipping closure. The unused `@kapaai/react-sdk` and `posthog-js`
dependencies were removed from the webapp and the lockfile. This removes the proprietary
Fingerprint SDK transitively. No licence waiver remains in `license-policy.json`.

### 2.3 The remaining no-licence packages — RECORDED

| package@version | registry state | disposition |
|---|---|---|
| `react-universal-interface@0.6.2` | no `license` field at all | `NOASSERTION`; transitive orphan → drops when its parent is removed |
| `fast-shallow-equal@1.0.0` | no `license` field at all | `NOASSERTION`; transitive orphan |
| `khroma@2.1.0` | no `license` field at all | `NOASSERTION`; transitive orphan |

"No published grant" is recorded honestly as `NOASSERTION` in the SBOMs rather than the fabricated
Apache-2.0/MIT the source inventory had claimed. None are copyleft/commercial, so none block the gate;
all are removable and tracked with the orphan-cleanup precondition (M0.5 §5.2).

### 2.4 Recorded elections and the per-package `MIT` residue

Elections (machine-readable in `license-overlay.json`, human-readable in `NOTICE`):
`dompurify` (MPL-2.0 OR Apache-2.0) → **Apache-2.0**; `json-schema` (AFL-2.1 OR BSD-3-Clause) →
**BSD-3-Clause**; `jsonify` "Public Domain" → **CC0-1.0**; `@electric-sql/{client,react}` non-SPDX
`"Apache-2"` → **Apache-2.0**.

**Human item (cosmetic, non-blocking):** several private/published packages still carry
`license: "MIT"` in their `package.json` — rename residue that contradicts the Apache-2.0 repo licence.
Recommendation: correct those fields to `Apache-2.0`. Owner: whoever owns the `@platos` rename
(M0.5 §6 item 15). This does not change the governing licence.

---

## 3. Multi-major reconciliation (M0.5 deliverable #4)

"Ships" = present in the resolved production closure (verified by the walker, not by reading ranges).

| package | agent image | webapp image | why multiple majors coexist | disposition |
|---|---|---|---|---|
| **express** | `5.2.1` | `4.20.0` **and** `5.2.1` | Undeclared in `apps/agent` (29 source files `import "express"`); resolved transitively via `@nestjs/platform-express@11` (→5) and `@modelcontextprotocol/sdk` (→5), while webapp keeps 4.20.0 via its own tree. `^11.0.0` on platform-express lets the Express major move with no manifest edit. | **DECLARE** `express` (+`multer`,`cors`) in `apps/agent/package.json` and pin the major; the `nestjs` renovate group governs them and its contract test asserts the Express major. The webapp 4→5 consolidation is a tracked major (dashboard-approval). Owner: agent. |
| **zod** | `3.25.76` **and** `4.4.3` | `3.25.76` **and** `3.23.8` | 14 manifests pin `3.25.76` exactly, yet `zod@4.4.3` arrives transitively in the agent and `3.23.8` (`packages/platools-js`) in the webapp — **three zod builds** behind a manifest that reads as uniformly pinned. | zod 3→4 is a **standing major** behind dashboard approval (already partially in the tree). Interim: the `ai-sdk` contract test asserts the `@ai-sdk/provider` peer resolves against a single zod major per image. Owner: agent/webapp. |
| **undici** | `6.27.0, 7.25.0, 7.28.0, 8.7.0` | `5.29.0, 7.25.0` | Declared `^7.25.0` in both apps but many majors arrive transitively; `undici@8` (the "1 major behind" target) is already resident in the agent, and the CVE-relevant `5.29.0` is in the webapp. | Consolidate via override once the advisory scan (§4) clears the specific `undici` CVEs. `undici@5.29.0` in webapp is the one to evict; tracked in the `security` renovate group. Owner: platform. |
| **cookie** | `0.4.2, 0.7.2` | `0.4.2, 0.6.0, 0.7.2` | Four resolutions; **`0.4.2` (2022) ships in BOTH images** via `@remix-run/server-runtime@2.1.0`, `engine.io@6.5.4/6.6.6` — below the `0.7.0` line that fixes **CVE-2024-47764**. The declared `cookie` dep is never imported; the exposure is entirely transitive and there is no `cookie` override despite overrides existing for js-yaml/qs/jws/etc. | **Add `pnpm.overrides['cookie'] = '>=0.7.2'`** and test the `@remix-run/server-runtime` session round-trip. Requires a relock → dispositioned (M0.5 §6 item 2) and routed through the `auth-crypto` renovate group. The advisory receipt (§4) confirms the CVE hits `0.4.2`+`0.6.0` only, `0.7.2` is clean. Owner: webapp/auth. |

Additional standing majors carried forward to the update policy (dashboard-approval, each needs a
migration issue): **NestJS 11→12**, **Prisma 6→7** (four locations incl. the `pnpx prisma@6.14.0`
literal in `Dockerfile.platos`; never resolve `prisma@latest` — npm `latest` is an 8.x RC),
**Sentry 8/9→10** (prerequisite for OTel 2.x — Sentry pins the OTel 1.30.1 line), **OTel core 1.x→2.x**
(blocked on Sentry), **React 18→19**.

---

## 4. Advisory / vulnerability scan (M0.5 deliverable #2)

`scripts/audit-advisory.mjs` scans **exactly the two production closures** against the live OSV
database (osv.dev `querybatch` + `vulns`), and retains `advisory/osv-report.json` as a timestamped,
lockfile-hash-stamped receipt. (Point-in-time by nature — OSV grows; the deterministic gate is §5.)
An `--offline --osv-dir <export>` path is provided for air-gapped CI.

All eight M0.5-named items are adjudicated in the receipt's `m05Adjudication` block:

| package | versions in closure | verdict | advisory |
|---|---|---|---|
| **cookie** | 0.4.2, 0.6.0, 0.7.2 | **VULNERABLE_VERSION_PRESENT** | GHSA-pxg6-pf52-xh8x / **CVE-2024-47764**, LOW, fixed 0.7.0 — hits **0.4.2 (agent+webapp)** and **0.6.0 (webapp)**; **0.7.2 correctly NOT flagged** |
| postcss | 6.0.23, 7.0.32, 7.0.39, 8.5.6 | vulnerable version present | GHSA line, webapp |
| tmp | 0.0.33 | vulnerable version present | webapp |
| semver | 5.7.1, 7.7.3 | vulnerable version present | both |
| undici | 5.29.0 … 8.7.0 | vulnerable version present | both — 5.29.0 is the eviction target |
| fast-xml-parser | 4.2.5, 4.4.1, 5.2.5 | vulnerable version present | **CVE-2026-25896 (CRITICAL)**, fixed 5.3.5, agent+webapp |
| ws | 8.11.0, 8.18.0, 8.18.3 | vulnerable version present | both |
| path-to-regexp | 0.1.10, 8.4.2 | vulnerable version present | both |

**Point-in-time totals (scan date 2026-08-29):** 291 active findings across the union closure —
5 CRITICAL, 111 HIGH, 149 MODERATE, 26 LOW. The CRITICALs are current, dated CVEs
(`@remix-run/node` path traversal `CVE-2025-61686`; `fast-xml-parser` `CVE-2026-25896`; `tar` DoS
`CVE-2026-59873`). These feed the `security` renovate group (immediate, cadence-bypassing). The large
count is expected: the webapp closure still carries the ~126 orphaned upstream-UI packages the M0.5
report flags for deletion — removing those (M0.5 §5.2 precondition) is the highest-leverage reduction.
M0 closes the missing-inventory and missing-routing defect; it does **not** claim these findings are
remediated. Each upgrade still requires the compatibility gates and owner review defined below.

---

## 5. Update governance (M0.5 deliverable #5)

`renovate.json` (root) validates against the official Renovate schema (`renovate-config-validator`:
"Config validated successfully"). It is:

- **Ecosystem-grouped**, one PR per group with cross-package invariants: `ai-sdk`, `chat-sdk`,
  `trigger`, `mcp`, `nestjs` (+express/multer/cors), `prisma`, `otel-sentry` (deliberately one group —
  Sentry pins the OTel 1.x line), `aws-sdk`, `store-clients` (Postgres/Redis/ClickHouse/MinIO/Upstash),
  `socketio` (+ws, patch-rebase note), `auth-crypto` (+cookie), `build-test`.
- **Lockfile-driven** (`rangeStrategy: update-lockfile` + weekly `lockFileMaintenance`) so an in-range
  resolution float — the `lodash.omit 4.5.0 → 4.18.0` case — surfaces as a reviewable PR.
- **Changelog-linked**, with packages whose changelog cannot be resolved (`agentcrumbs`, `@jsonhero/*`,
  …) routed to manual dashboard approval — that inability is itself the signal.
- **Cooldown-aligned** with the pnpm `minimumReleaseAge` in `pnpm-workspace.yaml`, raised to the
  audit-recommended **7-day floor** (3 days for the `trigger` fast-patch group, 14 for slow ecosystems),
  and **OSV-driven** security alerts (`osvVulnerabilityAlerts`) at 0-day age.
- **Major-gated**: every major waits behind explicit dashboard approval (NestJS/Prisma/Sentry/OTel/
  React/zod/Express), and `agentcrumbs` (brand-new single-maintainer sole root dep) is manual-only,
  soaked and pinned.

---

## 6. The deterministic, non-vacuous check (M0.5 deliverable #6)

`scripts/audit-sbom.mjs check` (`pnpm audit:sbom:check`):

1. **Regenerates** both CycloneDX SBOMs in memory from the current `pnpm-lock.yaml` and **byte-compares**
   them to the committed files — any drift (a relock that changes the closure without regenerating the
   SBOM) fails the build. Verified byte-identical across regenerations.
2. **Cross-checks** the committed SBOM hashes against `closure-receipts.json`.
3. **Runs the licence gate**: every component in a shipping runtime closure is classified; a copyleft
   (GPL/LGPL/AGPL/MPL/EPL/…) or commercial (`SEE LICENSE IN…`/`UNLICENSED`/proprietary) licence that is
   not in `license-policy.json`'s `dispositionedBaseline` **fails the build**.

**Non-vacuity is proven, not asserted** — `pnpm audit:sbom:nonvacuity`
(`scripts/verify-sbom-nonvacuity.mjs`, full transcript in `NON-VACUITY-PROOF.md`) injects a GPL canary
into a scratch copy of the agent closure and shows the gate FAILS; adds it to the baseline and shows it
PASSES; and independently injects a commercial/no-grant canary to show that classifier also FAILS.
All four assertions hold.

`pnpm test:sbom` runs the whole thing offline as a CI gate (8 tests, all green).

### Suggested CI wiring (not applied — release/CI is a reserved vocabulary term)
Add to `.github/workflows/ci.yml` after install:
```yaml
- run: pnpm audit:sbom:check   # SBOM drift + licence gate (offline, deterministic)
- run: pnpm test:sbom           # closure + non-vacuity proof
```
`audit:advisory` / `audit:licenses` are network steps — run them on a schedule (nightly), not on the
frozen-lockfile critical path.

---

## 7. M0.5 §6 "Unresolved" — disposition ledger

Every item from the M0.5 report's decision list, with its status here. **CLOSED** = resolved in this
change. **STAGED** = fix specified, requires a relock/manifest change out of scope for a no-install
audit. **DECISION** = genuinely needs a human (legal/founder/owner) call; recorded as an explicit
disposition, not a blocker.

| # | item | status | disposition |
|---|---|---|---|
| 1 | No advisory scan had been run | **CLOSED** | `audit:advisory` scans both closures against OSV; receipt retained; all 8 named items adjudicated (§4). |
| 2 | `cookie` override missing | **STAGED** | Add `overrides['cookie']='>=0.7.2'` + session round-trip test; relock required. Routed to `auth-crypto` group. Owner: webapp/auth. |
| 3 | `breakword` GPL-2.0 | **CLOSED** | Root release tooling is excluded from the filtered production install; no waiver remains. |
| 4 | LICENSE vs NOTICE | **CLOSED** | Apache-2.0 governs; `NOTICE` corrected (§2.1). |
| 5 | `@platos` npm scope ownership | **DECISION** | Founder must confirm/claim the scope or treat squatting as live risk. Cannot be resolved from the repo. |
| 6 | inherited ClickHouse parser/replication cluster | **CLOSED** | WIN-253 removed the unreachable npm packages and parser patch after executable multi-channel proof. `internal-packages/clickhouse/schema/` remains shipping content and is hash-protected by the cluster audit. |
| 7 | `@fingerprintjs/fingerprintjs-pro` commercial | **CLOSED** | Removed unused `@kapaai/react-sdk`; the proprietary transitive SDK is absent from the shipping closure. |
| 8 | Sentry unification | **DECISION** | Is the `@sentry__remix@9.46.0.patch` still needed on 10.x? Unblocks the OTel 2.x cluster. Grouped with OTel in renovate. Owner: observability. |
| 9 | `prisma` npm `latest` = 8.x RC | **CLOSED (policy)** | `prisma` group targets 7.10.0 explicitly, never `latest`; renovate note + recommended CI assertion that no Prisma spec resolves to a prerelease. Owner: data. |
| 10 | Docker reproducibility (`--frozen-lockfile`) | **DECISION** | `turbo prune` rewrites the lockfile; `agent/Dockerfile` mutates `pnpm-workspace.yaml`. Prereq for digest-based promotion. That term is reserved — its own ticket. Owner: platform. |
| 11 | inherited ClickHouse package Dockerfile | **CLOSED** | WIN-253 proved that no Docker/Compose/CI entrypoint referenced it and removed it. Shipping migration images continue to use `internal-packages/tenancy-database/Dockerfile.migrations`. |
| 12 | Second/third lockfiles (migration-image, references/*) | **NOTED** | migration-image is `ignorePaths`-excluded from renovate and flagged for folding into the root workspace. Owner: platform. |
| 13 | Python packages under no lock policy | **NOTED** | `packages/platools-py`, `packages/platos-client-py` are out of the pnpm/renovate scope; bring under an equivalent lock+cooldown or declare out of V1 scope. Owner: SDK. |
| 14 | Changelogs not read (semver arithmetic only) | **CLOSED (policy)** | Resolved per-ecosystem in the renovate group contract tests / migration issues (M0.5 §5.2 gate 5). |
| 15 | Root `workspaces` field + `.changeset` rename residue + `docs/package.json` | **DECISION** | Rename-residue cleanup, incl. per-package `license: MIT` (§2.5). Owner: `@platos` rename owner. |

---

## 8. What is explicitly NOT done here (and why)

- **No broad dependency upgrade.** The two unused direct dependencies with concrete shipping/licence
  impact were removed and the lockfile was regenerated. The remaining dependency changes stay grouped
  behind compatibility tests and owner review; this audit does not blindly chase registry `latest`.
- **No blanket orphan purge.** The larger orphan list is evidence for later cleanup, not authority to
  delete packages without proving runtime, build, and external-control-plane reachability first.
- **No release/CI file changes.** That term is reserved; CI wiring is recommended in §6, not applied.
- **No ledger/manifest/WIN-292 changes.**
