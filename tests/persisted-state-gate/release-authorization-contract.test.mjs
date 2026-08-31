import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const workflowRoot = path.join(repositoryRoot, ".github/workflows");
const publicationValidatorCommand =
  "node scripts/verify-webapp-publication-provenance.mjs --candidate-identities artifacts/gate/candidate-images.json --inventory-root artifacts/webapp-inventory --candidate-archive artifacts/candidates/webapp.oci.tar";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function source(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function mutate(fixture, before, after, options = {}) {
  assert.ok(fixture.includes(before), `mutation source is missing ${JSON.stringify(before)}`);
  const mutation = options.all ? fixture.replaceAll(before, after) : fixture.replace(before, after);
  assert.notEqual(mutation, fixture, "fixture mutation must change source");
  return mutation;
}

function insertExecutableJobStep(fixture, jobName, stepYaml) {
  const job = jobBlock(fixture, jobName);
  const marker = "    steps:\n";
  assert.ok(job.includes(marker), `${jobName} job is missing steps`);
  const mutatedJob = job.replace(marker, `${marker}${stepYaml}`);
  assert.notEqual(mutatedJob, job, "job step mutation must change source");
  const mutation = fixture.replace(job, mutatedJob);
  assert.notEqual(mutation, fixture, "workflow mutation must change source");
  assert.ok(jobBlock(mutation, jobName).includes(`${marker}${stepYaml}`), "mutation must remain under the target job steps");
  return mutation;
}

function publicationProvenanceFixture() {
  const root = mkdtempSync(path.join("/var/tmp", "platos-publication-provenance-"));
  const configDigest = `sha256:${"7".repeat(64)}`;
  const manifestBytes = JSON.stringify({ config: { digest: configDigest } });
  const digest = `sha256:${sha256(manifestBytes)}`;
  const digestKey = digest.slice("sha256:".length);
  const inventoryRoot = path.join(root, "inventory");
  const evidenceRoot = path.join(inventoryRoot, digestKey);
  const candidateIdentitiesPath = path.join(root, "candidate-images.json");
  const candidateArchivePath = path.join(root, "candidates", "webapp.oci.tar");
  const archiveRoot = path.join(root, "archive");
  mkdirSync(path.join(archiveRoot, "blobs", "sha256"), { recursive: true });
  writeFileSync(
    path.join(archiveRoot, "index.json"),
    JSON.stringify({
      manifests: [{
        digest,
        size: Buffer.byteLength(manifestBytes),
        platform: { os: "linux", architecture: "amd64" },
      }],
    }),
  );
  writeFileSync(path.join(archiveRoot, "blobs", "sha256", digestKey), manifestBytes);
  mkdirSync(path.dirname(candidateArchivePath), { recursive: true });
  const tarResult = spawnSync(
    "tar",
    ["-cf", candidateArchivePath, "-C", archiveRoot, "index.json", "blobs"],
    { encoding: "utf8" },
  );
  assert.equal(tarResult.status, 0, tarResult.stderr);
  const buildInputsSha256 = spawnSync(
    process.execPath,
    ["scripts/verify-webapp-image-inventory.mjs", "--print-build-inputs-sha256"],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).stdout.trim();
  const env = {
    ...process.env,
    PLATOS_CANDIDATE_SHA: "a".repeat(40),
    WIN235_AGENT_IMAGE: `ghcr.io/example/platos-agent@sha256:${"2".repeat(64)}`,
    WIN235_WEBAPP_IMAGE: `ghcr.io/example/platos-webapp@${digest}`,
    WIN235_MIGRATIONS_IMAGE: `ghcr.io/example/platos-migrations@sha256:${"3".repeat(64)}`,
    WIN235_WEBAPP_ARCHIVE_SHA256: sha256(readFileSync(candidateArchivePath)),
    SOURCE_RUN_ID: "123456",
    SOURCE_RUN_ATTEMPT: "2",
  };
  const identities = {
    commitSha: env.PLATOS_CANDIDATE_SHA,
    agent: env.WIN235_AGENT_IMAGE,
    webapp: env.WIN235_WEBAPP_IMAGE,
    migrations: env.WIN235_MIGRATIONS_IMAGE,
  };
  const evidence = (stage, imageId) => ({
    $schema: "platos.audit.webapp-image-inventory-evidence/v3",
    sourceRunId: env.SOURCE_RUN_ID,
    sourceRunAttempt: env.SOURCE_RUN_ATTEMPT,
    gitHead: env.PLATOS_CANDIDATE_SHA,
    stage,
    candidateManifestDigest: digest,
    candidateConfigDigest: configDigest,
    candidateArchiveSha256: env.WIN235_WEBAPP_ARCHIVE_SHA256,
    imageId,
    imageDescriptorDigest: null,
    platform: "linux/amd64",
    imageRevisionLabel: env.PLATOS_CANDIDATE_SHA,
    imageBuildInputsLabel: buildInputsSha256,
    inventoryByteMatch: true,
    generatedInventorySha256: "5".repeat(64),
    committedInventorySha256: "5".repeat(64),
    buildInputsSha256,
  });
  const production = evidence("production-deps", `sha256:${"6".repeat(64)}`);
  const final = evidence("final", `sha256:${"7".repeat(64)}`);

  function write() {
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(candidateIdentitiesPath, `${JSON.stringify(identities)}\n`);
    writeFileSync(path.join(evidenceRoot, "production-deps.json"), `${JSON.stringify(production)}\n`);
    writeFileSync(path.join(evidenceRoot, "final.json"), `${JSON.stringify(final)}\n`);
  }

  function run() {
    write();
    return spawnSync(
      process.execPath,
      [
        "scripts/verify-webapp-publication-provenance.mjs",
        "--candidate-identities",
        candidateIdentitiesPath,
        "--inventory-root",
        inventoryRoot,
        "--candidate-archive",
        candidateArchivePath,
      ],
      { cwd: repositoryRoot, env, encoding: "utf8" },
    );
  }

  return { root, env, identities, production, final, run };
}

function jobBlock(workflow, jobName) {
  const start = workflow.indexOf(`  ${jobName}:\n`);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return workflow.slice(start, nextJob === -1 ? workflow.length : start + 1 + nextJob);
}

function imagePublicationViolations(workflow) {
  const violations = [];
  const triggerBlock = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("concurrency:"));
  const sourceRunChecks = [
    '.path == ".github/workflows/build-images.yml"',
    '.event == "push"',
    '.head_branch == "main"',
    '.status == "completed"',
    '.conclusion == "success"',
    ".head_repository.full_name == $repository",
  ];

  if (!/^\s{2}workflow_dispatch:/m.test(triggerBlock)) violations.push("not dispatchable");
  if (/^\s{2}(?:push|pull_request|workflow_run|schedule):/m.test(triggerBlock)) {
    violations.push("has an automatic publication trigger");
  }
  if (!/environment:\s*image-publication/.test(workflow)) {
    violations.push("missing protected publication environment");
  }
  if (!/packages:\s*write/.test(workflow)) violations.push("missing package write permission");
  if (!/actions:\s*read/.test(workflow)) violations.push("missing source artifact read permission");
  for (const check of sourceRunChecks) {
    if (!workflow.includes(check)) violations.push(`missing source-run check: ${check}`);
  }
  if (!/git merge-base --is-ancestor "\$PLATOS_CANDIDATE_SHA" origin\/main/.test(workflow)) {
    violations.push("does not prove the tested commit remains in main history");
  }
  if ((workflow.match(/run-id: \$\{\{ inputs\.source_run_id \}\}/g) ?? []).length !== 3) {
    violations.push("does not bind all candidate, gate, and inventory downloads to the authorized run");
  }
  if (!workflow.includes("prepare-candidate-images.sh")) {
    violations.push("does not reverify candidate archives");
  }
  const normalizedWorkflow = workflow.replace(/\\\n\s*/gu, "").replace(/\s+/gu, " ");
  if ((normalizedWorkflow.match(/node scripts\/verify-webapp-publication-provenance\.mjs /gu) ?? []).length !== 1 ||
      !normalizedWorkflow.includes(publicationValidatorCommand)) {
    violations.push("does not execute the exact webapp publication provenance validator");
  }
  if (/docker\/build-push-action|docker\s+(?:build|compose\s+build)|setup-buildx-action/.test(workflow)) {
    violations.push("rebuilds on the publication path");
  }
  const verification = workflow.indexOf("prepare-candidate-images.sh");
  const provenanceVerification = workflow.indexOf("verify-webapp-publication-provenance.mjs");
  const authentication = workflow.indexOf("docker/login-action");
  if (verification === -1 || provenanceVerification === -1 || authentication === -1 ||
      verification > authentication || provenanceVerification > authentication) {
    violations.push("authenticates before immutable source verification");
  }
  return violations;
}

function triggerReleaseViolations(workflow) {
  const violations = [];
  const validate = jobBlock(workflow, "validate-contract");
  const deploy = jobBlock(workflow, "deploy");
  const promote = jobBlock(workflow, "promote");

  if (/trigger\.dev@[^\s]+\s+(?:deploy|promote)/.test(validate)) {
    violations.push("push-capable validation executes Trigger mutation");
  }
  if (!deploy.includes("if: github.event_name == 'workflow_dispatch'")) {
    violations.push("deployment is not dispatch-only");
  }
  if (!deploy.includes("environment: trigger-deployment")) {
    violations.push("deployment lacks separate protection");
  }
  if (!deploy.includes("deploy --skip-promotion")) {
    violations.push("deployment can implicitly promote");
  }
  if (!promote.includes("inputs.promote_target == true")) {
    violations.push("promotion is not an explicit boolean choice");
  }
  if (!promote.includes("environment: trigger-promotion")) {
    violations.push("promotion lacks separate protection");
  }
  if (!promote.includes('promote "$TARGET_DEPLOYMENT_VERSION"')) {
    violations.push("promotion is not pinned to the deployment output");
  }
  return violations;
}

test("main/v1 push and pull-request image gates cannot write packages or publish to GHCR", () => {
  const buildWorkflow = source(".github/workflows/build-images.yml");

  assert.match(buildWorkflow, /^\s{2}push:\n\s{4}branches: \[main, v1\]/m);
  assert.match(buildWorkflow, /^\s{2}pull_request:\n\s{4}branches: \[main, v1\]/m);
  assert.doesNotMatch(buildWorkflow, /packages:\s*write/);
  assert.doesNotMatch(buildWorkflow, /docker\/login-action/);
  assert.doesNotMatch(buildWorkflow, /regctl image (?:import|copy) "\$staging_ref"/);

  const packageWriters = readdirSync(workflowRoot)
    .filter((name) => name.endsWith(".yml"))
    .filter((name) => /packages:\s*write/.test(source(`.github/workflows/${name}`)));
  assert.deepEqual(packageWriters, ["publish-images.yml"]);
});

test("image publication is protected, dispatch-only, and reuses one successful landed-main run", () => {
  const workflow = source(".github/workflows/publish-images.yml");
  assert.deepEqual(imagePublicationViolations(workflow), []);
  assert.match(
    workflow,
    /pattern: win235-candidate-\*-\$\{\{ inputs\.source_run_id \}\}-\$\{\{ steps\.source-run\.outputs\.run_attempt \}\}/
  );
  assert.match(
    workflow,
    /name: win235-persisted-state-\$\{\{ inputs\.source_run_id \}\}-\$\{\{ steps\.source-run\.outputs\.run_attempt \}\}/
  );
  assert.match(
    workflow,
    /name: win253-webapp-image-inventory-\$\{\{ steps\.webapp-candidate\.outputs\.manifest_digest \}\}-\$\{\{ inputs\.source_run_id \}\}-\$\{\{ steps\.source-run\.outputs\.run_attempt \}\}/
  );
  assert.match(workflow, /candidate_tag="candidate-\$\{SOURCE_RUN_ID\}-\$\{SOURCE_RUN_ATTEMPT\}"/);
  assert.doesNotMatch(workflow, /:latest\b/);
});

test("image authorization checks fail under release-boundary mutations", () => {
  const workflow = source(".github/workflows/publish-images.yml");
  const mutations = [
    mutate(workflow, '.event == "push"', '.event == "pull_request"'),
    mutate(workflow, "environment: image-publication", "environment: unprotected"),
    mutate(workflow, '.conclusion == "success"', '.conclusion != "cancelled"'),
    mutate(workflow, "run-id: ${{ inputs.source_run_id }}", "run-id: ${{ github.run_id }}", { all: true }),
    mutate(
      workflow,
      "node scripts/verify-webapp-publication-provenance.mjs",
      "node -e 0"
    ),
    insertExecutableJobStep(
      workflow,
      "publish-images",
      "      - name: Mutation rebuild\n        run: docker build .\n\n"
    ),
  ];

  for (const mutation of mutations) {
    assert.notDeepEqual(imagePublicationViolations(mutation), []);
  }
});

test("webapp publication validator rejects every mutated provenance binding", async (t) => {
  const valid = publicationProvenanceFixture();
  try {
    const result = valid.run();
    assert.equal(result.status, 0, result.stderr);
    valid.final.imageId = valid.final.candidateManifestDigest;
    valid.final.imageDescriptorDigest = valid.final.candidateManifestDigest;
    const containerdResult = valid.run();
    assert.equal(containerdResult.status, 0, containerdResult.stderr);
  } finally {
    rmSync(valid.root, { recursive: true, force: true });
  }

  const mutations = [
    ["candidate commit identity", ({ identities }) => (identities.commitSha = "b".repeat(40))],
    ["candidate agent identity", ({ identities }) => (identities.agent = identities.webapp)],
    ["candidate webapp identity", ({ identities }) => (identities.webapp = identities.agent)],
    ["candidate migrations identity", ({ identities }) => (identities.migrations = identities.agent)],
    ["evidence schema", ({ production }) => (production.$schema = "disabled")],
    ["evidence stage", ({ production }) => (production.stage = "final")],
    ["source run ID", ({ production }) => (production.sourceRunId = "999999")],
    ["source run attempt", ({ production }) => (production.sourceRunAttempt = "3")],
    ["candidate manifest digest", ({ production }) => (production.candidateManifestDigest = `sha256:${"8".repeat(64)}`)],
    ["candidate config digest", ({ production }) => (production.candidateConfigDigest = `sha256:${"8".repeat(64)}`)],
    ["candidate archive checksum", ({ production }) => (production.candidateArchiveSha256 = "8".repeat(64))],
    ["target platform", ({ production }) => (production.platform = "linux/arm64")],
    ["Git revision", ({ production }) => (production.gitHead = "b".repeat(40))],
    ["image revision label", ({ production }) => (production.imageRevisionLabel = "b".repeat(40))],
    ["image build-input label", ({ production }) => (production.imageBuildInputsLabel = "8".repeat(64))],
    ["evidence build-input hash", ({ production }) => (production.buildInputsSha256 = "8".repeat(64))],
    ["inventory byte equality", ({ production }) => (production.inventoryByteMatch = false)],
    ["inventory hash equality", ({ production }) => (production.generatedInventorySha256 = "8".repeat(64))],
    [
      "final image and claimed config identity drift together",
      ({ final }) => {
        final.imageId = `sha256:${"8".repeat(64)}`;
        final.candidateConfigDigest = final.imageId;
      },
    ],
    [
      "descriptor-bound manifest identity lacks descriptor",
      ({ final }) => {
        final.imageId = final.candidateManifestDigest;
        final.imageDescriptorDigest = null;
      },
    ],
    [
      "descriptor-bound manifest identity has mismatched descriptor",
      ({ final }) => {
        final.imageId = final.candidateManifestDigest;
        final.imageDescriptorDigest = `sha256:${"8".repeat(64)}`;
      },
    ],
    ["distinct production and final images", ({ production, final }) => (final.imageId = production.imageId)],
  ];

  for (const [name, mutateFixture] of mutations) {
    await t.test(name, () => {
      const fixture = publicationProvenanceFixture();
      try {
        mutateFixture(fixture);
        const result = fixture.run();
        assert.notEqual(result.status, 0, `${name} mutation must fail`);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("Trigger pushes validate only; deployment and promotion require separate authorization", () => {
  const workflow = source(".github/workflows/trigger-deploy.yml");
  assert.match(workflow, /^\s{2}push:\n\s{4}branches: \[main\]/m);
  assert.deepEqual(triggerReleaseViolations(workflow), []);
});

test("Trigger release authorization checks fail under mutation", () => {
  const workflow = source(".github/workflows/trigger-deploy.yml");
  const mutations = [
    mutate(workflow, "if: github.event_name == 'workflow_dispatch'", "if: github.ref == 'refs/heads/main'"),
    mutate(workflow, "environment: trigger-deployment", "environment: trigger-promotion"),
    mutate(workflow, "deploy --skip-promotion", "deploy"),
    mutate(workflow, "inputs.promote_target == true", "inputs.promote_target != false"),
    mutate(workflow, "environment: trigger-promotion", "environment: trigger-deployment"),
  ];

  for (const mutation of mutations) {
    assert.notDeepEqual(triggerReleaseViolations(mutation), []);
  }
});
