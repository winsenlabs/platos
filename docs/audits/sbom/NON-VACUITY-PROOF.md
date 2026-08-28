# Non-vacuity proof — the M0.5 licence gate can actually fail

A drift/licence gate is only worth anything if it can FAIL on a real violation. This proves the
Platos M0.5 licence gate (`scripts/audit-sbom.mjs check`, `pnpm audit:sbom:check`) is **non-vacuous**:
it fails the build when a GPL/commercial dependency enters a shipping runtime closure, and it is not
merely green because nothing can trip it.

Reproduce:

```bash
pnpm audit:sbom:nonvacuity        # node scripts/verify-sbom-nonvacuity.mjs — exit 0 iff all hold
```

The harness never mutates the committed tree. It writes scratch copies of `pnpm-lock.yaml`, the
frozen licence index, and the policy under a temp dir, injects a GPL canary into the **agent**
production closure, and runs the real `check` against the scratch inputs (via the `--lockfile`,
`--index`, `--policy` flags the tool exposes for exactly this).

## Four assertions

| | scenario | expected | why it matters |
|---|---|---|---|
| **A** | real lockfile + real committed policy | **PASS** | the committed state is green (the 3 real copyleft/commercial packages are all dispositioned) |
| **B** | inject `evil-gpl-canary@9.9.9` (GPL-3.0-only) into the agent closure, empty baseline | **FAIL** | the gate fires on a copyleft package that just entered a shipping image |
| **C** | same injected canary, but added to the dispositioned baseline | **PASS** | the disposition path is the release valve — a reasoned waiver, not a rubber stamp |
| **D** | unmodified lockfile, but `breakword` removed from the baseline | **FAIL** | the gate fires on the **real** GPL-2.0 `breakword@1.0.5` already shipping in the webapp image — not just on a synthetic package |

A + B together prove the gate discriminates (it is not stuck-green). C proves the waiver mechanism.
D proves it fires on real production data.

## Transcript (captured `pnpm audit:sbom:nonvacuity`, temp paths elided)

```text
# Non-vacuity proof transcript
scratch dir: <scratch-tmpdir>

### A. CONTROL — real lockfile + real committed policy (should PASS)
expected exit 0, got exit 0 — PASS
---- check output ----
OK: platos-agent.cdx.json matches the lockfile closure (718 components).
OK: platos-webapp.cdx.json matches the lockfile closure (1845 components).
DISPOSITIONED: @fingerprintjs/fingerprintjs-pro@3.11.9 (SEE LICENSE IN LICENSE, commercial) in webapp — baseline-waived.
DISPOSITIONED: breakword@1.0.5 (gpl-2.0, copyleft) in webapp — baseline-waived.
DISPOSITIONED: posthog-js@1.369.0 (SEE LICENSE IN LICENSE, commercial) in webapp — baseline-waived.

Licence policy: no un-dispositioned copyleft/commercial packages in any shipping closure.

audit:sbom check PASSED

### B. INJECT — evil-gpl-canary@9.9.9 (GPL-3.0-only) added to the agent closure, empty baseline (should FAIL)
expected exit 1, got exit 1 — PASS
---- check output ----
LICENCE POLICY FAILURE — 4 un-dispositioned copyleft/commercial package(s) in a shipping runtime closure:
  [copyleft] evil-gpl-canary@9.9.9  (GPL-3.0-only)  image=agent  — Copyleft / reciprocal terms — legal review required before shipping in an Apache-2.0 product.
  [commercial] @fingerprintjs/fingerprintjs-pro@3.11.9  (SEE LICENSE IN LICENSE)  image=webapp  — Commercial or unresolved 'see the bundled file' grant — obligation cannot be discharged from an SBOM and may be non-redistributable.
  [copyleft] breakword@1.0.5  (gpl-2.0)  image=webapp  — Copyleft / reciprocal terms — legal review required before shipping in an Apache-2.0 product.
  [commercial] posthog-js@1.369.0  (SEE LICENSE IN LICENSE)  image=webapp  — Commercial or unresolved 'see the bundled file' grant — obligation cannot be discharged from an SBOM and may be non-redistributable.

Resolve by removing the dependency, overriding to a permissive version, or — if genuinely accepted —
adding an explicit, reasoned entry to docs/audits/sbom/license-policy.json dispositionedBaseline.

audit:sbom check FAILED

### C. DISPOSITION — same injected GPL canary, but waived in baseline (should PASS)
expected exit 0, got exit 0 — PASS
---- check output ----
DISPOSITIONED: evil-gpl-canary@9.9.9 (GPL-3.0-only, copyleft) in agent — baseline-waived.
DISPOSITIONED: @fingerprintjs/fingerprintjs-pro@3.11.9 (SEE LICENSE IN LICENSE, commercial) in webapp — baseline-waived.
DISPOSITIONED: breakword@1.0.5 (gpl-2.0, copyleft) in webapp — baseline-waived.
DISPOSITIONED: posthog-js@1.369.0 (SEE LICENSE IN LICENSE, commercial) in webapp — baseline-waived.

Licence policy: no un-dispositioned copyleft/commercial packages in any shipping closure.

audit:sbom check PASSED

### D. REAL GPL — unmodified lockfile, but breakword removed from baseline (should FAIL on the real GPL-2.0 breakword@1.0.5 in webapp)
expected exit 1, got exit 1 — PASS
---- check output ----
OK: platos-agent.cdx.json matches the lockfile closure (718 components).
OK: platos-webapp.cdx.json matches the lockfile closure (1845 components).
DISPOSITIONED: @fingerprintjs/fingerprintjs-pro@3.11.9 (SEE LICENSE IN LICENSE, commercial) in webapp — baseline-waived.
DISPOSITIONED: posthog-js@1.369.0 (SEE LICENSE IN LICENSE, commercial) in webapp — baseline-waived.

LICENCE POLICY FAILURE — 1 un-dispositioned copyleft/commercial package(s) in a shipping runtime closure:
  [copyleft] breakword@1.0.5  (gpl-2.0)  image=webapp  — Copyleft / reciprocal terms — legal review required before shipping in an Apache-2.0 product.

Resolve by removing the dependency, overriding to a permissive version, or — if genuinely accepted —
adding an explicit, reasoned entry to docs/audits/sbom/license-policy.json dispositionedBaseline.

audit:sbom check FAILED

# RESULT: NON-VACUITY PROVEN — all 4 assertions held.
```

## Result

**NON-VACUITY PROVEN — all four assertions held (harness exits 0).** This runs offline and is part of
`pnpm test:sbom`, so CI enforces it on every change.
