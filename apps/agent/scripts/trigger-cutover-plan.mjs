#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;

function assertValue(name, value, pattern) {
  if (!value || !pattern.test(value)) {
    throw new Error(`${name} is required and must match ${pattern}`);
  }
  return value;
}

function adapterAction(id, phase, operation, args, requiredEnvironment = ["TRIGGER_ACCESS_TOKEN"]) {
  return {
    id,
    phase,
    mode: "dry-run-adapter-contract",
    command: {
      executable: "trigger-cutover-adapter",
      args: [operation, ...args],
      requiredEnvironment,
    },
  };
}

function operatorAction(id, phase, instruction) {
  return { id, phase, mode: "authorized-operator", instruction };
}

export function buildTriggerCutoverPlan(input) {
  const sourceVersion = assertValue("sourceVersion", input.sourceVersion, VERSION_PATTERN);
  const targetVersion = assertValue("targetVersion", input.targetVersion, VERSION_PATTERN);
  const triggerDbRole = assertValue("triggerDbRole", input.triggerDbRole, ROLE_PATTERN);
  const drainTimeoutSeconds = input.drainTimeoutSeconds ?? 900;
  if (!Number.isSafeInteger(drainTimeoutSeconds) || drainTimeoutSeconds <= 0) {
    throw new Error("drainTimeoutSeconds must be a positive integer");
  }
  const agentBaseUrl = new URL(input.agentBaseUrl);
  if (agentBaseUrl.protocol !== "https:" && agentBaseUrl.hostname !== "localhost") {
    throw new Error("agentBaseUrl must use https except for localhost fixtures");
  }

  const commonArgs = ["--project-ref-env", "TRIGGER_PROJECT_REF"];
  const prepare = [
    {
      id: "record-deployment-versions",
      phase: "prepare",
      mode: "record",
      record: { sourceVersion, targetVersion },
    },
    adapterAction("verify-source-version-available", "prepare", "verify-version", [
      ...commonArgs,
      "--version",
      sourceVersion,
    ]),
    adapterAction("verify-target-version-available", "prepare", "verify-version", [
      ...commonArgs,
      "--version",
      targetVersion,
    ]),
    adapterAction("pause-schedules", "quiesce", "pause-schedules", commonArgs),
    adapterAction("pause-queues", "quiesce", "pause-queues", commonArgs),
    adapterAction("drain-or-cancel-runs", "quiesce", "drain-runs", [
      ...commonArgs,
      "--cancel-after-seconds",
      String(drainTimeoutSeconds),
    ]),
    adapterAction("verify-no-active-runs", "verify-fence", "verify-no-active-runs", commonArgs),
    {
      id: "verify-no-trigger-db-sessions",
      phase: "verify-fence",
      mode: "dry-run-command-contract",
      command: {
        executable: "psql",
        args: [
          "--set=ON_ERROR_STOP=1",
          `--set=trigger_db_role=${triggerDbRole}`,
          "--set=trigger_application_pattern=trigger",
          "--file=apps/agent/scripts/verify-no-trigger-db-sessions.sql",
        ],
        environmentBindings: { PGDATABASE: "DATABASE_URL" },
        requiredEnvironment: ["DATABASE_URL"],
      },
    },
    operatorAction(
      "revoke-or-firewall-legacy-trigger-db-role",
      "verify-fence",
      `Revoke CONNECT and firewall access for legacy Trigger role ${triggerDbRole}; keep the fence until callback acceptance succeeds.`,
    ),
    adapterAction("promote-target-version", "target-cutover", "promote-version", [
      ...commonArgs,
      "--version",
      targetVersion,
    ]),
    adapterAction(
      "target-callback-smoke",
      "target-acceptance",
      "callback-smoke",
      [
        "--agent-base-url",
        agentBaseUrl.toString().replace(/\/$/, ""),
        "--deployment-version",
        targetVersion,
      ],
      ["TRIGGER_ACCESS_TOKEN", "PLATOS_INTERNAL_AUTH_TOKEN"],
    ),
  ];

  const lateAcceptanceRollback = [
    operatorAction(
      "keep-trigger-writer-fence",
      "rollback",
      "Keep schedules and queues paused, reject new runs, and retain the Trigger database role firewall/revocation.",
    ),
    operatorAction(
      "restore-postgres",
      "rollback",
      "Restore the recorded PostgreSQL backup/PITR point before starting any source application writer.",
    ),
    operatorAction(
      "restore-clickhouse",
      "rollback",
      "Restore the coordinated ClickHouse snapshot and remove rows newer than the PostgreSQL restoration point.",
    ),
    operatorAction(
      "reconcile-object-store",
      "rollback",
      "Reconcile object-store writes newer than the PostgreSQL restoration point using the signed object ledger.",
    ),
    adapterAction("repromote-source-version", "rollback", "promote-version", [
      ...commonArgs,
      "--version",
      sourceVersion,
    ]),
    operatorAction(
      "start-source-application-stack",
      "rollback",
      "Start the recorded source-compatible Platos images only after the source Trigger version is current.",
    ),
    adapterAction(
      "source-callback-smoke",
      "rollback-acceptance",
      "callback-smoke",
      [
        "--agent-base-url",
        agentBaseUrl.toString().replace(/\/$/, ""),
        "--deployment-version",
        sourceVersion,
      ],
      ["TRIGGER_ACCESS_TOKEN", "PLATOS_INTERNAL_AUTH_TOKEN"],
    ),
    operatorAction(
      "release-trigger-writer-fence",
      "rollback-acceptance",
      "Release the database fence and resume queues/schedules only after the restored source callback smoke is recorded as passing.",
    ),
  ];

  const plan = {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    executionPolicy: "DRY_RUN_ONLY",
    sourceVersion,
    targetVersion,
    triggerDbRole,
    prepare,
    lateAcceptanceRollback,
  };
  const contractChecksum = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  return { ...plan, contractChecksum };
}

const ROLLBACK_TRANSITIONS = {
  TARGET_PROMOTED: ["ACCEPTANCE_FAILED"],
  ACCEPTANCE_FAILED: ["DATA_RESTORED"],
  DATA_RESTORED: ["SOURCE_REPROMOTED"],
  SOURCE_REPROMOTED: ["SOURCE_STACK_STARTED"],
  SOURCE_STACK_STARTED: ["CALLBACK_SMOKE_PASSED"],
  CALLBACK_SMOKE_PASSED: ["FENCE_RELEASED"],
  FENCE_RELEASED: [],
};

export function advanceLateAcceptanceRollback(state, event) {
  const allowed = ROLLBACK_TRANSITIONS[state];
  if (!allowed || !allowed.includes(event)) {
    throw new Error(`Invalid late-acceptance rollback transition: ${state} -> ${event}`);
  }
  return event;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function usage() {
  return [
    "Generate (never execute) the WIN-123 external Trigger cutover contract.",
    "",
    "node apps/agent/scripts/trigger-cutover-plan.mjs \\",
    "  --source-version <version> --target-version <version> \\",
    "  --trigger-db-role <role> --agent-base-url <https-url> [--output <path>]",
  ].join("\n");
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const plan = buildTriggerCutoverPlan({
    sourceVersion: args["source-version"],
    targetVersion: args["target-version"],
    triggerDbRole: args["trigger-db-role"],
    agentBaseUrl: args["agent-base-url"],
    drainTimeoutSeconds: args["drain-timeout-seconds"]
      ? Number(args["drain-timeout-seconds"])
      : undefined,
  });
  const output = `${JSON.stringify(plan, null, 2)}\n`;
  if (args.output) writeFileSync(args.output, output, { mode: 0o600 });
  else process.stdout.write(output);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`trigger-cutover-plan: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
