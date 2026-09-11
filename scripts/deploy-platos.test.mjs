import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const deployScript = path.join(repositoryRoot, "scripts/deploy-platos.sh");
const commitSha = "1".repeat(40);
const memoryDigest = "d".repeat(64);

// WHY TWO OF THIS FILE'S CASES SKIP ON A MAC, AND WHAT THEY WOULD OTHERWISE
// MEASURE. READ THIS BEFORE TREATING `94 pass / 2 fail` AS A PRODUCT DEFECT.
//
// `pnpm test:persisted-state:performance-contract` sat at 94 passed / 2 FAILED for
// weeks and nobody had written down what the two were. They are the two cases
// below that EXECUTE `scripts/deploy-platos.sh` end to end against a mocked
// `docker`, `git` and `sleep` on `PATH`. Every other case in that gate reads the
// script and the compose files as TEXT and mutates them, which is why 94 of 96
// pass anywhere.
//
// THE FAILURE WAS NEVER THE ONE THE ERROR NAMED. Both reported
//
//     ENOENT: no such file or directory, open '/var/tmp/platos-deploy-test-XXXXXX/docker.log'
//
// which reads as "the mock docker did not run". Measured by invoking the script by
// hand with the suite's own environment, the real cause is four lines earlier and
// the mock never gets a turn:
//
//     awk: can't open file /proc/stat
//     cut: /proc/loadavg: No such file or directory
//
// `deploy-platos.sh`'s FIRST step is the CPU-headroom pre-flight, and
// `cpu_idle_pct` reads `/proc/stat` twice a second apart while the line under it
// reads `/proc/loadavg`. Those are LINUX PROCFS. They do not exist on Darwin, so
// the script exits 1 before it ever calls `docker`, the log is never created, and
// `runDeploy`'s `readFile` throws before a single assertion is reached.
//
// SO IT IS A HOST-KERNEL PRECONDITION, NOT A BUG IN THE SCRIPT AND NOT A BUG IN
// THE SUITE. The script is correct to read procfs: it deploys to a Linux host, and
// the comment above `cpu_idle_pct` explains at length why steal time in
// `/proc/stat` is the only honest headroom signal on the reference box. CI runs
// `ubuntu-latest`, where both files exist, so BOTH CASES RUN AND PASS THERE — this
// gate has never been red in CI on this account.
//
// WHAT THIS CHANGES, AND WHAT IT REFUSES TO CHANGE. The two cases now SKIP WITH
// THE REASON PRINTED rather than failing with an error that points at the wrong
// file. A portable Darwin fallback in `cpu_idle_pct` was considered and rejected:
// it would add a measurement path that NEVER executes in production and would
// quietly weaken these two cases from "the Linux pre-flight works" to "some
// pre-flight works".
//
// AND THE SKIP CANNOT GO DARK WHERE IT MATTERS. It is gated on the ACTUAL
// precondition -- whether those two files exist -- and never on `process.platform`,
// and if they are missing on a LINUX host it FAILS instead of skipping. A Linux box
// with no `/proc/stat` is a broken runner, not a supported one, so CI cannot reach
// the skip branch: an `ubuntu-latest` runner that somehow lacked procfs would go
// red here rather than reporting two quiet skips.

/** Exactly the files `deploy-platos.sh`'s pre-flight reads, in the order it reads them. */
const PREFLIGHT_PROCFS_FILES = Object.freeze(["/proc/stat", "/proc/loadavg"]);

/**
 * The pre-flight files this host does not have, or an empty array.
 *
 * Enumerated from the paths above rather than inferred from a platform name, so a
 * host that grows or loses procfs is measured rather than guessed at.
 */
function absentPreflightFiles() {
  return PREFLIGHT_PROCFS_FILES.filter((file) => !existsSync(file));
}

/**
 * True when this host cannot execute the script's pre-flight; asserts on Linux.
 *
 * `t.skip()` with the reason, so a reader of the output learns the cause instead of
 * inheriting a number. See the banner for why the Linux assertion is what keeps
 * this from becoming a way to green a red.
 */
function skipUnlessPreflightRunnable(t) {
  const absent = absentPreflightFiles();
  if (absent.length === 0) return false;
  assert.equal(
    process.platform,
    "darwin",
    `${absent.join(" and ")} absent on ${process.platform}: deploy-platos.sh's CPU-headroom ` +
      `pre-flight cannot run, and on a non-Darwin host that is a broken runner rather than an ` +
      `unsupported one. Refusing to skip.`,
  );
  t.skip(
    `${absent.join(" and ")} do not exist on ${process.platform}. deploy-platos.sh reads them in ` +
      `its CPU-headroom pre-flight before it calls docker, so the script exits 1 and no mock ` +
      `docker log is written. The case runs on ubuntu-latest in CI. See this file's banner.`,
  );
  return true;
}

function orderingViolations(source) {
  const violations = [];
  const sequenceStart = source.indexOf('say "Stop every application writer before migration"');
  const operational = sequenceStart === -1 ? "" : source.slice(sequenceStart);
  const markers = [
    "stop $APP_SERVICES",
    "ps --status running --quiet $APP_SERVICES",
    "run --rm --no-deps migrations-init",
    "memory-profile-migrate memory-profile-dry-run",
    'memory-profile-migrate memory-profile-apply --digest "$MEMORY_PROFILE_DIGEST"',
    "memory-profile-migrate memory-profile-verify",
    "up -d --no-deps $APP_SERVICES",
  ];
  let previous = -1;
  for (const marker of markers) {
    const offset = operational.indexOf(marker);
    if (offset === -1) violations.push(`missing ${marker}`);
    else if (offset <= previous) violations.push(`out of order ${marker}`);
    previous = Math.max(previous, offset);
  }
  if (!source.includes("trap leave_apps_stopped_on_failure EXIT")) {
    violations.push("missing fail-closed EXIT trap");
  }
  if (!source.includes('mapfile -t memory_profile_digests')) {
    violations.push("dry-run digest is not captured exactly");
  }
  if (/APP_SERVICES="[^"]*\bworker\b/.test(source)) {
    violations.push("orphan worker service remains in the deployment set");
  }
  return violations;
}

test("deploy contract stops and verifies writers before digest-bound migration and restart", async () => {
  const source = await readFile(deployScript, "utf8");
  assert.deepEqual(orderingViolations(source), []);

  const mutations = [
    source.replaceAll("docker compose $COMPOSE_FILES stop $APP_SERVICES", "true # writer stop removed"),
    source.replace("ps --status running --quiet $APP_SERVICES", "ps --quiet $APP_SERVICES"),
    source.replace(
      'memory-profile-migrate memory-profile-apply --digest "$MEMORY_PROFILE_DIGEST"',
      "memory-profile-migrate memory-profile-apply --digest unbound",
    ),
    source.replace("trap leave_apps_stopped_on_failure EXIT", "true # trap removed"),
    source.replace('APP_SERVICES="agent webapp"', 'APP_SERVICES="agent webapp worker"'),
  ];
  for (const mutation of mutations) {
    assert.notDeepEqual(orderingViolations(mutation), []);
  }
});

test("compose contracts use the migration image and gate application startup on exact verification", async () => {
  const [base, override, gate] = await Promise.all([
    readFile(path.join(repositoryRoot, "docker-compose.platos.yml"), "utf8"),
    readFile(path.join(repositoryRoot, "docker-compose.deploy.yml"), "utf8"),
    readFile(path.join(repositoryRoot, ".github/compose/persisted-state-gate.yml"), "utf8"),
  ]);
  assert.deepEqual(composeViolations(base, override, gate), []);

  const mutations = [
    [base.replace("memory-profile-bootstrap-empty", "memory-profile-apply"), override, gate],
    [base, override.replace(
      "  memory-profile-migrate:\n    image: ${PLATOS_MIGRATIONS_IMAGE:?set PLATOS_MIGRATIONS_IMAGE to the tested ghcr.io digest reference}",
      "  memory-profile-migrate:\n    image: ${PLATOS_AGENT_IMAGE}",
    ), gate],
    [base, override, gate.replace("/artifacts/memory-profile-dry-run.json", "/tmp/dry-run.json")],
    [base, override, gate.replace(
      "  memory-profile-migrate:\n    image: ${WIN235_MIGRATIONS_RUNTIME_IMAGE:?WIN235_MIGRATIONS_RUNTIME_IMAGE must be the loaded tested candidate}",
      "  memory-profile-migrate:\n    image: ${WIN235_AGENT_RUNTIME_IMAGE}",
    )],
    [base, `${override}\n  worker:\n    image: orphan\n`, gate],
  ];
  for (const [mutatedBase, mutatedOverride, mutatedGate] of mutations) {
    assert.notDeepEqual(composeViolations(mutatedBase, mutatedOverride, mutatedGate), []);
  }
});

test("successful deploy hands the exact dry-run digest to apply before starting apps", async (t) => {
  if (skipUnlessPreflightRunnable(t)) return;
  const execution = await runDeploy();
  assert.equal(execution.status, 0, execution.stderr);

  const lines = execution.log.trim().split("\n");
  const stop = lineIndex(lines, "compose -f mock.yml stop agent webapp");
  const writerCheck = lineIndex(lines, "ps --status running --quiet agent webapp");
  const prisma = lineIndex(lines, "run --rm --no-deps migrations-init");
  const dryRun = lineIndex(lines, "memory-profile-migrate memory-profile-dry-run");
  const apply = lineIndex(
    lines,
    `memory-profile-migrate memory-profile-apply --digest ${memoryDigest}`,
  );
  const verify = lineIndex(lines, "memory-profile-migrate memory-profile-verify");
  const start = lineIndex(lines, "up -d --no-deps agent webapp");

  assert.ok(stop < writerCheck && writerCheck < prisma && prisma < dryRun);
  assert.ok(dryRun < apply && apply < verify && verify < start);
  assert.equal(execution.log.includes(" worker"), false);
  assert.match(
    await readFile(path.join(execution.evidenceDirectory, "memory-profile-dry-run.json"), "utf8"),
    new RegExp(memoryDigest),
  );
});

test("a migration failure never starts applications and the EXIT trap stops writers again", async (t) => {
  if (skipUnlessPreflightRunnable(t)) return;
  const execution = await runDeploy("memory-profile-apply");
  assert.notEqual(execution.status, 0);
  assert.equal(execution.log.includes("up -d --no-deps agent webapp"), false);
  assert.match(execution.stderr, /application services remain stopped/);
  assert.equal(
    execution.log.split("\n").filter((line) => line.includes("stop agent webapp")).length,
    2,
  );
});

async function runDeploy(failStep = "") {
  const directory = await mkdtemp(path.join("/var/tmp", "platos-deploy-test-"));
  const bin = path.join(directory, "bin");
  const logPath = path.join(directory, "docker.log");
  const evidenceDirectory = path.join(directory, "evidence");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "git"),
    `#!/usr/bin/env bash\nif [ "$1" = "rev-parse" ]; then echo "${commitSha}"; exit 0; fi\nif [ "$1" = "diff" ]; then exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  await writeFile(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  await writeFile(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
if [ "\${1:-}" = "image" ] && [ "\${2:-}" = "inspect" ]; then
  printf '%s\n' "$PLATOS_RELEASE_COMMIT_SHA"
  exit 0
fi
if [ "\${1:-}" = "inspect" ]; then
  printf '%s\n' healthy
  exit 0
fi
case "$*" in
  *"ps --status running --quiet agent webapp"*|*"ps --status restarting --quiet agent webapp"*)
    exit 0
    ;;
  *"ps -q agent"*)
    printf '%s\n' agent-container
    exit 0
    ;;
  *"ps -q webapp"*)
    printf '%s\n' webapp-container
    exit 0
    ;;
  *"memory-profile-migrate memory-profile-dry-run"*)
    printf '%s\n' '{"event":"memory_profile_migration","command":"dry-run","status":"ready","digest":"${memoryDigest}","contentRedacted":true}'
    exit 0
    ;;
  *"memory-profile-migrate memory-profile-apply"*)
    if [ "\${MOCK_FAIL_STEP:-}" = "memory-profile-apply" ]; then exit 42; fi
    printf '%s\n' '{"event":"memory_profile_migration","command":"apply","status":"applied","contentRedacted":true}'
    exit 0
    ;;
  *"memory-profile-migrate memory-profile-verify"*)
    printf '%s\n' '{"event":"memory_profile_migration","command":"verify","status":"verified","contentRedacted":true}'
    exit 0
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_DOCKER_LOG: logPath,
    MOCK_FAIL_STEP: failStep,
    COMPOSE_FILES: "-f mock.yml",
    DEPLOY_MIN_IDLE_PCT: "0",
    PLATOS_DEPLOY_EVIDENCE_DIR: evidenceDirectory,
    PLATOS_AGENT_IMAGE: `ghcr.io/winsenlabs/platos-agent@sha256:${"a".repeat(64)}`,
    PLATOS_WEBAPP_IMAGE: `ghcr.io/winsenlabs/platos-webapp@sha256:${"b".repeat(64)}`,
    PLATOS_MIGRATIONS_IMAGE: `ghcr.io/winsenlabs/platos-migrations@sha256:${"c".repeat(64)}`,
    PLATOS_RELEASE_COMMIT_SHA: commitSha,
    PLATOS_MIGRATION_COMPATIBILITY_PROVEN: "1",
    PLATOS_MEMORY_PROFILE_PLAN_SHA256: memoryDigest,
    PLATOS_RECOVERY_POINT_ID: "postgres-pitr-verified",
    PLATOS_RECOVERY_RESTORE_TEST_ID: "restore-test-verified",
  };
  const result = spawnSync("bash", [deployScript], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    log: await readFile(logPath, "utf8"),
    evidenceDirectory,
  };
}

function lineIndex(lines, fragment) {
  const index = lines.findIndex((line) => line.includes(fragment));
  assert.notEqual(index, -1, `missing command containing: ${fragment}`);
  return index;
}

function composeViolations(base, override, gate) {
  const violations = [];
  const requiredBase = [
    "  memory-profile-migrate:",
    "dockerfile: internal-packages/tenancy-database/Dockerfile.migrations",
    'command: ["memory-profile-bootstrap-empty"]',
  ];
  for (const marker of requiredBase) {
    if (!base.includes(marker)) violations.push(`base compose missing ${marker}`);
  }
  if ((base.match(/^      memory-profile-migrate:\n        condition: service_completed_successfully$/gm) ?? []).length < 2) {
    violations.push("both applications are not gated on the Memory profile contract");
  }
  if (base.includes("memory-profile-dry-run") || base.includes("memory-profile-apply --digest")) {
    violations.push("base compose can perform a reviewed existing-data migration");
  }
  if (!override.includes(
    "  memory-profile-migrate:\n    image: ${PLATOS_MIGRATIONS_IMAGE:?set PLATOS_MIGRATIONS_IMAGE to the tested ghcr.io digest reference}",
  )) {
    violations.push("deploy override does not pin the Memory migration service to the migration digest");
  }
  if (!gate.includes(
    "  memory-profile-migrate:\n    image: ${WIN235_MIGRATIONS_RUNTIME_IMAGE:?WIN235_MIGRATIONS_RUNTIME_IMAGE must be the loaded tested candidate}",
  )) {
    violations.push("persisted-state gate does not use the tested migration candidate");
  }
  if (/^  worker:/m.test(base) || /^  worker:/m.test(override)) {
    violations.push("orphan worker compose service remains");
  }
  for (const artifact of [
    "/artifacts/memory-profile-dry-run.json",
    "/artifacts/memory-profile-apply.json",
    "/artifacts/memory-profile-verify.json",
  ]) {
    if (!gate.includes(artifact)) violations.push(`gate does not capture ${artifact}`);
  }
  if (!gate.includes('memory-profile-apply --digest "$$digest"')) {
    violations.push("gate apply is not bound to its captured dry-run digest");
  }
  if (!gate.includes("memory-profile-migrate:\n        condition: service_completed_successfully")) {
    violations.push("gate Agent startup does not depend on Memory migration success");
  }
  return violations;
}
