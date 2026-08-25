#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPerformanceVerificationReceipt,
  PERFORMANCE_ARTIFACT_FILE,
  PERFORMANCE_RECEIPT_FILE,
  verifyPerformanceVerificationReceipt,
} from "./performance-verification-receipt.mjs";

const DEFAULT_ARTIFACT_DIRECTORY = "artifacts/win235";
const DEFAULT_BUDGET_FILE = "tests/persisted-state-gate/budgets.v1.json";
const MEMORY_BROWSER_METRICS = ["fcpMs", "lcpMs", "cls", "inpMs", "interactionLatencyMs"];
const AGENT_BROWSER_METRICS = ["inpMs", "interactionLatencyMs"];
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function verifyPerformanceArtifactDirectory(directory, options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? path.join(import.meta.dirname, "../..")
  );
  const root = path.resolve(directory);
  const budgetPath = path.resolve(repositoryRoot, options.budgetsPath ?? DEFAULT_BUDGET_FILE);
  const budgetSchemaPath = path.resolve(
    repositoryRoot,
    "tests/persisted-state-gate/budgets.schema.json"
  );
  const artifactSchemaPath = path.resolve(
    repositoryRoot,
    "tests/persisted-state-gate/performance-artifact.schema.json"
  );
  const receiptSchemaPath = path.resolve(
    repositoryRoot,
    "tests/persisted-state-gate/performance-verification-receipt.schema.json"
  );
  const receiptPath = path.join(root, PERFORMANCE_RECEIPT_FILE);
  await rm(receiptPath, { force: true });
  const [
    performanceArtifactRaw,
    fixture,
    candidateImages,
    budgetRaw,
    budgetSchema,
    artifactSchema,
    receiptSchema,
  ] = await Promise.all([
    readFile(path.join(root, PERFORMANCE_ARTIFACT_FILE), "utf8"),
    readJson(path.join(root, "fixture-manifest.json")),
    readJson(path.join(root, "candidate-images.json")),
    readFile(budgetPath, "utf8"),
    readJson(budgetSchemaPath),
    readJson(artifactSchemaPath),
    readJson(receiptSchemaPath),
  ]);
  const artifact = JSON.parse(performanceArtifactRaw);
  const budgets = JSON.parse(budgetRaw);
  validateSchemas(repositoryRoot, [
    ["performance budget", budgetSchema, budgets],
    ["performance artifact", artifactSchema, artifact],
  ]);
  verifyBudgetConsistency(budgets);
  verifySecretSafety(artifact, options.sensitiveValues);
  const expectedCommit =
    options.expectedCommit ??
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();

  if (options.inspectSourceCheckout !== false) {
    verifySourceCheckout(repositoryRoot, expectedCommit);
  }
  verifyTopLevel(artifact, budgets, budgetRaw, fixture, candidateImages, expectedCommit);
  if (options.inspectRuntimeCandidates !== false) {
    verifyRunningRuntimeCandidates(repositoryRoot, artifact.runtime.candidates);
  }
  verifyLatency(artifact.measurements.latency, budgets);
  verifyBrowser(artifact.measurements.browser, budgets);
  verifyBundles(artifact.measurements.bundles, budgets);
  verifyMemory(artifact.measurements.memory, budgets, candidateImages, artifact.runtime.candidates);
  verifyQueriesAndPlans(
    artifact.measurements.queries,
    artifact.measurements.plans,
    budgets,
    fixture
  );

  const receipt = createPerformanceVerificationReceipt(artifact, performanceArtifactRaw);
  validateSchemas(repositoryRoot, [["performance verification receipt", receiptSchema, receipt]]);
  verifyPerformanceVerificationReceipt(receipt, performanceArtifactRaw, expectedCommit);
  await writeJsonAtomically(receiptPath, receipt);

  return {
    commitSha: artifact.commitSha,
    fixtureSha256: artifact.fixture.sha256,
    latencyPaths: artifact.measurements.latency.length,
    plans: artifact.measurements.plans.length,
    receiptFile: PERFORMANCE_RECEIPT_FILE,
  };
}

function verifySourceCheckout(repositoryRoot, expectedCommit) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  assert.equal(head, expectedCommit, "git HEAD does not equal the tested commit");
  for (const args of [
    ["diff", "--quiet"],
    ["diff", "--cached", "--quiet"],
  ]) {
    try {
      execFileSync("git", args, { cwd: repositoryRoot, stdio: "ignore" });
    } catch {
      throw new Error("tracked worktree and index must be clean for artifact verification");
    }
  }
  assert.equal(
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    "",
    "tracked worktree and index must be clean for artifact verification"
  );
}

function verifyRunningRuntimeCandidates(repositoryRoot, candidates) {
  for (const [service, candidate] of Object.entries(candidates)) {
    const composeContainerId = execFileSync("docker", ["compose", "ps", "--quiet", service], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    assert.equal(
      composeContainerId,
      candidate.containerId,
      `${service} Compose container ID drifted`
    );
    const container = JSON.parse(
      execFileSync("docker", ["inspect", candidate.containerId], { encoding: "utf8" })
    )[0];
    const image = JSON.parse(
      execFileSync("docker", ["image", "inspect", candidate.runtimeReference], {
        encoding: "utf8",
      })
    )[0];
    assert.ok(container, `${service} running container inspection is unavailable`);
    assert.ok(image, `${service} runtime image inspection is unavailable`);
    assert.equal(container.State?.Running, true, `${service} candidate container is not running`);
    assert.equal(
      container.Config.Image,
      candidate.runtimeReference,
      `${service} live reference drifted`
    );
    assert.equal(container.Image, candidate.imageId, `${service} live container image ID drifted`);
    assert.equal(image.Id, candidate.imageId, `${service} live image ID drifted`);
    const revision = image.Config?.Labels?.["org.opencontainers.image.revision"];
    assert.equal(revision, candidate.revision, `${service} live OCI revision drifted`);
    const config = {
      architecture: image.Architecture,
      os: image.Os,
      entrypoint: image.Config?.Entrypoint ?? [],
      command: image.Config?.Cmd ?? [],
      workingDirectory: image.Config?.WorkingDir ?? "",
      user: image.Config?.User ?? "",
      revision,
    };
    assert.deepEqual(config, candidate.config, `${service} live OCI config drifted`);
    assert.equal(
      sha256(JSON.stringify(config)),
      candidate.configSha256,
      `${service} live OCI config hash drifted`
    );
  }
}

function verifyBudgetConsistency(budgets) {
  for (const [family, contracts] of [
    ["latency", budgets.latency],
    ["bundles", budgets.bundles],
    ["memory", budgets.memory],
    ["queries", budgets.queries],
  ]) {
    assert.equal(
      new Set(contracts.map(({ id }) => id)).size,
      contracts.length,
      `${family} budget IDs must be unique`
    );
  }
  for (const budget of budgets.latency) {
    assert.ok(budget.p95Maximum >= budget.p50Maximum, `${budget.id} p95 must not be below p50`);
  }
  for (const browser of Object.values(budgets.browser)) {
    for (const [metric, ceiling] of Object.entries(browser.metrics)) {
      assert.ok(
        ceiling.p95Maximum >= ceiling.p50Maximum,
        `${browser.id}.${metric} p95 must not be below p50`
      );
    }
  }
  for (const budget of budgets.queries) {
    assert.ok(
      budget.densePageSize > budget.smallPageSize,
      `${budget.id} dense page must exceed its small page`
    );
  }
}

function validateSchemas(repositoryRoot, contracts) {
  const require = createRequire(import.meta.url);
  const ajvPath = require.resolve("ajv/dist/2020", {
    paths: [path.join(repositoryRoot, "apps/agent")],
  });
  const Ajv2020 = require(ajvPath).default;
  const ajv = new Ajv2020({ allErrors: true, strict: true, verbose: false });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value) => Number.isFinite(Date.parse(value)),
  });
  ajv.addFormat("uuid", { type: "string", validate: (value) => UUID_PATTERN.test(value) });
  for (const [name, schema, value] of contracts) {
    const validate = ajv.compile(schema);
    assert.ok(validate(value), `${name} JSON Schema violation: ${ajv.errorsText(validate.errors)}`);
  }
}

function verifyTopLevel(artifact, budgets, budgetRaw, fixture, candidateImages, expectedCommit) {
  assert.equal(artifact.schemaVersion, 1, "unexpected performance artifact schema version");
  assert.equal(artifact.gate, "win235-measured-performance", "unexpected performance gate name");
  assert.equal(artifact.status, "measured", "performance artifact is not measured");
  assert.match(artifact.commitSha, /^[a-f0-9]{40}$/, "performance commit is not an exact SHA");
  assert.equal(
    artifact.commitSha,
    expectedCommit,
    "performance artifact is not bound to tested commit"
  );
  assert.equal(
    candidateImages.commitSha,
    expectedCommit,
    "candidate image manifest is not bound to tested commit"
  );
  assert.equal(budgets.schemaVersion, 1, "unexpected performance budget schema version");
  assert.equal(budgets.contract, artifact.gate, "budget contract and performance gate differ");
  assert.equal(budgets.measurementPolicy.serial, true, "measurements must run serially");
  assert.deepEqual(
    artifact.budgetContract,
    {
      file: DEFAULT_BUDGET_FILE,
      schemaVersion: budgets.schemaVersion,
      sha256: sha256(budgetRaw),
    },
    "artifact is not bound to the exact versioned budget contract"
  );

  const { sha256: fixtureDigest, ...fixtureBody } = fixture;
  assert.equal(
    fixtureDigest,
    sha256(`${JSON.stringify(fixtureBody, null, 2)}\n`),
    "fixture manifest SHA-256 does not match its canonical body"
  );
  assert.deepEqual(artifact.fixture.counts, fixture.counts, "performance fixture counts drifted");
  assert.equal(artifact.fixture.schemaVersion, fixture.schemaVersion, "fixture schema drifted");
  assert.equal(artifact.fixture.sha256, fixture.sha256, "fixture identity drifted");
  assert.equal(artifact.fixture.schemaVersion, budgets.fixture.schemaVersion);
  for (const [key, value] of Object.entries(budgets.fixture.requiredCounts)) {
    assert.equal(fixture.counts[key], value, `fixture count ${key} drifted`);
  }
  assert.deepEqual(
    artifact.fixture.turnsPerThread,
    Array(fixture.counts.threads).fill(budgets.fixture.turnsPerThread),
    "thread density was not measured at 60 Turns per Thread"
  );

  const expectedImages = {
    agent: candidateImages.agent,
    webapp: candidateImages.webapp,
    migrations: candidateImages.migrations,
  };
  assert.deepEqual(
    artifact.images,
    expectedImages,
    "performance artifact candidate identity drifted"
  );
  for (const [name, image] of Object.entries(expectedImages)) {
    assert.match(
      image,
      /^ghcr\.io\/.+@sha256:[a-f0-9]{64}$/,
      `${name} is not an immutable candidate digest`
    );
  }
  assert.equal(artifact.runtime.serial, true, "runtime did not declare serial measurement");
  assert.ok(typeof artifact.runtime.chromium === "string" && artifact.runtime.chromium.length > 0);
  verifyRuntimeCandidate(
    "agent",
    artifact.runtime.candidates.agent,
    expectedImages.agent,
    expectedCommit
  );
  verifyRuntimeCandidate(
    "webapp",
    artifact.runtime.candidates.webapp,
    expectedImages.webapp,
    expectedCommit
  );
}

function verifyRuntimeCandidate(service, candidate, logicalImage, expectedCommit) {
  const manifestDigest = logicalImage.slice(logicalImage.indexOf("@") + 1);
  const repositoryName = service === "agent" ? "platos-agent" : "platos-webapp";
  assert.equal(
    candidate.manifestDigest,
    manifestDigest,
    `${service} runtime manifest digest drifted`
  );
  assert.equal(
    candidate.runtimeReference,
    `win235.local/${repositoryName}:sha256-${manifestDigest.slice("sha256:".length)}`,
    `${service} runtime reference drifted`
  );
  assert.equal(candidate.revision, expectedCommit, `${service} runtime revision drifted`);
  assert.equal(candidate.config.revision, expectedCommit, `${service} OCI config revision drifted`);
  assert.equal(
    candidate.configSha256,
    sha256(JSON.stringify(candidate.config)),
    `${service} OCI config hash drifted`
  );
}

function verifyLatency(measurements, budgets) {
  assertExactIds(measurements, budgets.latency, "latency");
  for (const budget of budgets.latency) {
    const measurement = byId(measurements, budget.id);
    assert.equal(measurement.unit, budget.unit, `${budget.id} latency unit drifted`);
    verifyRawSamples(
      measurement.warmupSamples,
      budgets.measurementPolicy.latencyWarmupSamples,
      `${budget.id} warmup`
    );
    verifyRawSamples(
      measurement.samples,
      budgets.measurementPolicy.latencyMeasuredSamples,
      `${budget.id} samples`
    );
    assertSummary(measurement.summary, measurement.samples, budget.id);
    assert.ok(measurement.summary.p50 <= budget.p50Maximum, `${budget.id} p50 budget exceeded`);
    assert.ok(measurement.summary.p95 <= budget.p95Maximum, `${budget.id} p95 budget exceeded`);
  }
}

function verifyBrowser(measurements, budgets) {
  verifyBrowserMeasurement(
    measurements.memories,
    budgets.browser.memories,
    MEMORY_BROWSER_METRICS,
    budgets.measurementPolicy,
    true
  );
  verifyBrowserMeasurement(
    measurements.agentsInteraction,
    budgets.browser.agentsInteraction,
    AGENT_BROWSER_METRICS,
    budgets.measurementPolicy,
    false
  );
}

function verifyBrowserMeasurement(measurement, budget, metrics, policy, memories) {
  assert.equal(measurement.id, budget.id, `${budget.id} browser identity drifted`);
  assert.equal(
    measurement.engine,
    "chromium",
    `${budget.id} evidence was not captured in Chromium`
  );
  if (memories) {
    assert.equal(
      measurement.navigation,
      "fresh-context-direct",
      "Memories samples were not direct fresh-context navigations"
    );
  }
  assert.equal(
    measurement.warmupSamples.length,
    policy.browserWarmupSamples,
    `${budget.id} browser warmup count drifted`
  );
  assert.equal(
    measurement.samples.length,
    policy.browserMeasuredSamples,
    `${budget.id} browser sample count drifted`
  );
  const requiredKeys = memories ? [...metrics, "renderedRows"] : metrics;
  for (const [index, sample] of [...measurement.warmupSamples, ...measurement.samples].entries()) {
    assert.deepEqual(
      Object.keys(sample).sort(),
      [...requiredKeys].sort(),
      `${budget.id} browser sample ${index} is missing a required metric`
    );
    for (const metric of metrics) {
      assertFiniteNonNegative(sample[metric], `${budget.id} sample ${index}.${metric}`);
      if (metric !== "cls") {
        assert.ok(sample[metric] > 0, `${budget.id} sample ${index}.${metric} is unmeasured`);
      }
    }
    if (memories) {
      assert.ok(
        Number.isInteger(sample.renderedRows) && sample.renderedRows >= budget.minimumRenderedRows,
        `${budget.id} sample ${index} did not render the dense fixture`
      );
    }
  }
  for (const metric of requiredKeys) {
    assertSummary(
      measurement.summary[metric],
      measurement.samples.map((sample) => sample[metric]),
      `${budget.id}.${metric}`
    );
    if (metric !== "renderedRows") {
      assert.ok(
        measurement.summary[metric].p50 <= budget.metrics[metric].p50Maximum,
        `${budget.id}.${metric} p50 budget exceeded`
      );
      assert.ok(
        measurement.summary[metric].p95 <= budget.metrics[metric].p95Maximum,
        `${budget.id}.${metric} p95 budget exceeded`
      );
    }
  }
}

function verifyBundles(measurements, budgets) {
  assertExactIds(measurements, budgets.bundles, "bundle");
  for (const budget of budgets.bundles) {
    const measurement = byId(measurements, budget.id);
    assert.equal(measurement.unit, "bytes");
    assert.equal(
      measurement.warmupSamples.length,
      budgets.measurementPolicy.browserWarmupSamples,
      `${budget.id} warmup bundle count drifted`
    );
    assert.equal(
      measurement.samples.length,
      budgets.measurementPolicy.browserMeasuredSamples,
      `${budget.id} bundle count drifted`
    );
    for (const sample of [...measurement.warmupSamples, ...measurement.samples]) {
      assert.ok(
        Number.isInteger(sample.loadedBytes) && sample.loadedBytes > 0,
        `${budget.id} is unmeasured`
      );
      const uniqueUrls = new Set(sample.resources.map((resource) => resource.url));
      assert.equal(
        uniqueUrls.size,
        sample.resources.length,
        `${budget.id} double-counts a resource`
      );
      assert.equal(
        sample.loadedBytes,
        sample.resources.reduce((total, resource) => total + resource.bodyBytes, 0),
        `${budget.id} loaded byte total does not match actual response bodies`
      );
    }
    assertSummary(
      measurement.summary,
      measurement.samples.map((sample) => sample.loadedBytes),
      budget.id
    );
    assert.ok(measurement.summary.p95 <= budget.p95Maximum, `${budget.id} p95 budget exceeded`);
  }
}

function verifyMemory(measurements, budgets, candidateImages, runtimeCandidates) {
  assertExactIds(measurements, budgets.memory, "memory");
  const identityById = {
    "agent.candidate-memory": {
      logical: candidateImages.agent,
      runtime: runtimeCandidates.agent,
    },
    "webapp.candidate-memory": {
      logical: candidateImages.webapp,
      runtime: runtimeCandidates.webapp,
    },
  };
  for (const budget of budgets.memory) {
    const measurement = byId(measurements, budget.id);
    const identity = identityById[budget.id];
    assert.ok(identity, `${budget.id} has no runtime candidate identity`);
    assert.equal(measurement.unit, "bytes");
    assert.equal(
      measurement.containerId,
      identity.runtime.containerId,
      `${budget.id} container drifted`
    );
    assert.equal(
      measurement.candidateImage,
      identity.logical,
      `${budget.id} image identity drifted`
    );
    assert.equal(
      measurement.runtimeImageId,
      identity.runtime.imageId,
      `${budget.id} runtime image ID drifted`
    );
    assert.equal(
      measurement.samples.length,
      budgets.measurementPolicy.memoryMeasuredSamples,
      `${budget.id} sample count drifted`
    );
    for (const sample of measurement.samples) {
      assert.ok(Number.isInteger(sample.containerBytes) && sample.containerBytes > 0);
      assert.ok(Number.isInteger(sample.processRssBytes) && sample.processRssBytes > 0);
      assert.equal(
        sample.runtimeImageId,
        identity.runtime.imageId,
        `${budget.id} sample image drifted`
      );
    }
    for (const metric of ["containerBytes", "processRssBytes"]) {
      assertSummary(
        measurement.summary[metric],
        measurement.samples.map((sample) => sample[metric]),
        `${budget.id}.${metric}`
      );
    }
    assert.ok(
      measurement.summary.containerBytes.p95 <= budget.containerP95Maximum,
      `${budget.id} container p95 budget exceeded`
    );
    assert.ok(
      measurement.summary.processRssBytes.p95 <= budget.processRssP95Maximum,
      `${budget.id} process RSS p95 budget exceeded`
    );
  }
}

function verifyQueriesAndPlans(measurements, plans, budgets, fixture) {
  assertExactIds(measurements, budgets.queries, "query");
  const primary = fixture.scopes?.[0];
  assert.ok(primary, "fixture manifest has no primary scope for request binding");
  let expectedPlanCount = 0;
  for (const budget of budgets.queries) {
    const measurement = byId(measurements, budget.id);
    assert.equal(measurement.requestPath, budget.requestPath, `${budget.id} request path drifted`);
    assert.equal(
      measurement.fixtureRows,
      fixture.counts[budget.fixtureCountKey],
      `${budget.id} fixture density drifted`
    );
    assert.equal(measurement.smallPageSize, budget.smallPageSize);
    assert.equal(measurement.densePageSize, budget.densePageSize);
    verifyCandidateRequest(
      measurement.smallRequest,
      expectedRequestPath(primary, budget.requestPath, budget.smallPageSize),
      `${budget.id} small`
    );
    verifyCandidateRequest(
      measurement.denseRequest,
      expectedRequestPath(primary, budget.requestPath, budget.densePageSize),
      `${budget.id} dense`
    );
    assert.notEqual(
      measurement.smallRequest.requestId,
      measurement.denseRequest.requestId,
      `${budget.id} reused a request correlation ID`
    );
    assert.equal(
      measurement.nPlusOneGrowth,
      Math.max(0, measurement.denseRequest.queryCount - measurement.smallRequest.queryCount),
      `${budget.id} N+1 summary is not derived from candidate request counts`
    );
    assert.ok(
      measurement.denseRequest.queryCount <= budget.maximumQueryCount,
      `${budget.id} query-count ceiling exceeded`
    );
    assert.ok(
      measurement.nPlusOneGrowth <= budget.maximumNPlusOneGrowth,
      `${budget.id} exhibits N+1 query growth`
    );
    assert.ok(measurement.denseResultRows <= measurement.densePageSize);
    assert.ok(measurement.denseTotalRows > measurement.denseResultRows);
    assert.equal(measurement.fullDatasetHydration, false, `${budget.id} hydrated its full dataset`);

    const queryPlans = plans.filter((plan) => plan.queryId === budget.id);
    expectedPlanCount += measurement.denseRequest.queries.length;
    assert.equal(
      queryPlans.length,
      measurement.denseRequest.queries.length,
      `${budget.id} plans do not map exactly to dense candidate queries`
    );
    for (const query of measurement.denseRequest.queries) {
      const matches = queryPlans.filter((plan) => plan.querySequence === query.sequence);
      assert.equal(
        matches.length,
        1,
        `${budget.id} query ${query.sequence} must have exactly one plan`
      );
      verifyPlan(matches[0], query, measurement.denseRequest, budget);
    }
  }
  assert.equal(plans.length, expectedPlanCount, "required EXPLAIN plan count drifted");
  for (const plan of plans) {
    assert.ok(
      budgets.queries.some((budget) => budget.id === plan.queryId),
      `${plan.id} is orphaned`
    );
  }
}

function verifyCandidateRequest(request, expectedPath, label) {
  assert.match(request.requestId, UUID_PATTERN, `${label} request ID is invalid`);
  assert.equal(request.method, "GET", `${label} was not a GET request`);
  assert.equal(request.path, expectedPath, `${label} candidate request path drifted`);
  assert.equal(request.statusCode, 200, `${label} candidate request failed`);
  assertFinitePositive(request.durationMs, `${label} request duration`);
  assert.equal(request.correlationStatus, "bound", `${label} query correlation was ambiguous`);
  assert.equal(
    request.queryCount,
    request.queries.length,
    `${label} query count is not raw evidence`
  );
  assert.ok(request.queryCount > 0, `${label} query evidence is unmeasured`);
  for (const [index, query] of request.queries.entries()) {
    assert.equal(query.sequence, index + 1, `${label} query sequence drifted`);
    assertFiniteNonNegative(query.durationMs, `${label} query ${query.sequence} duration`);
    assert.equal(
      query.correlation,
      "request-bound-prisma-extension",
      `${label} query correlation drifted`
    );
    assert.equal(
      query.replayable,
      true,
      `${label} query ${query.sequence} is redacted/non-replayable`
    );
    assert.match(query.normalizedSql, /^SELECT\b/i, `${label} query is not replayable SELECT SQL`);
    assert.equal(
      query.normalizedSql,
      normalizeSql(query.normalizedSql),
      `${label} SQL is not normalized`
    );
    assert.equal(
      query.normalizedSqlSha256,
      sha256(query.normalizedSql),
      `${label} SQL hash drifted`
    );
    assert.equal(
      query.parametersSha256,
      sha256(JSON.stringify(query.parameters)),
      `${label} parameter hash drifted`
    );
    assert.equal(
      query.parameterMetadata.length,
      query.parameters.length,
      `${label} parameter metadata drifted`
    );
  }
}

function verifyPlan(evidence, query, request, budget) {
  assert.equal(evidence.requestId, request.requestId, `${evidence.id} request ID drifted`);
  assert.equal(evidence.requestPath, request.path, `${evidence.id} request path drifted`);
  assert.equal(evidence.querySequence, query.sequence, `${evidence.id} query sequence drifted`);
  assert.equal(evidence.source, "candidate-request-prisma-query", `${evidence.id} source drifted`);
  assert.equal(evidence.candidateDurationMs, query.durationMs, `${evidence.id} duration drifted`);
  assert.equal(evidence.normalizedSql, query.normalizedSql, `${evidence.id} SQL drifted`);
  assert.equal(
    evidence.normalizedSqlSha256,
    query.normalizedSqlSha256,
    `${evidence.id} SQL hash drifted`
  );
  assert.deepEqual(evidence.parameters, query.parameters, `${evidence.id} parameters drifted`);
  assert.equal(
    evidence.parametersSha256,
    query.parametersSha256,
    `${evidence.id} parameter hash drifted`
  );
  assert.deepEqual(
    evidence.parameterMetadata,
    query.parameterMetadata,
    `${evidence.id} metadata drifted`
  );
  assert.equal(
    evidence.correlation,
    "request-bound-prisma-extension",
    `${evidence.id} correlation drifted`
  );
  assert.deepEqual(evidence.options, ["ANALYZE", "BUFFERS", "FORMAT JSON"]);
  assert.deepEqual(evidence.settings, { statementTimeoutMs: 15_000, enableSeqscan: false });

  const rootEnvelope = Array.isArray(evidence.plan) ? evidence.plan[0] : null;
  const rootPlan = rootEnvelope?.Plan;
  assert.ok(rootPlan && typeof rootPlan === "object", `${evidence.id} has no PostgreSQL root Plan`);
  const planNodes = collectPlanNodes(rootPlan);
  assert.ok(planNodes.length > 0, `${evidence.id} has no executed plan nodes`);
  const rowsRemoved = [];
  const sharedReadBlocks = [];
  let bufferFields = 0;
  for (const node of planNodes) {
    assert.ok(
      !budget.forbiddenScanNodeTypes.includes(node["Node Type"]),
      `${evidence.id} contains forbidden ${node["Node Type"]}`
    );
    assertFiniteNonNegative(node["Actual Rows"], `${evidence.id} Actual Rows`);
    assertFiniteNonNegative(node["Actual Loops"], `${evidence.id} Actual Loops`);
    assert.ok(
      node["Actual Rows"] <= budget.maximumPlanActualRows,
      `${evidence.id} plan row ceiling exceeded`
    );
    assert.ok(
      node["Actual Loops"] <= budget.maximumActualLoops,
      `${evidence.id} actual loops ceiling exceeded`
    );
    const removed = node["Rows Removed by Filter"] ?? 0;
    assertFiniteNonNegative(removed, `${evidence.id} Rows Removed by Filter`);
    rowsRemoved.push(removed);
    for (const [key, value] of Object.entries(node)) {
      if (/Blocks$/.test(key)) {
        assertFiniteNonNegative(value, `${evidence.id} ${key}`);
        bufferFields += 1;
      }
      if (key === "Shared Read Blocks") sharedReadBlocks.push(value);
      if (/(?:Time|Rows|Loops|Blocks)$/.test(key)) {
        assertFiniteNonNegative(value, `${evidence.id} ${key}`);
      }
    }
  }
  assert.ok(bufferFields > 0, `${evidence.id} did not capture BUFFERS evidence`);
  assert.ok(sharedReadBlocks.length > 0, `${evidence.id} has no Shared Read Blocks evidence`);
  assert.ok(
    Math.max(...rowsRemoved, 0) <= budget.maximumRowsRemovedByFilter,
    `${evidence.id} rows removed by filter ceiling exceeded`
  );
  assert.ok(
    sharedReadBlocks.reduce((total, value) => total + value, 0) <= budget.maximumSharedReadBlocks,
    `${evidence.id} shared read blocks ceiling exceeded`
  );
  assertFiniteNonNegative(rootEnvelope["Planning Time"], `${evidence.id} Planning Time`);
  assertFiniteNonNegative(rootEnvelope["Execution Time"], `${evidence.id} Execution Time`);
  assert.ok(
    rootEnvelope["Planning Time"] <= budget.maximumPlanningTimeMs,
    `${evidence.id} planning time ceiling exceeded`
  );
  assert.ok(
    rootEnvelope["Execution Time"] <= budget.maximumExecutionTimeMs,
    `${evidence.id} execution time ceiling exceeded`
  );
}

function expectedRequestPath(primary, requestPath, pageSize) {
  const url = new URL(requestPath, "http://candidate.invalid");
  if (requestPath === "/api/v1/agent/agents") {
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", "0");
  } else {
    url.searchParams.set("userId", primary.endUserId);
    if (requestPath === "/api/v1/memory") url.searchParams.set("agentId", primary.agentIds[0]);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", "0");
  }
  return `${url.pathname}${url.search}`;
}

function verifySecretSafety(artifact, additionalSensitiveValues = []) {
  const sensitiveValues = new Set(
    [...configuredSensitiveValues(), ...additionalSensitiveValues]
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length >= 4)
  );
  walkArtifact(artifact, "$", (key, value, location) => {
    const normalizedKey = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    assert.ok(
      !/^(?:authorization|cookie|setcookie|password|passwd|token|secret|clientsecret|apikey|encryptionkey|databaseurl|credentials?)$/.test(
        normalizedKey
      ),
      `performance artifact contains forbidden secret-bearing key at ${location}`
    );
    if (typeof value !== "string") return;
    assert.doesNotMatch(
      value,
      /\bBearer\s+\S+/i,
      `performance artifact contains bearer material at ${location}`
    );
    assert.doesNotMatch(
      value,
      /\bsk-[A-Za-z0-9_-]{8,}/,
      `performance artifact contains API key material at ${location}`
    );
    for (const secret of sensitiveValues) {
      assert.ok(
        !value.includes(secret),
        `performance artifact contains configured sensitive material at ${location}`
      );
    }
  });
}

function configuredSensitiveValues() {
  const values = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      /(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|ENCRYPTION_KEY|API_KEY)(?:__.*)?$/i.test(name)
    ) {
      values.push(value);
    }
  }
  for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
    const value = process.env[name];
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.password) values.push(decodeURIComponent(url.password));
    } catch {
      // The complete configured value is still compared above.
    }
  }
  return values;
}

function walkArtifact(value, location, visit) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      visit(String(index), item, `${location}[${index}]`);
      walkArtifact(item, `${location}[${index}]`, visit);
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visit(key, item, `${location}.${key}`);
      walkArtifact(item, `${location}.${key}`, visit);
    }
  }
}

export function summarize(samples) {
  assert.ok(Array.isArray(samples) && samples.length > 0, "summary input is absent");
  for (const [index, value] of samples.entries()) {
    assertFiniteNonNegative(value, `summary input[${index}]`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: sorted[Math.ceil(0.5 * sorted.length) - 1],
    p95: sorted[Math.ceil(0.95 * sorted.length) - 1],
  };
}

function assertSummary(actual, samples, label) {
  assert.deepEqual(
    actual,
    summarize(samples),
    `${label} p50/p95 summary does not match raw samples`
  );
}

function verifyRawSamples(samples, expectedCount, label) {
  assert.ok(Array.isArray(samples), `${label} are absent`);
  assert.equal(samples.length, expectedCount, `${label} count drifted`);
  for (const [index, value] of samples.entries()) {
    assertFinitePositive(value, `${label}[${index}]`);
  }
}

function assertFinitePositive(value, label) {
  assert.ok(Number.isFinite(value) && value > 0, `${label} must be a positive measured number`);
}

function assertFiniteNonNegative(value, label) {
  assert.ok(Number.isFinite(value) && value >= 0, `${label} must be a finite measured number`);
}

function assertExactIds(measurements, contracts, label) {
  assert.deepEqual(
    measurements.map(({ id }) => id).sort(),
    contracts.map(({ id }) => id).sort(),
    `${label} measurement IDs drifted`
  );
}

function byId(values, id) {
  const matches = values.filter((value) => value.id === id);
  assert.equal(matches.length, 1, `${id} must be measured exactly once`);
  return matches[0];
}

function collectPlanNodes(root) {
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (typeof node["Node Type"] === "string") nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  return nodes;
}

function normalizeSql(sql) {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJsonAtomically(file, value) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryFile, file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const positional = process.argv.slice(2).filter((argument) => argument !== "--");
  assert.ok(positional.length <= 1, "usage: verify-performance-artifacts.mjs [artifact-directory]");
  const result = await verifyPerformanceArtifactDirectory(
    path.resolve(positional[0] ?? process.env.WIN235_ARTIFACT_DIR ?? DEFAULT_ARTIFACT_DIRECTORY)
  );
  process.stdout.write(
    `WIN-235 measured performance verified for ${result.commitSha} (${result.latencyPaths} paths, ${result.plans} plans)\n`
  );
}
