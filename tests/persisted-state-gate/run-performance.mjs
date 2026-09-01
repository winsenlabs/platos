#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { measuredJsonResponse, measuredRemixJsonResponse } from "./measured-response.mjs";
import { productionOperatorSessionCookieHeader } from "./operator-session-cookie.mjs";
import {
  canonicalRuntimeReference,
  summarize,
  verifyPerformanceArtifactDirectory,
  verifyWebappFinalInventoryIdentity,
  webappCandidateArchivePath,
  webappFinalInventoryEvidencePath,
} from "./verify-performance-artifacts.mjs";
import { PERFORMANCE_RECEIPT_FILE } from "./performance-verification-receipt.mjs";
import { waitForScheduledQueryQuietWindow } from "./scheduled-query-window.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const artifactDirectory = path.resolve(
  repositoryRoot,
  process.env.WIN235_ARTIFACT_DIR ?? "artifacts/win235"
);
const budgetFile = path.resolve(import.meta.dirname, "budgets.v1.json");
const fixtureFile = path.join(artifactDirectory, "fixture-manifest.json");
const candidateImagesFile = path.join(artifactDirectory, "candidate-images.json");
const performanceFile = path.join(artifactDirectory, "performance-results.json");
const remixAgentsRouteId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents._index";
const startedAt = new Date().toISOString();

await rm(path.join(artifactDirectory, PERFORMANCE_RECEIPT_FILE), { force: true });

const databaseUrl = requiredEnvironment("DATABASE_URL");
const webappUrl = requiredEnvironment("WIN235_WEBAPP_URL");
const agentUrl = requiredEnvironment("PLATOS_AGENT_API_URL");
const internalAuthToken = requiredEnvironment("PLATOS_INTERNAL_AUTH_TOKEN");
const evidenceToken = requiredEnvironment("PLATOS_PERFORMANCE_EVIDENCE_TOKEN");
const encryptionKey = requiredEnvironment("ENCRYPTION_KEY");
const commitSha = requiredEnvironment("PLATOS_CANDIDATE_SHA");
assert.equal(
  process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED,
  "1",
  "candidate query evidence requires PLATOS_PERFORMANCE_EVIDENCE_ENABLED=1"
);
assert.match(commitSha, /^[a-f0-9]{40}$/, "PLATOS_CANDIDATE_SHA must be an exact commit SHA");
verifySourceIdentity(commitSha);

const [budgetRaw, fixture, candidateImages] = await Promise.all([
  readFile(budgetFile, "utf8"),
  readJson(fixtureFile),
  readJson(candidateImagesFile),
]);
const budgets = JSON.parse(budgetRaw);
assert.equal(
  candidateImages.commitSha,
  commitSha,
  "candidate images do not match exact candidate SHA"
);
const webappFinalInventoryEvidence = await readJson(
  webappFinalInventoryEvidencePath(artifactDirectory, candidateImages.webapp)
);
const expectedWebappImageId = verifyWebappFinalInventoryIdentity(
  webappFinalInventoryEvidence,
  candidateImages.webapp,
  commitSha,
  webappCandidateArchivePath(artifactDirectory)
);

const tenancyModule = await import(
  pathToFileURL(path.resolve(repositoryRoot, "internal-packages/tenancy-database/dist/index.js"))
    .href
);
const { PrismaClient, PlatosAuthService } = tenancyModule;
assert.equal(typeof PrismaClient, "function", "the built tenancy Prisma client is required");
assert.equal(typeof PlatosAuthService, "function", "the built operator auth service is required");
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

let browser;
try {
  const primary = fixture.scopes?.[0];
  assert.ok(primary, "fixture manifest has no primary scope");
  const { turnsPerThread, persistedAgentTotal } = await verifyLiveFixture(prisma, fixture, budgets);
  const auth = new PlatosAuthService(prisma, { encryptionKey });
  const session = await auth.issueOperatorSession({ userId: primary.operatorId });
  const authorizedSession = await auth.authorizeOperatorSession(session.token);
  assert.equal(
    authorizedSession.effectiveUserId,
    primary.operatorId,
    "issued performance session failed its database authorization preflight"
  );
  const cookieHeader = await productionOperatorSessionCookieHeader(
    session.token,
    session.expiresAt
  );
  const agentHeaders = createAgentHeaders(primary);
  const latencyPaths = createLatencyPaths(primary, cookieHeader, agentHeaders, persistedAgentTotal);

  const latency = [];
  for (const budget of budgets.latency) {
    const operation = latencyPaths.get(budget.id);
    assert.ok(operation, `no runtime measurement is registered for ${budget.id}`);
    latency.push(await measureLatencyPath(budget.id, operation, budgets.measurementPolicy));
  }
  reportProgress("latency samples complete");

  const { queries, plans } = await measureCandidateQueries(prisma, primary, agentHeaders, budgets);
  reportProgress("candidate-correlated query evidence and PostgreSQL plans complete");

  const runtimeCandidates = {
    agent: inspectRuntimeCandidate("agent", candidateImages.agent, commitSha),
    webapp: inspectRuntimeCandidate(
      "webapp",
      candidateImages.webapp,
      commitSha,
      expectedWebappImageId
    ),
  };

  browser = await chromium.launch({ headless: true });
  const chromiumVersion = browser.version();
  const browserRunCount =
    budgets.measurementPolicy.browserWarmupSamples +
    budgets.measurementPolicy.browserMeasuredSamples;
  const memoriesRuns = [];
  const agentsRuns = [];
  for (let index = 0; index < browserRunCount; index += 1) {
    memoriesRuns.push(await measureMemoriesBrowserRun(browser, primary, cookieHeader, budgets));
    agentsRuns.push(await measureAgentsBrowserRun(browser, primary, cookieHeader));
    reportProgress(`Chromium sample ${index + 1}/${browserRunCount} complete`);
  }
  const browserWarmupCount = budgets.measurementPolicy.browserWarmupSamples;
  const memoriesWarmups = memoriesRuns.slice(0, browserWarmupCount);
  const memoriesSamples = memoriesRuns.slice(browserWarmupCount);
  const agentsWarmups = agentsRuns.slice(0, browserWarmupCount);
  const agentsSamples = agentsRuns.slice(browserWarmupCount);
  const browserMeasurement = {
    memories: browserMeasurementFor(
      budgets.browser.memories.id,
      memoriesWarmups.map(({ metrics }) => metrics),
      memoriesSamples.map(({ metrics }) => metrics),
      true
    ),
    agentsInteraction: browserMeasurementFor(
      budgets.browser.agentsInteraction.id,
      agentsWarmups.map(({ metrics }) => metrics),
      agentsSamples.map(({ metrics }) => metrics),
      false
    ),
  };
  const bundles = [
    bundleMeasurement(
      "agents.initial-js",
      agentsWarmups.map(({ initialBundle }) => initialBundle),
      agentsSamples.map(({ initialBundle }) => initialBundle)
    ),
    bundleMeasurement(
      "agents.detail-route-js",
      agentsWarmups.map(({ interactionBundle }) => interactionBundle),
      agentsSamples.map(({ interactionBundle }) => interactionBundle)
    ),
  ];

  const memory = [];
  for (const budget of budgets.memory) {
    const service = budget.id.startsWith("agent.") ? "agent" : "webapp";
    memory.push(
      measureCandidateMemory(
        budget.id,
        candidateImages[service],
        runtimeCandidates[service],
        budgets.measurementPolicy.memoryMeasuredSamples
      )
    );
  }

  const artifact = {
    $schema: "./performance-artifact.schema.json",
    schemaVersion: 1,
    gate: "win235-measured-performance",
    status: "measured",
    commitSha,
    budgetContract: {
      file: "tests/persisted-state-gate/budgets.v1.json",
      schemaVersion: budgets.schemaVersion,
      sha256: sha256(budgetRaw),
    },
    fixture: {
      schemaVersion: fixture.schemaVersion,
      sha256: fixture.sha256,
      counts: fixture.counts,
      turnsPerThread,
    },
    images: {
      agent: candidateImages.agent,
      webapp: candidateImages.webapp,
      migrations: candidateImages.migrations,
    },
    runtime: {
      node: process.version,
      chromium: chromiumVersion,
      platform: os.platform(),
      architecture: os.arch(),
      serial: true,
      startedAt,
      candidates: runtimeCandidates,
    },
    measurements: { latency, browser: browserMeasurement, bundles, memory, queries, plans },
  };

  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(performanceFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await verifyPerformanceArtifactDirectory(artifactDirectory, {
    repositoryRoot,
    expectedCommit: commitSha,
  });
  process.stdout.write(
    `WIN-235 performance gate passed for ${commitSha}: ${latency.length} paths, ${plans.length} candidate-captured plans\n`
  );
} finally {
  await browser?.close();
  await prisma.$disconnect();
}

function createAgentHeaders(primary) {
  return {
    Accept: "application/json",
    "X-Platos-Organization-Id": primary.organizationId,
    "X-Platos-Project-Id": primary.projectId,
    "X-Platos-Environment-Id": primary.environmentId,
    "X-Platos-User-Id": primary.operatorId,
    "X-Platos-Internal-Auth": internalAuthToken,
  };
}

function createLatencyPaths(primary, cookieHeader, agentHeaders, persistedAgentTotal) {
  const environmentPath = `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}`;
  return new Map([
    [
      "agents.loader",
      async () => {
        const url = new URL(`${environmentPath}/agents`, webappUrl);
        url.searchParams.set("_data", remixAgentsRouteId);
        const payload = await measuredRemixJsonResponse(
          await fetch(url, {
            headers: { Cookie: cookieHeader, Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          }),
          "agents.loader"
        );
        assert.equal(payload.panel?.ok, true, "Agents loader did not return its live panel");
        assert.equal(
          payload.panel.data.total,
          persistedAgentTotal,
          "Agents loader total drifted from canonical PostgreSQL"
        );
        assert.equal(
          payload.panel.data.agents.length,
          persistedAgentTotal,
          "Agents loader rows drifted from canonical PostgreSQL"
        );
      },
    ],
    [
      "memory.list.api",
      async () => {
        const url = candidateRequestUrl(primary, "/api/v1/memory", 50);
        const payload = await measuredJsonResponse(
          await fetch(url, {
            headers: withAgentPin(agentHeaders, primary),
            signal: AbortSignal.timeout(10_000),
          }),
          "memory.list.api"
        );
        assert.ok(payload.total > 0, "Memory API returned no fixture rows");
        assert.ok(payload.memories.length <= 50, "Memory API returned an unbounded page");
      },
    ],
    [
      "memory.graph-entities.api",
      async () => {
        const url = candidateRequestUrl(primary, "/api/v1/memory/graph/entities", 50);
        const payload = await measuredJsonResponse(
          await fetch(url, {
            headers: withAgentPin(agentHeaders, primary),
            signal: AbortSignal.timeout(10_000),
          }),
          "memory.graph-entities.api"
        );
        assert.ok(payload.total > 0, "graph API returned no fixture rows");
        assert.ok(payload.entities.length <= 50, "graph API returned an unbounded page");
      },
    ],
  ]);
}

function candidateRequestUrl(primary, requestPath, limit) {
  const url = new URL(requestPath, agentUrl);
  if (requestPath === "/api/v1/agent/agents") {
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", "0");
  } else {
    url.searchParams.set("userId", primary.endUserId);
    if (requestPath === "/api/v1/memory") {
      url.searchParams.set("agentId", primary.agentIds[0]);
    }
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", "0");
  }
  return url;
}

async function measureLatencyPath(id, operation, policy) {
  const warmupSamples = [];
  const samples = [];
  for (let index = 0; index < policy.latencyWarmupSamples; index += 1) {
    warmupSamples.push(await timed(operation));
  }
  for (let index = 0; index < policy.latencyMeasuredSamples; index += 1) {
    samples.push(await timed(operation));
  }
  return { id, unit: "ms", warmupSamples, samples, summary: summarize(samples) };
}

async function timed(operation) {
  const start = process.hrtime.bigint();
  await operation();
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

async function verifyLiveFixture(prisma, fixture, budgets) {
  const [countRow] = await prisma.$queryRawUnsafe(`
    SELECT
      (SELECT COUNT(*)::int FROM "Agent") AS "agents",
      (SELECT COUNT(*)::int FROM "Thread") AS "threads",
      (SELECT COUNT(*)::int FROM "Turn") AS "turns",
      (SELECT COUNT(*)::int FROM "Tool") AS "tools",
      (SELECT COUNT(*)::int FROM "Memory") AS "memories",
      (SELECT COUNT(*)::int FROM "MemoryEntity") AS "graphEntities"
  `);
  const actual = Object.fromEntries(
    Object.entries(countRow).map(([key, value]) => [key, Number(value)])
  );
  for (const [key, expected] of Object.entries(budgets.fixture.requiredCounts)) {
    assert.equal(fixture.counts[key], expected, `fixture manifest ${key} count drifted`);
    assert.equal(actual[key], expected, `live PostgreSQL ${key} count drifted before measurement`);
  }
  const threadRows = await prisma.$queryRawUnsafe(
    `SELECT "threadId", COUNT(*)::int AS "turns" FROM "Turn" GROUP BY "threadId"`
  );
  const turnsByThread = new Map(threadRows.map((row) => [row.threadId, Number(row.turns)]));
  const turnsPerThread = fixture.scopes.map((scope) => turnsByThread.get(scope.threadId) ?? 0);
  assert.deepEqual(
    turnsPerThread,
    Array(fixture.counts.threads).fill(budgets.fixture.turnsPerThread),
    "live thread density drifted before measurement"
  );
  const primary = fixture.scopes[0];
  const persistedAgentTotal = await prisma.agentBinding.count({
    where: {
      environmentId: primary.environmentId,
      agent: { isActive: true },
    },
  });
  assert.equal(
    persistedAgentTotal,
    primary.agentIds.length,
    "live scoped AgentBinding total drifted before measurement"
  );
  const memoryBudget = budgets.queries.find((budget) => budget.id === "memory.list.api");
  assert.ok(memoryBudget, "Memory query budget is absent");
  assert.ok(
    primary.denseMemoryCount > memoryBudget.densePageSize,
    "fixture does not contain multiple Memory pages for the measured principal"
  );
  assert.equal(
    primary.memoryAgentCount,
    primary.agentIds.length,
    "fixture does not retain Memory rows across every representative Agent"
  );
  for (const [name, composition] of [
    ["small", primary.smallAgentPageComposition],
    ["dense", primary.denseAgentPageComposition],
  ]) {
    assert.ok(composition?.clustered > 0, `${name} Agent page has no clustered binding`);
    assert.ok(composition?.unclustered > 0, `${name} Agent page has no unclustered binding`);
  }
  return { turnsPerThread, persistedAgentTotal };
}

async function measureCandidateQueries(prisma, primary, agentHeaders, budgets) {
  const queries = [];
  const plans = [];
  for (const budget of budgets.queries) {
    const small = await captureCandidateRequest(
      primary,
      agentHeaders,
      budget,
      budget.smallPageSize
    );
    const dense = await captureCandidateRequest(
      primary,
      agentHeaders,
      budget,
      budget.densePageSize
    );
    assertCandidateCapture(small.evidence, budget, "small");
    assertCandidateCapture(dense.evidence, budget, "dense");
    const nPlusOneGrowth = Math.max(0, dense.evidence.queryCount - small.evidence.queryCount);
    assert.ok(dense.rows > 0, `${budget.id} returned no dense rows`);
    assert.ok(dense.total >= dense.rows, `${budget.id} returned inconsistent pagination totals`);
    const fullDatasetHydration = dense.rows >= dense.total;
    const resultComposition =
      budget.requestPath === "/api/v1/agent/agents"
        ? {
            small: agentResultComposition(small.items, primary.clusterId),
            dense: agentResultComposition(dense.items, primary.clusterId),
          }
        : null;
    if (resultComposition) {
      assert.deepEqual(
        resultComposition.small,
        primary.smallAgentPageComposition,
        `${budget.id} small response composition drifted from the persisted fixture`
      );
      assert.deepEqual(
        resultComposition.dense,
        primary.denseAgentPageComposition,
        `${budget.id} dense response composition drifted from the persisted fixture`
      );
    }
    queries.push({
      id: budget.id,
      requestPath: budget.requestPath,
      fixtureRows: fixture.counts[budget.fixtureCountKey],
      smallPageSize: budget.smallPageSize,
      densePageSize: budget.densePageSize,
      smallRequest: small.evidence,
      denseRequest: dense.evidence,
      nPlusOneGrowth,
      denseResultRows: dense.rows,
      denseTotalRows: dense.total,
      fullDatasetHydration,
      ...(resultComposition
        ? {
            smallResultComposition: resultComposition.small,
            denseResultComposition: resultComposition.dense,
          }
        : {}),
    });
    assert.equal(fullDatasetHydration, false, `${budget.id} hydrated its full scoped dataset`);
    for (const query of dense.evidence.queries) {
      plans.push(await explainCandidateQuery(prisma, budget.id, dense.evidence, query));
    }
  }
  return { queries, plans };
}

async function captureCandidateRequest(primary, agentHeaders, budget, pageSize) {
  await waitForScheduledQueryQuietWindow();
  const requestId = randomUUID();
  const url = candidateRequestUrl(primary, budget.requestPath, pageSize);
  const headers = {
    ...(budget.requestPath === "/api/v1/agent/agents"
      ? agentHeaders
      : withAgentPin(agentHeaders, primary)),
    "X-Platos-Performance-Evidence-Id": requestId,
    "X-Platos-Performance-Evidence-Token": evidenceToken,
  };
  const payload = await measuredJsonResponse(
    await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }),
    `${budget.id} candidate request`
  );
  const evidence = await consumeCandidateEvidence(requestId, agentHeaders);
  assert.equal(evidence.requestId, requestId, `${budget.id} evidence request ID drifted`);
  assert.equal(evidence.path, `${url.pathname}${url.search}`, `${budget.id} evidence path drifted`);
  const items =
    budget.requestPath === "/api/v1/agent/agents"
      ? payload.agents
      : budget.requestPath === "/api/v1/memory"
      ? payload.memories
      : payload.entities;
  assert.ok(Array.isArray(items), `${budget.id} candidate response has no result array`);
  assert.ok(Number.isInteger(payload.total), `${budget.id} candidate response has no total`);
  return { evidence, items, rows: items.length, total: payload.total };
}

function agentResultComposition(agents, expectedClusterId) {
  assert.match(expectedClusterId, /^[a-f0-9-]{36}$/i, "fixture cluster ID is invalid");
  assert.ok(
    agents.every(
      (agent) => agent.clusteringId === expectedClusterId || agent.clusteringId === null
    ),
    "Agent response contains a missing, malformed, or foreign clusteringId"
  );
  return {
    clustered: agents.filter((agent) => agent.clusteringId === expectedClusterId).length,
    unclustered: agents.filter((agent) => agent.clusteringId === null).length,
  };
}

function withAgentPin(headers, primary) {
  return { ...headers, "X-Platos-Agent-Id": primary.agentIds[0] };
}

async function consumeCandidateEvidence(requestId, agentHeaders) {
  const url = new URL(`/api/v1/agent/internal/performance-evidence/${requestId}`, agentUrl);
  const headers = {
    ...agentHeaders,
    "X-Platos-Performance-Evidence-Token": evidenceToken,
  };
  for (let retryIndex = 0; retryIndex < 10; retryIndex += 1) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    return measuredJsonResponse(response, `performance evidence ${requestId}`);
  }
  throw new Error(`candidate did not publish performance evidence for request ${requestId}`);
}

function assertCandidateCapture(evidence, budget, density) {
  assert.equal(evidence.schemaVersion, 1, `${budget.id} ${density} evidence version drifted`);
  assert.equal(evidence.method, "GET", `${budget.id} ${density} was not a GET request`);
  assert.equal(evidence.statusCode, 200, `${budget.id} ${density} did not complete successfully`);
  assert.ok(evidence.durationMs > 0, `${budget.id} ${density} request duration is unmeasured`);
  assert.equal(
    evidence.correlationStatus,
    "bound",
    `${budget.id} ${density} Prisma query correlation was ambiguous`
  );
  assert.ok(evidence.queryCount > 0, `${budget.id} ${density} emitted no candidate Prisma queries`);
  assert.equal(
    evidence.queryCount,
    evidence.queries?.length,
    `${budget.id} ${density} candidate query capture was truncated`
  );
  for (const [index, query] of evidence.queries.entries()) {
    assert.equal(query.sequence, index + 1, `${budget.id} ${density} query sequence drifted`);
    assert.equal(
      query.correlation,
      "request-bound-prisma-extension",
      `${budget.id} query is not request-correlated at invocation`
    );
    assert.equal(
      query.replayable,
      true,
      `${budget.id} query ${query.sequence} was redacted: ${JSON.stringify(
        query.parameterMetadata.map(({ type, length }) => ({ type, length }))
      )}`
    );
    assert.match(query.normalizedSql, /^SELECT\b/i, `${budget.id} captured a non-SELECT statement`);
    assert.equal(query.normalizedSql, normalizeSql(query.normalizedSql));
    assert.equal(query.normalizedSqlSha256, sha256(query.normalizedSql));
    assert.equal(query.parametersSha256, sha256(JSON.stringify(query.parameters)));
  }
}

async function explainCandidateQuery(prisma, queryId, request, query) {
  const replaySql = inlineCapturedParameters(query.normalizedSql, query.parameters);
  const rows = await prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '15s'");
      await transaction.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return transaction.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${replaySql}`);
    },
    { timeout: 30_000 }
  );
  const plan = rows[0]?.["QUERY PLAN"];
  assert.ok(plan, `${queryId}.${query.sequence} returned no PostgreSQL plan`);
  return {
    id: `${queryId}.${request.requestId}.${query.sequence}`,
    queryId,
    requestId: request.requestId,
    requestPath: request.path,
    querySequence: query.sequence,
    source: "candidate-request-prisma-query",
    candidateDurationMs: query.durationMs,
    normalizedSql: query.normalizedSql,
    normalizedSqlSha256: query.normalizedSqlSha256,
    parameters: query.parameters,
    parametersSha256: query.parametersSha256,
    parameterMetadata: query.parameterMetadata,
    correlation: query.correlation,
    options: ["ANALYZE", "BUFFERS", "FORMAT JSON"],
    settings: { statementTimeoutMs: 15_000, enableSeqscan: false },
    plan,
  };
}

function inlineCapturedParameters(sql, parameters) {
  return sql.replace(/\$(\d+)/g, (placeholder, position) => {
    const index = Number(position) - 1;
    return index >= 0 && index < parameters.length
      ? postgresLiteral(parameters[index])
      : placeholder;
  });
}

function postgresLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "captured Prisma query contains a non-finite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (Array.isArray(value)) return `ARRAY[${value.map(postgresLiteral).join(", ")}]`;
  assert.equal(typeof value, "string", "captured Prisma query has an unsafe parameter type");
  return `'${value.replaceAll("'", "''")}'`;
}

async function measureMemoriesBrowserRun(browserInstance, primary, cookieHeader, budgets) {
  const context = await newBrowserContext(browserInstance, cookieHeader);
  try {
    const page = await context.newPage();
    await installPerformanceObservers(page);
    const environmentPath = `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}`;
    const url = new URL(`${environmentPath}/memories`, webappUrl);
    url.searchParams.set("userId", primary.endUserId);
    url.searchParams.set("agentId", primary.agentIds[0]);
    url.searchParams.set("limit", "50");
    url.searchParams.set("offset", "0");
    await navigateCandidatePage(page, url, "Memories");
    const canonicalMemory = page.getByText("Canonical alpha memory", { exact: false }).first();
    await canonicalMemory.waitFor();
    const rows = canonicalMemory.locator("xpath=ancestor::table[1]").locator("tbody > tr");
    const renderedRows = await rows.count();
    assert.ok(
      renderedRows >= budgets.browser.memories.minimumRenderedRows,
      `Chromium Memories rendered only ${renderedRows} dense rows`
    );
    const interaction = rows.first().locator("details > summary").first();
    assert.equal(await interaction.count(), 1, "Memories trusted details interaction is absent");
    await interaction.click();
    await page.waitForTimeout(500);
    return {
      metrics: {
        ...(await readBrowserMetrics(page, [
          "fcpMs",
          "lcpMs",
          "cls",
          "inpMs",
          "interactionLatencyMs",
        ])),
        renderedRows,
      },
    };
  } finally {
    await context.close();
  }
}

async function measureAgentsBrowserRun(browserInstance, primary, cookieHeader) {
  const context = await newBrowserContext(browserInstance, cookieHeader);
  try {
    const page = await context.newPage();
    await installPerformanceObservers(page);
    const resources = captureJavaScriptBodies(page);
    const environmentPath = `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}`;
    const agentsUrl = new URL(`${environmentPath}/agents`, webappUrl);
    await navigateCandidatePage(page, agentsUrl, "Agents");
    await resources.settle();
    const initialResources = new Map(resources.values);
    const detailLink = page.locator(`table tbody a[href$="/${primary.agentIds[0]}"]`).first();
    assert.equal(await detailLink.count(), 1, "persisted Agent detail interaction is absent");
    await detailLink.click();
    await page.waitForURL((url) => url.pathname.endsWith(`/agents/${primary.agentIds[0]}`), {
      timeout: 15_000,
    });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    await resources.settle();
    return {
      metrics: await readBrowserMetrics(page, ["inpMs", "interactionLatencyMs"]),
      initialBundle: resourceSample(initialResources),
      interactionBundle: resourceSample(
        new Map([...resources.values].filter(([url]) => !initialResources.has(url)))
      ),
    };
  } finally {
    await context.close();
  }
}

async function newBrowserContext(browserInstance, cookieHeader) {
  return browserInstance.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { Cookie: cookieHeader },
  });
}

function installPerformanceObservers(page) {
  return page.addInitScript(() => {
    const state = {
      fcpMs: 0,
      lcpMs: 0,
      cls: 0,
      eventDurations: new Map(),
      interactionLatencies: [],
    };
    globalThis.__win235Performance = state;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") state.fcpMs = entry.startTime;
      }
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.lcpMs = Math.max(state.lcpMs, entry.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) state.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.interactionId > 0) {
          state.eventDurations.set(
            entry.interactionId,
            Math.max(state.eventDurations.get(entry.interactionId) ?? 0, entry.duration)
          );
        }
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
    document.addEventListener(
      "click",
      () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => state.interactionLatencies.push(performance.now() - start))
        );
      },
      true
    );
  });
}

function captureJavaScriptBodies(page) {
  const values = new Map();
  const pending = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "script" || !response.ok()) return;
    pending.push(
      response
        .body()
        .then((body) => values.set(response.url(), body.byteLength))
        .catch((error) => {
          throw new Error(`failed to read loaded JavaScript ${response.url()}: ${error.message}`);
        })
    );
  });
  return {
    values,
    async settle() {
      await Promise.all(pending);
    },
  };
}

async function navigateCandidatePage(page, url, label) {
  const response = await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 30_000 });
  assert.ok(
    response?.ok(),
    `Chromium ${label} route failed with ${response?.status() ?? "no response"}`
  );
  assert.ok(
    !page.url().includes("/login"),
    "Chromium did not retain the authenticated operator session"
  );
}

async function readBrowserMetrics(page, requiredMetrics) {
  const raw = await page.evaluate(() => {
    const state = globalThis.__win235Performance;
    const interactions = [...state.eventDurations.values()].sort((left, right) => left - right);
    return {
      fcpMs: state.fcpMs,
      lcpMs: state.lcpMs,
      cls: state.cls,
      inpMs: interactions[Math.max(0, Math.ceil(interactions.length * 0.98) - 1)] ?? 0,
      interactionLatencyMs: Math.max(...state.interactionLatencies, 0),
    };
  });
  return Object.fromEntries(
    requiredMetrics.map((metric) => {
      const value = raw[metric];
      assert.ok(Number.isFinite(value) && value >= 0, `Chromium ${metric} is not measurable`);
      if (metric !== "cls") assert.ok(value > 0, `Chromium ${metric} was not measured`);
      return [metric, value];
    })
  );
}

function browserMeasurementFor(id, warmupSamples, samples, directNavigation) {
  return {
    id,
    engine: "chromium",
    ...(directNavigation ? { navigation: "fresh-context-direct" } : {}),
    warmupSamples,
    samples,
    summary: Object.fromEntries(
      Object.keys(samples[0]).map((metric) => [
        metric,
        summarize(samples.map((sample) => sample[metric])),
      ])
    ),
  };
}

function resourceSample(resources) {
  const entries = [...resources]
    .map(([url, bodyBytes]) => ({ url, bodyBytes }))
    .sort((left, right) => left.url.localeCompare(right.url));
  assert.ok(entries.length > 0, "Chromium loaded no measurable JavaScript resources");
  return {
    loadedBytes: entries.reduce((total, resource) => total + resource.bodyBytes, 0),
    resources: entries,
  };
}

function bundleMeasurement(id, warmupSamples, samples) {
  return {
    id,
    unit: "bytes",
    warmupSamples,
    samples,
    summary: summarize(samples.map((sample) => sample.loadedBytes)),
  };
}

function inspectRuntimeCandidate(service, logicalImage, expectedCommit, expectedImageId) {
  assert.match(logicalImage, /^ghcr\.io\/.+@sha256:[a-f0-9]{64}$/);
  const manifestDigest = logicalImage.slice(logicalImage.indexOf("@") + 1);
  const runtimeReference = canonicalRuntimeReference(service, manifestDigest);
  const containerId = execFileSync("docker", ["compose", "ps", "--quiet", service], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  assert.match(containerId, /^[a-f0-9]{12,64}$/, `${service} candidate container is not running`);
  const container = JSON.parse(
    execFileSync("docker", ["inspect", containerId], { encoding: "utf8" })
  )[0];
  const image = JSON.parse(
    execFileSync("docker", ["image", "inspect", runtimeReference], { encoding: "utf8" })
  )[0];
  if (expectedImageId !== undefined) {
    assert.equal(
      image.Id,
      expectedImageId,
      `${service} mutable runtime tag differs from archive-verified image ID`
    );
  }
  assert.equal(container.Config.Image, runtimeReference, `${service} container reference drifted`);
  assert.equal(container.Image, image.Id, `${service} container image ID drifted`);
  const revision = image.Config?.Labels?.["org.opencontainers.image.revision"];
  assert.equal(revision, expectedCommit, `${service} OCI revision drifted`);
  const config = {
    architecture: image.Architecture,
    os: image.Os,
    entrypoint: image.Config?.Entrypoint ?? [],
    command: image.Config?.Cmd ?? [],
    workingDirectory: image.Config?.WorkingDir ?? "",
    user: image.Config?.User ?? "",
    revision,
  };
  return {
    containerId,
    runtimeReference,
    imageId: image.Id,
    manifestDigest,
    revision,
    config,
    configSha256: sha256(JSON.stringify(config)),
  };
}

function measureCandidateMemory(id, candidateImage, runtimeCandidate, sampleCount) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const stats = JSON.parse(
      execFileSync(
        "docker",
        ["stats", "--no-stream", "--format", "{{json .}}", runtimeCandidate.containerId],
        { encoding: "utf8" }
      ).trim()
    );
    const containerBytes = parseDockerBytes(stats.MemUsage.split("/")[0].trim());
    const processRows = execFileSync(
      "docker",
      ["top", runtimeCandidate.containerId, "-eo", "pid,rss,comm"],
      { encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/, 3))
      .filter((columns) => /^\d+$/.test(columns[1] ?? ""));
    assert.ok(processRows.length > 0, `${id} candidate process RSS is unavailable`);
    samples.push({
      containerBytes,
      processRssBytes: Math.max(...processRows.map((columns) => Number(columns[1]) * 1024)),
      runtimeImageId: runtimeCandidate.imageId,
    });
  }
  return {
    id,
    unit: "bytes",
    containerId: runtimeCandidate.containerId,
    candidateImage,
    runtimeImageId: runtimeCandidate.imageId,
    samples,
    summary: {
      containerBytes: summarize(samples.map((sample) => sample.containerBytes)),
      processRssBytes: summarize(samples.map((sample) => sample.processRssBytes)),
    },
  };
}

function parseDockerBytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)$/i.exec(value);
  assert.ok(match, `unsupported docker memory value: ${value}`);
  const units = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  return Math.round(Number(match[1]) * units[match[2].toLowerCase()]);
}

function verifySourceIdentity(expectedCommit) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  assert.equal(head, expectedCommit, "git HEAD does not equal PLATOS_CANDIDATE_SHA");
  for (const args of [
    ["diff", "--quiet"],
    ["diff", "--cached", "--quiet"],
  ]) {
    try {
      execFileSync("git", args, { cwd: repositoryRoot, stdio: "ignore" });
    } catch {
      throw new Error("tracked worktree and index must be clean before performance measurement");
    }
  }
  const trackedStatus = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  assert.equal(trackedStatus, "", "tracked worktree and index must be clean before measurement");
}

function normalizeSql(sql) {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required by the measured performance gate`);
  return value;
}

function reportProgress(message) {
  process.stdout.write(`[WIN-235 performance] ${message}\n`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
