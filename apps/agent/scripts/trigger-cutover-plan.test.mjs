import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceLateAcceptanceRollback,
  buildTriggerCutoverPlan,
} from "./trigger-cutover-plan.mjs";

const fixture = {
  sourceVersion: "20260817.1-source",
  targetVersion: "20260817.2-target",
  triggerDbRole: "legacy_trigger_writer",
  agentBaseUrl: "https://agent.internal.example",
  generatedAt: "2026-08-17T00:00:00.000Z",
};

test("builds a deterministic dry-run fence and version contract without secret values", () => {
  const plan = buildTriggerCutoverPlan(fixture);
  const serialized = JSON.stringify(plan);

  assert.equal(plan.executionPolicy, "DRY_RUN_ONLY");
  assert.equal(plan.sourceVersion, fixture.sourceVersion);
  assert.equal(plan.targetVersion, fixture.targetVersion);
  assert.match(plan.contractChecksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    plan.prepare.map(({ id }) => id),
    [
      "record-deployment-versions",
      "verify-source-version-available",
      "verify-target-version-available",
      "pause-schedules",
      "pause-queues",
      "drain-or-cancel-runs",
      "verify-no-active-runs",
      "verify-no-trigger-db-sessions",
      "revoke-or-firewall-legacy-trigger-db-role",
      "promote-target-version",
      "target-callback-smoke",
    ],
  );
  assert.doesNotMatch(serialized, /tr_(?:dev|prod|stg)_[A-Za-z0-9]+/);
  assert.doesNotMatch(serialized, /Bearer\s+/i);
  assert.match(serialized, /TRIGGER_ACCESS_TOKEN/);
  assert.match(serialized, /PLATOS_INTERNAL_AUTH_TOKEN/);
  assert.deepEqual(
    plan.prepare.find(({ id }) => id === "verify-no-trigger-db-sessions").command
      .environmentBindings,
    { PGDATABASE: "DATABASE_URL" },
  );
});

test("late acceptance rollback keeps the fence until restore, source re-promotion, and smoke", () => {
  const plan = buildTriggerCutoverPlan(fixture);
  assert.deepEqual(
    plan.lateAcceptanceRollback.map(({ id }) => id),
    [
      "keep-trigger-writer-fence",
      "restore-postgres",
      "restore-clickhouse",
      "reconcile-object-store",
      "repromote-source-version",
      "start-source-application-stack",
      "source-callback-smoke",
      "release-trigger-writer-fence",
    ],
  );

  let state = "TARGET_PROMOTED";
  for (const event of [
    "ACCEPTANCE_FAILED",
    "DATA_RESTORED",
    "SOURCE_REPROMOTED",
    "SOURCE_STACK_STARTED",
    "CALLBACK_SMOKE_PASSED",
    "FENCE_RELEASED",
  ]) {
    state = advanceLateAcceptanceRollback(state, event);
  }
  assert.equal(state, "FENCE_RELEASED");
});

test("rejects releasing the Trigger writer fence before restored callback acceptance", () => {
  assert.throws(
    () => advanceLateAcceptanceRollback("SOURCE_STACK_STARTED", "FENCE_RELEASED"),
    /Invalid late-acceptance rollback transition/,
  );
  assert.throws(
    () => advanceLateAcceptanceRollback("DATA_RESTORED", "SOURCE_STACK_STARTED"),
    /Invalid late-acceptance rollback transition/,
  );
});

test("rejects unsafe version, role, and callback URL inputs", () => {
  assert.throws(
    () => buildTriggerCutoverPlan({ ...fixture, sourceVersion: "$(printenv)" }),
    /sourceVersion/,
  );
  assert.throws(
    () => buildTriggerCutoverPlan({ ...fixture, triggerDbRole: "role; DROP ROLE" }),
    /triggerDbRole/,
  );
  assert.throws(
    () => buildTriggerCutoverPlan({ ...fixture, agentBaseUrl: "http://agent.example" }),
    /https/,
  );
  assert.throws(
    () => buildTriggerCutoverPlan({ ...fixture, drainTimeoutSeconds: 0 }),
    /drainTimeoutSeconds/,
  );
});
