# Development

## Install and initial setup

`pnpm install`

## Running the app

`pnpm run dev --filter docs`

## View the app locally

It runs locally here:
`http://localhost:3050`

## Evidence lifecycle

`docs/audits/win-254-evidence-lifecycle.json` uses a closed lifecycle vocabulary:

- **`ACCEPTED` is current.** Its mode and SHA-256 bind the file to current repository truth.
- **`SUPERSEDED-BY` is historical.** Its exact target must resolve without traversal, case drift, an orphan, or a cycle to `ACCEPTED` evidence.
- **`POINT-IN-TIME` is historical.** Its source snapshot, baseline, and valid non-future date describe what was true at that time, not current product acceptance.
- **`DRAFT` is not acceptance.** It carries an explicit non-current notice and cannot serve as a current or supersession target.

Historical evidence therefore cannot masquerade as published product truth. The inherited Mintlify `docs/**` site remains live and in place. `docs/audits/win-254-protected-paths.json` independently anchors the exact protected path set; the two WIN-254 generated control manifests exclude only themselves so they do not recursively classify or hash their own authority.

## Canonical WIN-254 regeneration

Run `pnpm generate:win254` to regenerate deterministic repository evidence in one acyclic pass. The command owns this exact order:

1. vocabulary boundary
2. ClickHouse split receipt
3. SBOM closure receipts
4. workspace reachability
5. vendored-build receipt
6. protected paths
7. evidence lifecycle

ClickHouse and SBOM precede workspace reachability because the workspace report hashes those receipts as inputs. Vendored-build follows workspace reachability because its integration receipt hashes the workspace report. Protected paths materializes after the upstream evidence generators, and evidence lifecycle runs last because it hashes the classified evidence, including the protected-path manifest. Point-in-time network snapshots such as the license index and OSV advisory receipt are refreshed separately when their package inputs change, then treated as committed inputs to this deterministic pass.

## Observability impact

WIN-254 is repository evidence governance, not a runtime capability. It adds no instrumentation and changes no domain event, store, outbox, ClickHouse, OpenTelemetry, log, metric, dashboard, or SLO schema. The retained [WIN-290 deadline and removal evidence](./audits/win253-removals/clickhouse-split.md) remains the narrow current ClickHouse timeout/cancellation/telemetry safeguard. The broader observability outbox, projection, trace, metric, and SLO work remains future [WIN-275](https://linear.app/winsen-labs/issue/WIN-275/m53-refactor-observability-outbox-clickhouse-projection-traces-and) scope; these repository controls do not claim to implement it. No external control-plane, release, publication, or runtime-store claim is made.
