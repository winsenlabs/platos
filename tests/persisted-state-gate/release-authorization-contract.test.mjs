import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const workflowRoot = path.join(repositoryRoot, ".github/workflows");

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
  if ((workflow.match(/run-id: \$\{\{ inputs\.source_run_id \}\}/g) ?? []).length !== 2) {
    violations.push("does not bind both downloads to the authorized run");
  }
  if (!workflow.includes("prepare-candidate-images.sh")) {
    violations.push("does not reverify candidate archives");
  }
  if (!workflow.includes("publication sources do not match the passing persisted-state identities")) {
    violations.push("does not bind publication to passing identity evidence");
  }
  if (/docker\/build-push-action|docker\s+(?:build|compose\s+build)|setup-buildx-action/.test(workflow)) {
    violations.push("rebuilds on the publication path");
  }
  const verification = workflow.indexOf("prepare-candidate-images.sh");
  const authentication = workflow.indexOf("docker/login-action");
  if (verification === -1 || authentication === -1 || verification > authentication) {
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
