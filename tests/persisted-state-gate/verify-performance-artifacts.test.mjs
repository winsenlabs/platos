import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  PERFORMANCE_RECEIPT_FILE,
  verifyPerformanceVerificationReceipt,
} from "./performance-verification-receipt.mjs";
import { summarize, verifyPerformanceArtifactDirectory } from "./verify-performance-artifacts.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const budgetFile = path.join(repositoryRoot, "tests/persisted-state-gate/budgets.v1.json");
const commitSha = "1".repeat(40);
const ids = {
  organizationId: "11111111-1111-4111-8111-111111111101",
  projectId: "11111111-1111-4111-8111-111111111102",
  environmentId: "11111111-1111-4111-8111-111111111103",
  operatorId: "11111111-1111-4111-8111-111111111104",
  endUserId: "11111111-1111-4111-8111-111111111105",
  agentId: "11111111-1111-4111-8111-111111111106",
  threadId: "11111111-1111-4111-8111-111111111107",
};
const images = {
  agent: `ghcr.io/winsenlabs/platos-agent@sha256:${"a".repeat(64)}`,
  webapp: `ghcr.io/winsenlabs/platos-webapp@sha256:${"b".repeat(64)}`,
  migrations: `ghcr.io/winsenlabs/platos-migrations@sha256:${"c".repeat(64)}`,
};
const runtimeImageIds = {
  agent: `sha256:${"d".repeat(64)}`,
  webapp: `sha256:${"e".repeat(64)}`,
};
const temporaryDirectories = [];

const mutationCases = [
  [
    "raw latency regression",
    (artifact) => {
      const latency = artifact.measurements.latency[0];
      latency.samples.fill(2000);
      latency.summary = summarize(latency.samples);
    },
    /p50 budget exceeded/,
  ],
  [
    "incorrect latency summary",
    (artifact) => {
      artifact.measurements.latency[0].summary.p95 += 1;
    },
    /summary does not match raw samples/,
  ],
  [
    "fixture count drift",
    (artifact) => {
      artifact.fixture.counts.agents = 41;
    },
    /fixture counts drifted/,
  ],
  [
    "fixture identity drift",
    (artifact) => {
      artifact.fixture.sha256 = "f".repeat(64);
    },
    /fixture identity drifted/,
  ],
  [
    "logical candidate digest drift",
    (artifact) => {
      artifact.images.webapp = `ghcr.io/winsenlabs/platos-webapp@sha256:${"f".repeat(64)}`;
    },
    /candidate identity drifted/,
  ],
  [
    "tested commit drift",
    (artifact) => {
      artifact.commitSha = "2".repeat(40);
    },
    /not bound to tested commit/,
  ],
  [
    "Memories CWV regression",
    (artifact) => {
      const browser = artifact.measurements.browser.memories;
      for (const sample of browser.samples) sample.lcpMs = 3000;
      browser.summary.lcpMs = summarize(browser.samples.map((sample) => sample.lcpMs));
    },
    /lcpMs p(?:50|95) budget exceeded/,
  ],
  [
    "Memories dense row loss",
    (artifact) => {
      artifact.measurements.browser.memories.samples[0].renderedRows = 19;
      artifact.measurements.browser.memories.summary.renderedRows = summarize(
        artifact.measurements.browser.memories.samples.map((sample) => sample.renderedRows)
      );
    },
    /did not render the dense fixture/,
  ],
  [
    "missing Memories INP",
    (artifact) => {
      delete artifact.measurements.browser.memories.samples[0].inpMs;
    },
    /performance artifact JSON Schema violation/,
  ],
  [
    "Agents interaction regression",
    (artifact) => {
      const browser = artifact.measurements.browser.agentsInteraction;
      for (const sample of browser.samples) sample.interactionLatencyMs = 300;
      browser.summary.interactionLatencyMs = summarize(
        browser.samples.map((sample) => sample.interactionLatencyMs)
      );
    },
    /interactionLatencyMs p(?:50|95) budget exceeded/,
  ],
  [
    "Agents initial bundle regression",
    (artifact) => mutateBundle(artifact.measurements.bundles[0], 5 * 1024 * 1024),
    /agents\.initial-js p95 budget exceeded/,
  ],
  [
    "Agents detail bundle regression",
    (artifact) => mutateBundle(artifact.measurements.bundles[1], 2 * 1024 * 1024),
    /agents\.detail-route-js p95 budget exceeded/,
  ],
  [
    "candidate RSS regression",
    (artifact) => {
      const memory = artifact.measurements.memory[0];
      for (const sample of memory.samples) sample.processRssBytes = 700 * 1024 * 1024;
      memory.summary.processRssBytes = summarize(
        memory.samples.map((sample) => sample.processRssBytes)
      );
    },
    /process RSS p95 budget exceeded/,
  ],
  [
    "runtime image ID drift",
    (artifact) => {
      artifact.measurements.memory[0].runtimeImageId = `sha256:${"f".repeat(64)}`;
    },
    /runtime image ID drifted/,
  ],
  [
    "OCI revision drift",
    (artifact) => {
      artifact.runtime.candidates.agent.revision = "2".repeat(40);
    },
    /runtime revision drifted/,
  ],
  [
    "OCI config hash drift",
    (artifact) => {
      artifact.runtime.candidates.webapp.configSha256 = "f".repeat(64);
    },
    /OCI config hash drifted/,
  ],
  [
    "query count ceiling",
    (artifact) => {
      const measurement = artifact.measurements.queries[0];
      measurement.smallRequest.queries = repeatedQueries(measurement.smallRequest.queries[0], 13);
      measurement.denseRequest.queries = repeatedQueries(measurement.denseRequest.queries[0], 13);
      measurement.smallRequest.queryCount = 13;
      measurement.denseRequest.queryCount = 13;
    },
    /query-count ceiling exceeded/,
  ],
  [
    "N+1 growth",
    (artifact) => {
      const measurement = artifact.measurements.queries[1];
      measurement.denseRequest.queries.push({
        ...structuredClone(measurement.denseRequest.queries[0]),
        sequence: 3,
      });
      measurement.denseRequest.queryCount = 3;
      measurement.nPlusOneGrowth = 1;
    },
    /N\+1 query growth/,
  ],
  [
    "Agent response composition drift",
    (artifact) => {
      const measurement = artifact.measurements.queries.find(
        (candidate) => candidate.id === "agents.list.api"
      );
      measurement.smallResultComposition = { clustered: 1, unclustered: 4 };
    },
    /small response composition drifted/,
  ],
  [
    "request ID binding drift",
    (artifact) => {
      artifact.measurements.plans[0].requestId = "22222222-2222-4222-8222-222222222222";
    },
    /request ID drifted/,
  ],
  [
    "request path binding drift",
    (artifact) => {
      artifact.measurements.queries[0].denseRequest.path = "/api/v1/agent/agents?limit=11&offset=0";
    },
    /candidate request path drifted/,
  ],
  [
    "ambiguous request-bound Prisma correlation",
    (artifact) => {
      artifact.measurements.queries[0].denseRequest.correlationStatus = "ambiguous";
    },
    /performance artifact JSON Schema violation|query correlation was ambiguous/,
  ],
  [
    "query sequence binding drift",
    (artifact) => {
      artifact.measurements.plans[0].querySequence = 2;
    },
    /must have exactly one plan|query sequence drifted/,
  ],
  [
    "captured SQL hash drift",
    (artifact) => {
      artifact.measurements.queries[0].denseRequest.queries[0].normalizedSqlSha256 = "f".repeat(64);
    },
    /SQL hash|normalizedSqlSha256/,
  ],
  [
    "captured parameter hash drift",
    (artifact) => {
      artifact.measurements.queries[0].denseRequest.queries[0].parametersSha256 = "f".repeat(64);
    },
    /parameter hash|parametersSha256/,
  ],
  [
    "candidate capture source drift",
    (artifact) => {
      artifact.measurements.plans[0].source = "handwritten-sql";
    },
    /JSON Schema violation|source drifted/,
  ],
  [
    "sequential scan",
    (artifact) => {
      artifact.measurements.plans[0].plan[0].Plan["Node Type"] = "Seq Scan";
    },
    /forbidden Seq Scan/,
  ],
  [
    "plan row ceiling",
    (artifact) => {
      artifact.measurements.plans[0].plan[0].Plan["Actual Rows"] = 501;
    },
    /plan row ceiling exceeded/,
  ],
  [
    "rows removed ceiling",
    (artifact) => {
      artifact.measurements.plans[0].plan[0].Plan["Rows Removed by Filter"] = 501;
    },
    /rows removed by filter ceiling exceeded/,
  ],
  [
    "actual loops ceiling",
    (artifact) => {
      artifact.measurements.plans[0].plan[0].Plan["Actual Loops"] = 501;
    },
    /actual loops ceiling exceeded/,
  ],
  [
    "shared read block ceiling",
    (artifact) => {
      artifact.measurements.plans[0].plan[0].Plan["Shared Read Blocks"] = 5000;
    },
    /shared read blocks ceiling exceeded/,
  ],
  [
    "planning time ceiling",
    (artifact) => {
      artifact.measurements.plans[0].plan[0]["Planning Time"] = 51;
    },
    /planning time ceiling exceeded/,
  ],
  [
    "execution time ceiling",
    (artifact) => {
      artifact.measurements.plans[0].plan[0]["Execution Time"] = 251;
    },
    /execution time ceiling exceeded/,
  ],
  [
    "recursive secret leak",
    (artifact) => {
      artifact.runtime.candidates.agent.config.command.push("Bearer performance-secret-sentinel");
      artifact.runtime.candidates.agent.configSha256 = sha256(
        JSON.stringify(artifact.runtime.candidates.agent.config)
      );
    },
    /bearer material/,
  ],
  [
    "configured sensitive value leak",
    (artifact) => {
      artifact.runtime.candidates.agent.config.command.push("configured-secret-sentinel");
      artifact.runtime.candidates.agent.configSha256 = sha256(
        JSON.stringify(artifact.runtime.candidates.agent.config)
      );
    },
    /configured sensitive material/,
  ],
  [
    "artifact JSON Schema violation",
    (artifact) => {
      artifact.runtime.unexpected = true;
    },
    /performance artifact JSON Schema violation/,
  ],
  [
    "missing measurement family",
    (artifact) => {
      artifact.measurements.memory.pop();
    },
    /performance artifact JSON Schema violation|memory measurement IDs drifted/,
  ],
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

test("accepts complete synthetic candidate-request evidence under every measured budget", async () => {
  const directory = await writeSyntheticEvidence();
  const verified = await verify(directory);
  assert.equal(verified.commitSha, commitSha);
  assert.equal(verified.latencyPaths, 3);
  assert.equal(verified.plans, 6);
});

test("accepts the shortest valid normalized SELECT captured from the candidate", async () => {
  const directory = await writeSyntheticEvidence((artifact) => {
    const request = artifact.measurements.queries[0].denseRequest;
    const query = request.queries[0];
    query.normalizedSql = "SELECT 1";
    query.normalizedSqlSha256 = sha256(query.normalizedSql);
    query.parameters = [];
    query.parametersSha256 = sha256(JSON.stringify(query.parameters));
    query.parameterMetadata = [];

    const plan = artifact.measurements.plans.find(
      (candidate) =>
        candidate.requestId === request.requestId && candidate.querySequence === query.sequence
    );
    assert.ok(plan);
    plan.normalizedSql = query.normalizedSql;
    plan.normalizedSqlSha256 = query.normalizedSqlSha256;
    plan.parameters = [];
    plan.parametersSha256 = query.parametersSha256;
    plan.parameterMetadata = [];
  });

  const verified = await verify(directory);
  assert.equal(verified.commitSha, commitSha);
});

test("writes a passed receipt bound to the exact verified performance artifact bytes", async () => {
  const directory = await writeSyntheticEvidence();
  await verify(directory);
  const performanceArtifactRaw = await readFile(
    path.join(directory, "performance-results.json"),
    "utf8"
  );
  const receipt = JSON.parse(
    await readFile(path.join(directory, PERFORMANCE_RECEIPT_FILE), "utf8")
  );

  assert.equal(receipt.status, "passed");
  assert.doesNotThrow(() =>
    verifyPerformanceVerificationReceipt(receipt, performanceArtifactRaw, commitSha)
  );
  assert.throws(
    () => verifyPerformanceVerificationReceipt(receipt, `${performanceArtifactRaw} `, commitSha),
    /does not match performance-results\.json/
  );
});

test("removes a stale passed receipt before a failed verification", async () => {
  const directory = await writeSyntheticEvidence();
  await verify(directory);
  const performancePath = path.join(directory, "performance-results.json");
  const artifact = JSON.parse(await readFile(performancePath, "utf8"));
  artifact.measurements.latency[0].samples.fill(2_000);
  artifact.measurements.latency[0].summary = summarize(artifact.measurements.latency[0].samples);
  await writeFile(performancePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  await assert.rejects(() => verify(directory), /p50 budget exceeded/);
  await assert.rejects(
    () => readFile(path.join(directory, PERFORMANCE_RECEIPT_FILE), "utf8"),
    /ENOENT/
  );
});

for (const [name, mutate, pattern] of mutationCases) {
  test(`fails on ${name}`, async () => {
    await expectMutationFailure(mutate, pattern, {
      sensitiveValues:
        name === "configured sensitive value leak" ? ["configured-secret-sentinel"] : [],
    });
  });
}

test("budget JSON Schema is enforced, not merely parseable", async () => {
  const directory = await writeSyntheticEvidence();
  const invalidBudgetPath = path.join(directory, "invalid-budgets.json");
  const budgets = JSON.parse(await readFile(budgetFile, "utf8"));
  budgets.measurementPolicy.serial = false;
  await writeFile(invalidBudgetPath, `${JSON.stringify(budgets, null, 2)}\n`);
  await assert.rejects(
    () =>
      verifyPerformanceArtifactDirectory(directory, {
        repositoryRoot,
        expectedCommit: commitSha,
        inspectSourceCheckout: false,
        inspectRuntimeCandidates: false,
        budgetsPath: invalidBudgetPath,
      }),
    /performance budget JSON Schema violation/
  );
});

async function expectMutationFailure(mutate, pattern, options = {}) {
  const directory = await writeSyntheticEvidence(mutate);
  await assert.rejects(() => verify(directory, options), pattern);
}

async function verify(directory, options = {}) {
  return verifyPerformanceArtifactDirectory(directory, {
    repositoryRoot,
    expectedCommit: commitSha,
    inspectSourceCheckout: false,
    inspectRuntimeCandidates: false,
    ...options,
  });
}

async function writeSyntheticEvidence(mutate = () => undefined) {
  const directory = await mkdtemp("/var/tmp/win235-performance-contract-");
  temporaryDirectories.push(directory);
  const budgetRaw = await readFile(budgetFile, "utf8");
  const budgets = JSON.parse(budgetRaw);
  const fixtureBody = {
    schemaVersion: 1,
    counts: { ...budgets.fixture.requiredCounts },
    scopes: [
      {
        organizationId: ids.organizationId,
        organizationSlug: "win235-alpha",
        projectId: ids.projectId,
        projectSlug: "win235-alpha",
        environmentId: ids.environmentId,
        environmentSlug: "production",
        operatorId: ids.operatorId,
        endUserId: ids.endUserId,
        agentIds: [ids.agentId],
        threadId: ids.threadId,
        smallAgentPageComposition: { clustered: 2, unclustered: 3 },
        denseAgentPageComposition: { clustered: 5, unclustered: 5 },
      },
    ],
  };
  const fixture = {
    ...fixtureBody,
    sha256: sha256(`${JSON.stringify(fixtureBody, null, 2)}\n`),
  };
  const artifact = syntheticArtifact(budgets, budgetRaw, fixture);
  mutate(artifact);
  await Promise.all([
    writeFile(
      path.join(directory, "fixture-manifest.json"),
      `${JSON.stringify(fixture, null, 2)}\n`
    ),
    writeFile(
      path.join(directory, "candidate-images.json"),
      `${JSON.stringify({ commitSha, ...images }, null, 2)}\n`
    ),
    writeFile(
      path.join(directory, "performance-results.json"),
      `${JSON.stringify(artifact, null, 2)}\n`
    ),
  ]);
  return directory;
}

function syntheticArtifact(budgets, budgetRaw, fixture) {
  const latency = budgets.latency.map((budget) => {
    const warmupSamples = Array(budgets.measurementPolicy.latencyWarmupSamples).fill(30);
    const samples = Array(budgets.measurementPolicy.latencyMeasuredSamples).fill(40);
    return { id: budget.id, unit: "ms", warmupSamples, samples, summary: summarize(samples) };
  });
  const memoryCwv = {
    fcpMs: 500,
    lcpMs: 800,
    cls: 0,
    inpMs: 48,
    interactionLatencyMs: 55,
    renderedRows: 20,
  };
  const agentInteraction = { inpMs: 48, interactionLatencyMs: 55 };
  const browserMeasurement = (id, sample, navigation) => {
    const warmupSamples = Array.from(
      { length: budgets.measurementPolicy.browserWarmupSamples },
      () => ({ ...sample })
    );
    const samples = Array.from(
      { length: budgets.measurementPolicy.browserMeasuredSamples },
      () => ({ ...sample })
    );
    return {
      id,
      engine: "chromium",
      ...(navigation ? { navigation } : {}),
      warmupSamples,
      samples,
      summary: Object.fromEntries(
        Object.keys(sample).map((metric) => [
          metric,
          summarize(samples.map((entry) => entry[metric])),
        ])
      ),
    };
  };
  const bundleSample = (url, bodyBytes) => ({
    loadedBytes: bodyBytes,
    resources: [{ url, bodyBytes }],
  });
  const runtimeCandidates = {
    agent: runtimeCandidate("agent", images.agent, runtimeImageIds.agent, "a"),
    webapp: runtimeCandidate("webapp", images.webapp, runtimeImageIds.webapp, "b"),
  };
  const memory = budgets.memory.map((budget) => {
    const service = budget.id.startsWith("agent.") ? "agent" : "webapp";
    const candidate = runtimeCandidates[service];
    const samples = Array.from({ length: budgets.measurementPolicy.memoryMeasuredSamples }, () => ({
      containerBytes: 128 * 1024 * 1024,
      processRssBytes: 96 * 1024 * 1024,
      runtimeImageId: candidate.imageId,
    }));
    return {
      id: budget.id,
      unit: "bytes",
      containerId: candidate.containerId,
      candidateImage: images[service],
      runtimeImageId: candidate.imageId,
      samples,
      summary: {
        containerBytes: summarize(samples.map((sample) => sample.containerBytes)),
        processRssBytes: summarize(samples.map((sample) => sample.processRssBytes)),
      },
    };
  });
  const totals = {
    "agents.list.api": 40,
    "memory.list.api": 192,
    "memory.graph-entities.api": 70,
  };
  const queries = budgets.queries.map((budget, budgetIndex) => {
    const smallRequest = candidateRequest(budget, budget.smallPageSize, budgetIndex * 2 + 1);
    const denseRequest = candidateRequest(budget, budget.densePageSize, budgetIndex * 2 + 2);
    return {
      id: budget.id,
      requestPath: budget.requestPath,
      fixtureRows: fixture.counts[budget.fixtureCountKey],
      smallPageSize: budget.smallPageSize,
      densePageSize: budget.densePageSize,
      smallRequest,
      denseRequest,
      nPlusOneGrowth: 0,
      denseResultRows: budget.densePageSize,
      denseTotalRows: totals[budget.id],
      fullDatasetHydration: false,
      ...(budget.id === "agents.list.api"
        ? {
            smallResultComposition: { ...fixture.scopes[0].smallAgentPageComposition },
            denseResultComposition: { ...fixture.scopes[0].denseAgentPageComposition },
          }
        : {}),
    };
  });
  const plans = queries.flatMap((measurement) => {
    const budget = budgets.queries.find((candidate) => candidate.id === measurement.id);
    return measurement.denseRequest.queries.map((query) =>
      syntheticPlan(budget, measurement.denseRequest, query)
    );
  });
  return {
    $schema: "./performance-artifact.schema.json",
    schemaVersion: 1,
    gate: "win235-measured-performance",
    status: "measured",
    commitSha,
    budgetContract: {
      file: "tests/persisted-state-gate/budgets.v1.json",
      schemaVersion: 1,
      sha256: sha256(budgetRaw),
    },
    fixture: {
      schemaVersion: fixture.schemaVersion,
      sha256: fixture.sha256,
      counts: { ...fixture.counts },
      turnsPerThread: [60, 60],
    },
    images: { ...images },
    runtime: {
      node: "v22.14.0",
      chromium: "140.0.0.0",
      platform: "linux",
      architecture: "x64",
      serial: true,
      startedAt: "2026-08-25T00:00:00.000Z",
      candidates: runtimeCandidates,
    },
    measurements: {
      latency,
      browser: {
        memories: browserMeasurement(
          budgets.browser.memories.id,
          memoryCwv,
          "fresh-context-direct"
        ),
        agentsInteraction: browserMeasurement(
          budgets.browser.agentsInteraction.id,
          agentInteraction
        ),
      },
      bundles: budgets.bundles.map((budget, index) => {
        const warmupSamples = Array.from(
          { length: budgets.measurementPolicy.browserWarmupSamples },
          (_, sample) => bundleSample(`http://candidate.test/warmup-${index}-${sample}.js`, 100_000)
        );
        const samples = Array.from(
          { length: budgets.measurementPolicy.browserMeasuredSamples },
          (_, sample) => bundleSample(`http://candidate.test/${index}-${sample}.js`, 100_000)
        );
        return {
          id: budget.id,
          unit: "bytes",
          warmupSamples,
          samples,
          summary: summarize(samples.map((sample) => sample.loadedBytes)),
        };
      }),
      memory,
      queries,
      plans,
    },
  };
}

function runtimeCandidate(service, logicalImage, imageId, containerCharacter) {
  const manifestDigest = logicalImage.split("@")[1];
  const config = {
    architecture: "amd64",
    os: "linux",
    entrypoint: ["/usr/bin/dumb-init"],
    command: ["node", "server.js"],
    workingDirectory: "/app",
    user: "node",
    revision: commitSha,
  };
  return {
    containerId: containerCharacter.repeat(64),
    runtimeReference: `win235.local/platos-${service}:sha256-${manifestDigest.slice(7)}`,
    imageId,
    manifestDigest,
    revision: commitSha,
    config,
    configSha256: sha256(JSON.stringify(config)),
  };
}

function candidateRequest(budget, pageSize, requestNumber) {
  const requestId = `22222222-2222-4222-8222-${String(requestNumber).padStart(12, "0")}`;
  const path = expectedRequestPath(budget.requestPath, pageSize);
  const queries = [candidateQuery(1, pageSize, false), candidateQuery(2, pageSize, true)];
  return {
    schemaVersion: 1,
    requestId,
    method: "GET",
    path,
    statusCode: 200,
    durationMs: 12,
    correlationStatus: "bound",
    queryCount: queries.length,
    queries,
  };
}

function candidateQuery(sequence, pageSize, count) {
  const normalizedSql = count
    ? 'SELECT COUNT(*) FROM "Fixture" WHERE "environmentId" = $1'
    : 'SELECT "id" FROM "Fixture" WHERE "environmentId" = $1 LIMIT $2';
  const parameters = count ? [ids.environmentId] : [ids.environmentId, pageSize];
  const parameterMetadata = parameters.map((value) => ({
    type: typeof value === "number" ? "number" : "safe-string",
  }));
  return {
    sequence,
    durationMs: sequence,
    normalizedSql,
    normalizedSqlSha256: sha256(normalizedSql),
    parameters,
    parametersSha256: sha256(JSON.stringify(parameters)),
    parameterMetadata,
    replayable: true,
    correlation: "request-bound-prisma-extension",
  };
}

function syntheticPlan(budget, request, query) {
  const actualRows = query.sequence === 1 ? budget.densePageSize : 1;
  return {
    id: `${budget.id}.${request.requestId}.${query.sequence}`,
    queryId: budget.id,
    requestId: request.requestId,
    requestPath: request.path,
    querySequence: query.sequence,
    source: "candidate-request-prisma-query",
    candidateDurationMs: query.durationMs,
    normalizedSql: query.normalizedSql,
    normalizedSqlSha256: query.normalizedSqlSha256,
    parameters: structuredClone(query.parameters),
    parametersSha256: query.parametersSha256,
    parameterMetadata: structuredClone(query.parameterMetadata),
    correlation: "request-bound-prisma-extension",
    options: ["ANALYZE", "BUFFERS", "FORMAT JSON"],
    settings: { statementTimeoutMs: 15_000, enableSeqscan: false },
    plan: [
      {
        Plan: {
          "Node Type": query.sequence === 1 ? "Index Scan" : "Aggregate",
          "Actual Rows": actualRows,
          "Actual Loops": 1,
          "Rows Removed by Filter": 0,
          "Shared Hit Blocks": 4,
          "Shared Read Blocks": 1,
        },
        "Planning Time": 0.1,
        "Execution Time": 0.2,
      },
    ],
  };
}

function expectedRequestPath(requestPath, pageSize) {
  const url = new URL(requestPath, "http://candidate.invalid");
  if (requestPath === "/api/v1/agent/agents") {
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", "0");
  } else {
    url.searchParams.set("userId", ids.endUserId);
    if (requestPath === "/api/v1/memory") url.searchParams.set("agentId", ids.agentId);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", "0");
  }
  return `${url.pathname}${url.search}`;
}

function mutateBundle(bundle, bytes) {
  for (const sample of bundle.samples) {
    sample.resources[0].bodyBytes = bytes;
    sample.loadedBytes = bytes;
  }
  bundle.summary = summarize(bundle.samples.map((sample) => sample.loadedBytes));
}

function repeatedQueries(query, count) {
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(query),
    sequence: index + 1,
  }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
