# Platos V1 — M0.5 Dependency Closure Contract

**WIN-250 · closure of the M0.5 audit** · repo `/Users/tejassuds/work/platos-oss` @ `89c12b8`

The M0.5 report (`docs/audits/M0.5-dependency-sbom.md`) is analysis. **This directory is the
closure**: real machine-readable SBOMs, a real advisory scan with receipts, licence and
multi-major dispositions, an update-automation policy, and a committed, non-vacuous check that
regenerates the SBOMs and fails the build on drift or on a new copyleft/commercial dependency in a
shipping runtime image.

The agent inventory derives from `pnpm-lock.yaml` without installing `node_modules`. The webapp
inventory is captured from the exact Docker `production-deps` stage and committed as a sorted list of
installed name/version pairs, including linked first-party workspace manifests; the closure walker
reconciles external snapshots and importer-linked workspaces separately.

---

## 1. Artifacts (committed) and their hashes

| artifact | what it is | sha256 |
|---|---|---|
| `platos-agent.cdx.json` | CycloneDX 1.5 SBOM — agent image production closure (**718 components / 657 names**) | `bb31518f442fa32a…` |
| `platos-webapp.cdx.json` | CycloneDX 1.5 SBOM — exact webapp Docker image inventory (**330 components / 303 names**) | `89c8d9d5d6948ea3…` |
| `platos-webapp.image-inventory.json` | exact `linux/amd64` external and linked-workspace packages installed in the webapp Docker `production-deps` stage | `9b745000948ff883…` |
| `closure-receipts.json` | machine-readable receipts: per-image SBOM/inventory sha256, counts, roots; input hashes | regenerated |
| `license-index.json` | frozen registry.npmjs.org licence snapshot for the 881-component lock closure plus two linked first-party workspaces | `db522b9f17757a1c…` |
| `license-overlay.json` | curated licence elections/corrections, first-party Apache-2.0 dispositions, and absent-image GPL canary | `db436a3bfad82b7…` |
| `license-policy.json` | machine-readable copyleft/commercial gate + dispositioned baseline | `2c47d8ec03aed511…` |
| `advisory/osv-report.json` | OSV receipt for agent lock closure plus exact webapp image inventory | `1de28eb2d07c22fb…` |

Hashes are recomputed and cross-checked by `pnpm audit:sbom:check`. The exact current values live in
`closure-receipts.json`; the truncations above are for the eye.

### Closure numbers vs the M0.5 report
The corrected walker computes **agent 718/657** and a webapp production lock closure of **335/308**.
The exact Linux webapp image contains **330 components / 303 names**: 328 external package pairs plus
the linked `@internal/workload-identity@0.0.1` and `@platos/tenancy-database@0.0.1` manifests. The seven
external lock-only packages remain the reviewed non-`linux/amd64` `@sentry/cli-*` optionals. This
produces an **876-component / 745-name image-grounded union**. Reverse reconciliation requires the
exact seven platform exclusions and exact two-workspace importer set; any other mismatch fails.
The webapp reduction is intentional: its production stage strips the root manifest and lock importer
dependency sections before frozen `--filter webapp...` installation, and its direct production
manifest is derived from parsed runtime/configuration/operational reachability.
Root release tooling, GPL `breakword`, the proprietary Fingerprint SDK, unused PostHog browser code,
and the removed legacy UI/AI dependency graph no longer enter the runtime closure.

---

## 2. Licence resolution (M0.5 deliverable #3)

### 2.1 Root Apache-2.0 and package-level MIT provenance — HUMAN/LEGAL DECISION RESOLVED

The root Apache-2.0 and package-level MIT facts remain distinct. The canonical offline evidence is
[`licence-resolution.json`](./licence-resolution.json), with a concise human summary in
[`licence-resolution.md`](./licence-resolution.md). It records commit-pinned upstream objects, the
vendored npm artifact, the 250/258 import comparison, the no-merge-base/physical-checkout limitation,
and current protected package states. The tag mapping is an externally reviewed point-in-time fact,
not an offline-verified live ref assertion. This contract makes no legal determination; retention of
the imported core MIT permission notice remains an open human/legal gate.

### 2.2 Copyleft and unused commercial dependencies — REMOVED

The production image now removes root dependency sections from both its manifest and lock importer
before the frozen filtered install; root release tooling no longer enters the runner, so
`@changesets/cli → tty-table → smartwrap → breakword@1.0.5` and its GPL-2.0
obligation are absent from the shipping closure. The unused `@kapaai/react-sdk` and `posthog-js`
dependencies were removed from the webapp and the lockfile. This removes the proprietary
Fingerprint SDK transitively. No licence waiver remains in `license-policy.json`.

### 2.3 Linked first-party packages without registry records — RECORDED

| package@version | registry state | disposition |
|---|---|---|
| `@internal/workload-identity@0.0.1` | private linked workspace; not published to npm | Apache-2.0 under the repository `LICENSE`; explicit overlay disposition |
| `@platos/tenancy-database@0.0.1` | private linked workspace; not published to npm | Apache-2.0 under the repository `LICENSE`; explicit overlay disposition |

The frozen registry index records both npm lookups as not found. The curated overlay ties these
first-party manifests to the repository's Apache-2.0 grant rather than pretending registry metadata
exists.

### 2.4 Recorded elections and inherited package-level MIT metadata

Elections (machine-readable in `license-overlay.json`, human-readable in `NOTICE`):
`dompurify` (MPL-2.0 OR Apache-2.0) → **Apache-2.0**; `json-schema` (AFL-2.1 OR BSD-3-Clause) →
**BSD-3-Clause**; `jsonify` "Public Domain" → **CC0-1.0**; `@electric-sql/{client,react}` non-SPDX
`"Apache-2"` → **Apache-2.0**.

`internal-packages/otlp-importer` remains private `@platos/otlp-importer@3.0.0` with its inherited
`license: "MIT"` manifest field and exact inherited MIT `LICENSE` bytes. It is absent from both checked
shipping SBOMs and the checked webapp image inventory. This is a non-shipping closure fact, not a legal
conclusion; provenance and the open decision are recorded in
[`licence-resolution.json`](./licence-resolution.json).

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

`scripts/audit-advisory.mjs` scans the agent's production lock closure and the **exact committed,
validated `linux/amd64` webapp image inventory** against OSV (`querybatch` + `vulns`). The receipt is
stamped with the inventory schema, byte hash, platform, counts, and exact per-image scan-set hashes.
`audit:advisory:check` fails on any input or finding-membership drift without network. Refreshes use
20-second bounded requests, batches of at most 1000, eight detail workers, and content-addressed JSON
caching; cache fallback or network limitations are recorded in the receipt. An
`--offline --osv-dir <export>` path remains available for air-gapped refreshes.

All eight M0.5-named items are adjudicated in the receipt's `m05Adjudication` block:

| package | versions in closure | verdict | advisory |
|---|---|---|---|
| **cookie** | 0.4.2, 0.6.0, 0.7.2 | **VULNERABLE_VERSION_PRESENT** | GHSA-pxg6-pf52-xh8x / **CVE-2024-47764**, LOW, fixed 0.7.0 — hits **0.4.2 (agent+webapp)** and **0.6.0 (webapp)**; **0.7.2 correctly NOT flagged** |
| postcss | absent | not in current shipping scan set | removed from the exact webapp image |
| tmp | absent | not in current shipping scan set | removed from the exact webapp image |
| semver | 7.7.3 | present, no current OSV advisory | agent+webapp |
| undici | 6.27.0, 7.25.0, 7.28.0, 8.7.0 | vulnerable version present | agent only; former 5.29.0 webapp surface removed |
| fast-xml-parser | 5.2.5 | vulnerable version present | **CVE-2026-25896 (CRITICAL)**, fixed 5.3.5, agent only |
| ws | 8.11.0, 8.18.0, 8.18.3 | vulnerable version present | both |
| path-to-regexp | 0.1.10, 8.4.2 | vulnerable version present | both |

**Point-in-time totals (scan date 2026-08-30):** 152 active findings across 876 exact union package
pairs — 3 CRITICAL, 56 HIGH, 75 MODERATE, 18 LOW. The refresh made 126/126 successful bounded public
OSV requests, used no cache fallback, and recorded no network limitation. These feed the `security`
renovate group (immediate, cadence-bypassing). WIN-253 materially reduced the prior pre-prune receipt;
the receipt does not claim the remaining findings are remediated.
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

1. **Regenerates** the agent SBOM from `pnpm-lock.yaml` and the webapp SBOM from its committed exact
   Docker package inventory, then **byte-compares** both to the committed files.
2. **Cross-checks** the committed SBOM and webapp inventory hashes, `linux/amd64` target, exact
   component/name counts, the reviewed seven lock-only Sentry optionals, build-input hashes, roots,
   lock-closure counts, and lockfile hash against `closure-receipts.json`.
3. **Runs the licence gate**: every component in a shipping runtime closure is classified; a copyleft
   (GPL/LGPL/AGPL/MPL/EPL/…) or commercial (`SEE LICENSE IN…`/`UNLICENSED`/proprietary) licence that is
   not in `license-policy.json`'s `dispositionedBaseline` **fails the build**.

**Non-vacuity is proven, not asserted** — `pnpm audit:sbom:nonvacuity`
(`scripts/verify-sbom-nonvacuity.mjs`, full transcript in `NON-VACUITY-PROOF.md`) injects a GPL canary
into a scratch copy of the agent closure and shows the gate FAILS; adds it to the baseline and shows it
PASSES; and independently injects a commercial/no-grant canary to show that classifier also FAILS.
All four assertions hold.

`pnpm test:sbom` runs the offline contract as a CI gate (12 tests, including receipt drift,
root-tooling/licence mutation, and removal of a legitimately installed package).

### CI image evidence
`.github/workflows/build-images.yml` passes the aggregate Docker/manifest/lock/scanner input hash into
the immutable `linux/amd64` webapp candidate build. Its required gate builds a distinct no-cache
`production-deps` stage, imports the exact downloaded final-candidate OCI archive without rebuilding
it, validates the archive checksum and candidate manifest digest, requires revision/build-input labels,
and byte-compares both inventories with the committed artifact. Evidence is retained under that
candidate manifest digest and records archive, image/rootfs, platform, revision, input, and inventory
hashes. The persisted-state gate starts the archive-derived verified image; publication redownloads
and validates the same manifest-keyed, source-run-bound evidence before importing that candidate archive
into GHCR. Publication delegates those checks to the executable
`scripts/verify-webapp-publication-provenance.mjs` validator before registry authentication. Its fixture
tests mutate every bound evidence field, while CI policy mutations short-circuit each comparison and
require every mutation to fail the policy gate.

---

## 7. M0.5 §6 "Unresolved" — disposition ledger

Every item from the M0.5 report's decision list, with its status here. **CLOSED** = resolved in this
change. **STAGED** = fix specified, requires a relock/manifest change out of scope for a no-install
audit. **DECISION** = genuinely needs a human founder/owner call. **LEGAL GATE** = provenance is
recorded but an authorized human/legal decision is still required before that item can be closed.

| # | item | status | disposition |
|---|---|---|---|
| 1 | No advisory scan had been run | **CLOSED** | `audit:advisory` scans both closures against OSV; receipt retained; all 8 named items adjudicated (§4). |
| 2 | `cookie` override missing | **STAGED** | Add `overrides['cookie']='>=0.7.2'` + session round-trip test; relock required. Routed to `auth-crypto` group. Owner: webapp/auth. |
| 3 | `breakword` GPL-2.0 | **CLOSED** | Root release tooling is excluded from the filtered production install; no waiver remains. |
| 4 | Root Apache vs package MIT provenance | **LEGAL GATE — CLOSED 2026-09-01** | Owner decided: Apache-2.0 distribution retained, and the upstream MIT notice retained verbatim in `packages/core/LICENSE` under an UPSTREAM ATTRIBUTION heading. Satisfies MIT §1 under either reading. See §2.1 and `licence-resolution.json`. |
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
| 15 | Root `workspaces` field + `.changeset` rename residue + `docs/package.json` | **DECISION** | Repository-layout and stale-note cleanup remains with the `@platos` rename owner. Package-level licence provenance is excluded from this residue item and handled by item 4. |

---

## 8. What is explicitly NOT done here (and why)

- **No broad dependency upgrade.** The two unused direct dependencies with concrete shipping/licence
  impact were removed and the lockfile was regenerated. The remaining dependency changes stay grouped
  behind compatibility tests and owner review; this audit does not blindly chase registry `latest`.
- **No blanket orphan purge.** The larger orphan list is evidence for later cleanup, not authority to
  delete packages without proving runtime, build, and external-control-plane reachability first.
- **No release/CI file changes.** That term is reserved; CI wiring is recommended in §6, not applied.
- **No ledger/manifest/WIN-292 changes.**
