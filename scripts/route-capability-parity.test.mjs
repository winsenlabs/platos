import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EXPECTED_BASELINES,
  V0_EXCLUDED_TEST_MODULE,
  V0_PRODUCTION_TEST_SEGMENT_ROUTE,
  completionBlockers,
  readMatrix,
  renderMarkdown,
  runCompletionGate,
  v0RouteInventory,
  validateMatrix,
} from "./route-capability-parity.mjs";

function clone(value) {
  return structuredClone(value);
}

function errorsFor(matrix, inspectRepository = false) {
  return validateMatrix(matrix, { inspectRepository }).join("\n");
}

function capability(matrix, capabilityId) {
  const row = matrix.capabilities.find((entry) => entry.capabilityId === capabilityId);
  assert.ok(row, `missing fixture capability ${capabilityId}`);
  return row;
}

function v0Route(matrix, suffix) {
  const row = matrix.v0Routes.find((entry) => entry.path.endsWith(suffix));
  assert.ok(row, `missing fixture v0 route ${suffix}`);
  return row;
}

const REQUIRED_CAPABILITIES = [
  "mcp-token-create",
  "mcp-token-list",
  "mcp-token-revoke",
  "mcp-tool-acl-policy",
  "mcp-combined-identity-modes",
  "mcp-identity-context",
  "mcp-credential-reference-migration",
  "postman-template-crud",
  "postman-executable-mode",
  "entity-mcp-bearer-token-list",
  "entity-mcp-bearer-token-create",
  "entity-mcp-bearer-token-delete",
  "attachment-presign-upload",
  "thread-artifacts",
  "message-rating-lifecycle",
  "thread-fork",
  "message-pagination",
  "access-key-one-time-reveal",
  "access-key-rotation-correlation",
  "access-key-revoke",
  "access-key-allowed-origins",
  "access-key-browser-request-correlation",
  "agent-tools-loader-action-mismatch",
];

test("the committed matrix satisfies the strict current_route + capability_id contract", () => {
  const matrix = readMatrix();
  assert.deepEqual(validateMatrix(matrix), []);
  assert.equal(matrix.schemaVersion, "2.0");
  assert.equal(matrix.currentRoutes.length, 84);
  assert.equal(matrix.v0Routes.length, 427);
  assert.ok(matrix.capabilities.length > matrix.currentRoutes.length, "multiple capability rows must exist per retained route");
  assert.ok(matrix.v0Routes.some((route) => route.path === V0_PRODUCTION_TEST_SEGMENT_ROUTE));
  assert.ok(!matrix.v0Routes.some((route) => route.path === V0_EXCLUDED_TEST_MODULE));
});

test("v0 inventory independently counts all files and excludes exactly one collocated test", () => {
  const matrix = readMatrix();
  const inventory = v0RouteInventory(matrix.baselines.v0.commit);
  assert.ok(inventory);
  assert.equal(inventory.allFiles.length, EXPECTED_BASELINES.v0TotalFiles);
  assert.equal(inventory.typeScriptFiles.length, EXPECTED_BASELINES.v0TypeScriptFiles);
  assert.equal(inventory.verifiedTypeScriptRoutes.length, EXPECTED_BASELINES.v0VerifiedTypeScriptRoutes);
  assert.equal(inventory.nonTypeScriptFiles.length, EXPECTED_BASELINES.v0NonTypeScriptFiles);
  assert.deepEqual(inventory.excludedTestModules, [V0_EXCLUDED_TEST_MODULE]);
  assert.ok(inventory.verifiedTypeScriptRoutes.includes(V0_PRODUCTION_TEST_SEGMENT_ROUTE));
});

test("matrix metadata cannot redefine the independently expected inventory", () => {
  const matrix = clone(readMatrix());
  matrix.baselines.v0.expectedTotalFiles = matrix.v0Routes.length;
  matrix.baselines.v0.expectedVerifiedTypeScriptRouteModules = 426;
  const errors = errorsFor(matrix);
  assert.match(errors, /matrix v0 baseline metadata is incorrect/);
});

test("a missing current route cannot be hidden while preserving the count", () => {
  const matrix = clone(readMatrix());
  matrix.currentRoutes[0].path = "apps/webapp/app/routes/not-in-the-tree/route.tsx";
  const errors = errorsFor(matrix, true);
  assert.match(errors, /current route missing from matrix/);
  assert.match(errors, /matrix current route no longer exists/);
});

test("capabilities are uniquely keyed by current_route + capability_id and every route has one", () => {
  const matrix = clone(readMatrix());
  matrix.capabilities.push(clone(matrix.capabilities[0]));
  matrix.currentRoutes[0].capabilityIds = [];
  const errors = errorsFor(matrix);
  assert.match(errors, /duplicate current_route \+ capability_id/);
  assert.match(errors, /has no capabilityIds/);
});

test("required semantic arrays cannot be empty", () => {
  const matrix = clone(readMatrix());
  capability(matrix, "mcp-token-create").http = [];
  capability(matrix, "access-key-one-time-reveal").secretExposure.requirements = [];
  capability(matrix, "message-pagination").browserEvidence.references = [];
  const errors = errorsFor(matrix);
  assert.match(errors, /mcp-token-create.*http must not be empty/);
  assert.match(errors, /access-key-one-time-reveal.*requirements must not be empty/);
  assert.match(errors, /message-pagination.*references must not be empty/);
});

test("HTTP methods, success statuses, request DTOs, and stable errors are validated", () => {
  const matrix = clone(readMatrix());
  const contract = capability(matrix, "mcp-token-create").http[0];
  contract.method = "FETCH";
  contract.response.successStatuses = [500];
  contract.requestDto.shape = "";
  contract.stableErrors[0].status = 200;
  const errors = errorsFor(matrix);
  assert.match(errors, /invalid HTTP method/);
  assert.match(errors, /invalid success HTTP status/);
  assert.match(errors, /invalid request DTO contract/);
  assert.match(errors, /invalid stable error contract/);
});

test("tenant, EndUser, Agent, and cluster scopes require explicit status and keys", () => {
  const matrix = clone(readMatrix());
  const row = capability(matrix, "message-rating-lifecycle");
  row.tenantScope.status = "maybe";
  row.endUserScope.keys = [];
  row.agentScope = null;
  const errors = errorsFor(matrix);
  assert.match(errors, /invalid tenantScope/);
  assert.match(errors, /endUserScope.*must not be empty|invalid endUserScope/);
  assert.match(errors, /lacks agentScope|invalid agentScope/);
});

test("persisted read-back is a required structured evidence contract", () => {
  const matrix = clone(readMatrix());
  const row = capability(matrix, "access-key-rotation-correlation");
  row.persistedReadBack.status = "success-toast";
  row.persistedReadBack.references = [];
  const errors = errorsFor(matrix);
  assert.match(errors, /persistedReadBack.*must not be empty/);
  assert.match(errors, /invalid persistedReadBack/);
});

test("every named retained interaction is mutation-sensitive", async (t) => {
  for (const capabilityId of REQUIRED_CAPABILITIES) {
    await t.test(capabilityId, () => {
      const matrix = clone(readMatrix());
      matrix.capabilities = matrix.capabilities.filter((entry) => entry.capabilityId !== capabilityId);
      assert.match(errorsFor(matrix), new RegExp(`required retained capability is missing: ${capabilityId}`));
    });
  }
});

test("named retained interactions require their reviewed methods and endpoints", () => {
  const matrix = clone(readMatrix());
  capability(matrix, "message-rating-lifecycle").http = capability(matrix, "message-rating-lifecycle").http.filter((contract) => contract.method !== "DELETE");
  capability(matrix, "access-key-revoke").http[0].method = "POST";
  capability(matrix, "mcp-tool-acl-policy").http[1].endpoint = "/wrong";
  const errors = errorsFor(matrix);
  assert.match(errors, /message-rating-lifecycle lacks DELETE/);
  assert.match(errors, /access-key-revoke lacks DELETE/);
  assert.match(errors, /mcp-tool-acl-policy lacks PATCH/);
});

test("named DTO, scope, secret, pagination, and correlation semantics are mutation-sensitive", () => {
  const matrix = clone(readMatrix());
  capability(matrix, "mcp-tool-acl-policy").http[1].requestDto.shape =
    "{ exposed?: boolean; minIdentityMode?: string; scopeLabels?: string[] }";
  capability(matrix, "attachment-presign-upload").endUserScope.status = "not-applicable";
  capability(matrix, "access-key-one-time-reveal").secretExposure = {
    status: "confirmed-defect",
    classification: "Redacted secret contract.",
    requirements: ["Redaction required."],
  };
  capability(matrix, "access-key-rotation-correlation").currentBehavior =
    "Rotation replaces one key with another.";
  capability(matrix, "message-pagination").pagination.limit = "A bounded page is loaded.";
  capability(matrix, "attachment-presign-upload").currentBehavior = "Uploads a scoped attachment.";
  capability(matrix, "thread-artifacts").pagination.strategy = "Returns a bounded page.";
  capability(matrix, "message-rating-lifecycle").currentBehavior = "Reads and writes a rating.";
  capability(matrix, "thread-fork").currentBehavior = "Copies a child Thread.";
  const errors = errorsFor(matrix);
  assert.match(errors, /mcp-tool-acl-policy http\.1\.requestDto lacks reviewed semantic fragment allowedPatIds/);
  assert.match(errors, /attachment-presign-upload endUserScope\.status must be enforced/);
  assert.match(errors, /access-key-one-time-reveal secretExposure lacks reviewed semantic fragment private pending material/);
  assert.match(errors, /access-key-rotation-correlation currentBehavior lacks reviewed semantic fragment validUntil/);
  assert.match(errors, /message-pagination pagination lacks reviewed semantic fragment Default 25/);
  assert.match(errors, /attachment-presign-upload currentBehavior lacks reviewed semantic fragment Agent\/Thread boundary/);
  assert.match(errors, /thread-artifacts pagination lacks reviewed semantic fragment createdAt descending/);
  assert.match(errors, /message-rating-lifecycle currentBehavior lacks reviewed semantic fragment userRating\.rating/);
  assert.match(errors, /thread-fork currentBehavior lacks reviewed semantic fragment forkedTurnIds/);
});

test("every capability has source-backed canonical owners or an exact no-backend classification", () => {
  const matrix = clone(readMatrix());
  const backend = capability(matrix, "entity-mcp-bearer-token-create");
  backend.sourceOwnership.services[0].symbol = "MissingBearerServiceOwner";
  const shell = capability(matrix, "route-001");
  shell.sourceOwnership.justification = "No backend.";
  const errors = errorsFor(matrix, true);
  assert.match(errors, /canonical services source lacks owner symbol MissingBearerServiceOwner/);
  assert.match(errors, /route-001 lacks a route-specific no-backend justification/);
});

test("placeholder values and repeated generic core templates are rejected", () => {
  const matrix = clone(readMatrix());
  capability(matrix, "route-001").intent = "x";
  capability(matrix, "route-002").http[0].endpoint = "/bogus";
  for (const id of ["route-002", "route-003", "route-004"]) {
    capability(matrix, id).currentBehavior = "Same source contract.";
  }
  const errors = errorsFor(matrix);
  assert.match(errors, /route-001\.intent contains a rejected placeholder/);
  assert.match(errors, /route-002\.http\[0\]\.endpoint contains a rejected placeholder/);
  assert.match(errors, /3 capabilities reuse a generic currentBehavior template: Same source contract/);
});

test("Entity bearer PAT contracts stay separate from platform tokens", () => {
  const matrix = clone(readMatrix());
  capability(matrix, "entity-mcp-bearer-token-create").http[0].response.shape =
    "Returns a platform token.";
  capability(matrix, "entity-mcp-bearer-token-list").http[0].response.shape =
    "Returns tokens.";
  capability(matrix, "entity-mcp-bearer-token-delete").http[0].method = "POST";
  const errors = errorsFor(matrix);
  assert.match(errors, /entity-mcp-bearer-token-create http lacks reviewed semantic fragment plt_ent_/);
  assert.match(errors, /entity-mcp-bearer-token-list http lacks reviewed semantic fragment McpBearerToken/);
  assert.match(errors, /entity-mcp-bearer-token-delete lacks DELETE/);
});

test("repaired M4 evidence cannot regress", () => {
  const matrix = clone(readMatrix());
  capability(matrix, "mcp-token-list").loaderState.status = "confirmed-defect";
  capability(matrix, "postman-executable-mode").defect.status = "required-not-verified";
  capability(matrix, "postman-executable-mode").persistedReadBack.status = "required-not-verified";
  capability(matrix, "access-key-one-time-reveal").defect.status = "confirmed-defect";
  capability(matrix, "access-key-browser-request-correlation").defect.status = "confirmed-defect";
  capability(matrix, "thread-artifacts").loaderState.status = "confirmed-defect";
  capability(matrix, "thread-artifacts").defect.status = "confirmed-defect";
  capability(matrix, "entity-mcp-bearer-token-create").defect.status = "confirmed-defect";
  capability(matrix, "entity-mcp-bearer-token-create").actionState.status = "confirmed-defect";
  const errors = errorsFor(matrix);
  assert.match(errors, /mcp-token-list loaderState\.status must be implemented/);
  assert.match(errors, /postman-executable-mode defect\.status must be verified/);
  assert.match(errors, /postman-executable-mode persistedReadBack\.status must be verified/);
  assert.match(errors, /access-key-one-time-reveal defect\.status must be verified/);
  assert.match(errors, /access-key-browser-request-correlation defect\.status must be verified/);
  assert.match(errors, /thread-artifacts loaderState\.status must be implemented/);
  assert.match(errors, /thread-artifacts defect\.status must be verified/);
  assert.match(errors, /entity-mcp-bearer-token-create defect\.status must be verified/);
  assert.match(errors, /entity-mcp-bearer-token-create actionState\.status must be implemented/);
});

test("the repaired Agent Tools ownership contract cannot regress to Environment mutation", () => {
  const matrix = clone(readMatrix());
  const row = capability(matrix, "agent-tools-loader-action-mismatch");
  row.http[1].endpoint = "/api/v1/agent/tools/:sourceEntity/:toolName/enabled";
  row.identifiers.values[1] = {
    name: "sourceEntity",
    type: "Entity identity",
    source: "action form",
  };
  row.persistedReadBack.status = "confirmed-defect";
  row.defect.status = "confirmed-defect";
  const errors = errorsFor(matrix);
  assert.match(errors, /required capability agent-tools-loader-action-mismatch lacks PATCH \/api\/v1\/agent\/agents\/:agentId\/tool-mappings\/:toolId/);
  assert.match(errors, /identifiers lacks reviewed semantic fragment toolId/);
  assert.match(errors, /persistedReadBack\.status must be verified/);
  assert.match(errors, /defect\.status must be verified/);
});

test("authenticated loadSurface route evidence cannot regress to static claims", () => {
  const matrix = readMatrix();
  const rows = matrix.capabilities.filter((row) =>
    /^route-\d+$/.test(row.capabilityId) &&
    readFileSync(row.currentRoute, "utf8").includes("loadSurface("),
  );

  assert.equal(rows.length, 44);
  for (const row of rows) {
    assert.equal(row.permission.status, "verified", row.capabilityId);
    assert.equal(row.tenantScope.status, "enforced", row.capabilityId);
    assert.deepEqual(row.tenantScope.keys, ["organizationId", "projectId", "environmentId"], row.capabilityId);
    assert.equal(row.linkState.status, "implemented", row.capabilityId);
    assert.equal(row.recovery.status, "verified", row.capabilityId);
    assert.equal(row.secretExposure.status, "verified", row.capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", row.capabilityId);
    assert.ok(
      row.automatedEvidence.references.includes("apps/webapp/test/authenticatedRouteEvidence.test.ts"),
      row.capabilityId,
    );
  }
});

test("authenticated mutation route evidence cannot regress to static claims", () => {
  const matrix = readMatrix();
  const rows = matrix.capabilities.filter((row) => {
    if (!/^route-\d+$/.test(row.capabilityId)) return false;
    const source = readFileSync(row.currentRoute, "utf8");
    return source.includes("m4Mutation(") || source.includes("mutateAgentConfig(") || row.capabilityId === "route-068";
  });
  const evidence = "apps/webapp/test/authenticatedMutationEvidence.test.ts";

  assert.equal(rows.length, 26);
  for (const row of rows) {
    assert.equal(row.formState.status, "implemented", row.capabilityId);
    assert.match(row.formState.detail, /authenticatedMutationEvidence\.test\.ts/, row.capabilityId);
  }
  for (const capabilityId of ["route-013", "route-014", "route-035", "route-068"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.equal(row.tenantScope.status, "enforced", capabilityId);
    assert.deepEqual(row.tenantScope.keys, ["organizationId", "projectId", "environmentId"], capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }

  const memory = capability(matrix, "route-056");
  assert.equal(memory.destructiveConfirmation.status, "verified");
  assert.match(memory.destructiveConfirmation.references.join(" "), /confirmReplace/);
  const routeFork = capability(matrix, "route-068");
  assert.equal(routeFork.persistedReadBack.status, "verified");
  assert.match(routeFork.persistedReadBack.references.join(" "), /parentThreadId/);

  const postman = capability(matrix, "postman-template-crud");
  assert.equal(postman.permission.status, "verified");
  assert.equal(postman.formState.status, "implemented");
  assert.equal(postman.linkState.status, "implemented");
  assert.equal(postman.recovery.status, "verified");
  assert.equal(postman.secretExposure.status, "verified");
  assert.equal(postman.automatedEvidence.status, "verified");
  assert.equal(postman.pagination.status, "implemented");
  assert.equal(postman.totals.status, "verified");
  assert.match(postman.pagination.limit, /Default 25, maximum 100/);
  assert.match(postman.totals.semantics, /total=42/);

  const fork = capability(matrix, "thread-fork");
  assert.equal(fork.permission.status, "verified");
  assert.equal(fork.recovery.status, "verified");
  assert.equal(fork.secretExposure.status, "verified");
  assert.ok(fork.persistedReadBack.references.includes(evidence));
});

test("direct authenticated credential route evidence cannot regress to static claims", () => {
  const matrix = readMatrix();
  const evidence = "apps/webapp/test/authenticatedCredentialRouteEvidence.test.ts";
  for (const capabilityId of ["route-024", "route-042"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.equal(row.tenantScope.status, "enforced", capabilityId);
    assert.deepEqual(row.tenantScope.keys, ["organizationId", "projectId", "environmentId"], capabilityId);
    assert.equal(row.formState.status, "implemented", capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }

  for (const capabilityId of [
    "access-key-allowed-origins",
    "access-key-browser-request-correlation",
    "access-key-one-time-reveal",
    "access-key-revoke",
    "access-key-rotation-correlation",
  ]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.equal(row.formState.status, "implemented", capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
  assert.equal(capability(matrix, "access-key-allowed-origins").persistedReadBack.status, "verified");
  assert.equal(capability(matrix, "access-key-revoke").persistedReadBack.status, "verified");
  for (const capabilityId of ["access-key-allowed-origins", "access-key-revoke"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.idempotency.status, "verified", capabilityId);
    assert.ok(
      row.idempotency.references.some((reference) => reference.includes("apps/agent/src/auth/auth.service.test.ts")),
      capabilityId,
    );
    assert.equal(row.concurrency.status, "required-not-verified", capabilityId);
    assert.match(row.concurrency.references.join(" "), /PostgreSQL integration/, capabilityId);
    assert.match(row.concurrency.references.join(" "), /fail-closed non-browser runner/, capabilityId);
  }
  assert.equal(capability(matrix, "access-key-rotation-correlation").concurrency.status, "verified");
});

test("focused MCP route and service evidence cannot regress to static claims", () => {
  const matrix = readMatrix();
  const routeEvidence = "apps/webapp/test/mcpManagementRoute.test.ts";
  const managed = [
    "mcp-token-create",
    "mcp-token-list",
    "mcp-token-revoke",
    "entity-mcp-bearer-token-create",
    "entity-mcp-bearer-token-delete",
    "entity-mcp-bearer-token-list",
    "mcp-combined-identity-modes",
    "mcp-identity-context",
    "mcp-tool-acl-policy",
  ];
  for (const capabilityId of managed) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(routeEvidence), capabilityId);
  }
  for (const capabilityId of [
    "mcp-token-list",
    "mcp-token-revoke",
    "entity-mcp-bearer-token-create",
    "entity-mcp-bearer-token-delete",
    "entity-mcp-bearer-token-list",
  ]) {
    assert.equal(capability(matrix, capabilityId).persistedReadBack.status, "verified", capabilityId);
  }
  assert.equal(capability(matrix, "entity-mcp-bearer-token-delete").idempotency.status, "verified");
  assert.equal(capability(matrix, "entity-mcp-bearer-token-delete").concurrency.status, "verified");
  assert.equal(capability(matrix, "mcp-token-revoke").concurrency.status, "verified");
  for (const capabilityId of ["mcp-token-list", "entity-mcp-bearer-token-list"]) {
    assert.equal(capability(matrix, capabilityId).idempotency.status, "not-applicable", capabilityId);
    assert.equal(capability(matrix, capabilityId).concurrency.status, "not-applicable", capabilityId);
  }

  const reference = capability(matrix, "mcp-credential-reference-migration");
  assert.equal(reference.permission.status, "verified");
  assert.equal(reference.formState.status, "implemented");
  assert.equal(reference.linkState.status, "implemented");
  assert.equal(reference.recovery.status, "verified");
  assert.equal(reference.secretExposure.status, "verified");
  assert.equal(reference.automatedEvidence.status, "verified");
  assert.ok(reference.automatedEvidence.references.includes("apps/webapp/test/authenticatedMutationEvidence.test.ts"));
});

test("authenticated custom routes and compatibility redirects cannot regress to static claims", () => {
  const matrix = readMatrix();
  const evidence = "apps/webapp/test/authenticatedCustomRouteEvidence.test.ts";

  for (const capabilityId of ["route-007", "route-008", "route-029", "route-036"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.equal(row.tenantScope.status, "enforced", capabilityId);
    assert.deepEqual(row.tenantScope.keys, ["organizationId", "projectId", "environmentId"], capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
  assert.equal(capability(matrix, "route-007").recovery.status, "not-applicable");
  for (const capabilityId of ["route-008", "route-029", "route-036"]) {
    assert.equal(capability(matrix, capabilityId).recovery.status, "verified", capabilityId);
  }
  assert.equal(capability(matrix, "route-029").agentScope.status, "enforced");
  assert.equal(capability(matrix, "route-029").formState.status, "implemented");
  assert.equal(capability(matrix, "route-036").formState.status, "implemented");

  for (const capabilityId of ["route-031", "route-038", "route-062", "route-064", "route-065", "route-072"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "not-applicable", capabilityId);
    assert.equal(row.tenantScope.status, "not-applicable", capabilityId);
    assert.equal(row.agentScope.status, "not-applicable", capabilityId);
    assert.equal(row.linkState.status, "redirect", capabilityId);
    assert.equal(row.recovery.status, "not-applicable", capabilityId);
    assert.equal(row.secretExposure.status, "not-applicable", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
});

test("focused Agent, EndUser, cluster, and lifecycle evidence cannot regress", () => {
  const matrix = readMatrix();
  assert.equal(capability(matrix, "route-011").clusterScope.status, "enforced");
  for (const capabilityId of ["route-051", "route-052"]) {
    assert.equal(capability(matrix, capabilityId).endUserScope.status, "enforced", capabilityId);
    assert.equal(capability(matrix, capabilityId).agentScope.status, "enforced", capabilityId);
  }

  const attachment = capability(matrix, "attachment-presign-upload");
  assert.equal(attachment.permission.status, "verified");
  assert.equal(attachment.linkState.status, "implemented");
  assert.equal(attachment.destructiveConfirmation.status, "not-applicable");
  assert.equal(attachment.recovery.status, "verified");
  assert.equal(attachment.secretExposure.status, "verified");
  assert.equal(attachment.concurrency.status, "required-not-verified");

  const rating = capability(matrix, "message-rating-lifecycle");
  assert.equal(rating.permission.status, "verified");
  assert.equal(rating.linkState.status, "implemented");
  assert.equal(rating.concurrency.status, "verified");
  assert.equal(rating.recovery.status, "verified");
  assert.equal(rating.secretExposure.status, "verified");
  assert.equal(rating.idempotency.status, "required-not-verified");

  for (const capabilityId of ["message-pagination", "thread-artifacts"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
  }
  const tools = capability(matrix, "agent-tools-loader-action-mismatch");
  assert.equal(tools.linkState.status, "implemented");
  assert.equal(tools.recovery.status, "verified");
  assert.equal(tools.idempotency.status, "required-not-verified");
  assert.equal(tools.concurrency.status, "verified");
  assert.ok(tools.concurrency.references.some((reference) =>
    reference.includes("apps/agent/src/agent-runtime/agent-crud-tool-policy.test.ts"),
  ));
});

test("non-browser exhaustion evidence stays operation-specific and browser claims remain unresolved", () => {
  const matrix = readMatrix();
  const expectedEvidence = [
    ["postman-template-crud", "destructiveConfirmation", "verified", "apps/webapp/test/formSubmission.test.tsx"],
    ["access-key-revoke", "destructiveConfirmation", "verified", "apps/webapp/test/formSubmission.test.tsx"],
    ["access-key-rotation-correlation", "destructiveConfirmation", "verified", "apps/webapp/test/formSubmission.test.tsx"],
    ["mcp-tool-acl-policy", "destructiveConfirmation", "not-applicable", "apps/agent/src/mcp-platform/mcp-tool-acl.service.ts"],
    ["access-key-browser-request-correlation", "idempotency", "verified", "apps/webapp/test/accessKeyLifecycle.test.ts"],
    ["access-key-one-time-reveal", "idempotency", "verified", "apps/webapp/test/accessKeyLifecycle.test.ts"],
    ["access-key-rotation-correlation", "idempotency", "verified", "internal-packages/tenancy-database/src/access-key.test.ts"],
    ["mcp-combined-identity-modes", "idempotency", "verified", "apps/agent/src/mcp-platform/mcp-entity.controller.test.ts"],
    ["mcp-identity-context", "idempotency", "verified", "apps/agent/src/mcp-platform/mcp-entity.controller.test.ts"],
    ["mcp-token-revoke", "idempotency", "verified", "apps/agent/src/mcp-platform/token.service.test.ts"],
    ["mcp-tool-acl-policy", "idempotency", "verified", "apps/agent/src/mcp-platform/mcp-tool-acl.service.test.ts"],
    ["agent-tools-loader-action-mismatch", "concurrency", "verified", "apps/agent/src/agent-runtime/agent-crud-tool-policy.test.ts"],
    ["mcp-combined-identity-modes", "concurrency", "verified", "apps/agent/src/mcp-platform/mcp-entity.controller.test.ts"],
    ["mcp-identity-context", "concurrency", "verified", "apps/agent/src/mcp-platform/mcp-entity.controller.test.ts"],
  ];

  for (const [capabilityId, field, status, reference] of expectedEvidence) {
    const evidence = capability(matrix, capabilityId)[field];
    assert.equal(evidence.status, status, `${capabilityId}.${field}`);
    assert.ok(
      evidence.references.some((entry) => entry.includes(reference)),
      `${capabilityId}.${field} must cite ${reference}`,
    );
  }

  const unresolved = {
    idempotency: [
      "agent-tools-loader-action-mismatch",
      "entity-mcp-bearer-token-create",
      "mcp-credential-reference-migration",
      "mcp-token-create",
      "message-rating-lifecycle",
      "postman-template-crud",
      "thread-fork",
    ],
    concurrency: [
      "access-key-allowed-origins",
      "access-key-revoke",
      "attachment-presign-upload",
      "entity-mcp-bearer-token-create",
      "mcp-credential-reference-migration",
      "mcp-token-create",
      "mcp-tool-acl-policy",
      "postman-template-crud",
      "thread-fork",
    ],
    persistedReadBack: [
      "mcp-credential-reference-migration",
      "postman-template-crud",
    ],
  };
  for (const [field, capabilityIds] of Object.entries(unresolved)) {
    assert.deepEqual(
      matrix.capabilities
        .filter((row) => row[field].status === "required-not-verified")
        .map((row) => row.capabilityId)
        .sort(),
      [...capabilityIds].sort(),
      field,
    );
  }

  const browserRows = matrix.capabilities.filter((row) => row.browserEvidence.status === "required-not-verified");
  assert.equal(browserRows.length, 107);
  assert.equal(matrix.capabilities.some((row) => row.browserEvidence.status === "verified"), false);
});

test("public guest and embed route evidence cannot regress to reflective failures", () => {
  const matrix = readMatrix();
  const evidence = "apps/webapp/test/embedProxy.test.ts";

  for (const capabilityId of ["route-078", "route-079"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.equal(row.tenantScope.status, "enforced", capabilityId);
    assert.deepEqual(row.tenantScope.keys, ["organizationId", "projectId", "environmentId"], capabilityId);
    assert.equal(row.formState.status, "implemented", capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
  assert.equal(capability(matrix, "route-078").agentScope.status, "enforced");

  const embed = capability(matrix, "route-080");
  assert.equal(embed.permission.status, "not-applicable");
  assert.equal(embed.tenantScope.status, "not-applicable");
  assert.equal(embed.agentScope.status, "not-applicable");
  assert.equal(embed.linkState.status, "implemented");
  assert.equal(embed.recovery.status, "not-applicable");
  assert.equal(embed.secretExposure.status, "verified");
  assert.ok(embed.automatedEvidence.references.includes(evidence));

  const health = capability(matrix, "route-081");
  assert.equal(health.permission.status, "not-applicable");
  assert.equal(health.tenantScope.status, "not-applicable");
  assert.equal(health.linkState.status, "implemented");
  assert.equal(health.recovery.status, "not-applicable");
  assert.equal(health.secretExposure.status, "not-applicable");
  assert.equal(health.automatedEvidence.status, "verified");
});

test("layout-only shells cannot claim backend authorization or recovery", () => {
  const matrix = readMatrix();
  for (const capabilityId of ["route-003", "route-026", "route-071", "route-076"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "not-applicable", capabilityId);
    assert.equal(row.tenantScope.status, "not-applicable", capabilityId);
    assert.equal(row.endUserScope.status, "not-applicable", capabilityId);
    assert.equal(row.agentScope.status, "not-applicable", capabilityId);
    assert.equal(row.clusterScope.status, "not-applicable", capabilityId);
    assert.equal(row.linkState.status, "not-applicable", capabilityId);
    assert.equal(row.recovery.status, "not-applicable", capabilityId);
    assert.equal(row.secretExposure.status, "not-applicable", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
  }
});

test("operator session routes cannot regress to token-reflective behavior", () => {
  const matrix = readMatrix();
  const evidence = "apps/webapp/test/operatorSessionRouteEvidence.test.ts";
  for (const capabilityId of ["route-082", "route-083", "route-084"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "not-applicable", capabilityId);
    assert.equal(row.tenantScope.status, "not-applicable", capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
  assert.equal(capability(matrix, "route-082").formState.status, "implemented");
  assert.equal(capability(matrix, "route-083").formState.status, "implemented");

  for (const capabilityId of ["route-001", "route-077"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.equal(row.tenantScope.status, "not-applicable", capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
});

test("direct authenticated database and export routes cannot regress", () => {
  const matrix = readMatrix();
  const evidence = "apps/webapp/test/authenticatedDirectRouteEvidence.test.ts";
  for (const capabilityId of ["route-009", "route-047", "route-048", "route-057"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.equal(row.tenantScope.status, "enforced", capabilityId);
    assert.deepEqual(row.tenantScope.keys, ["organizationId", "projectId", "environmentId"], capabilityId);
    assert.equal(row.linkState.status, "implemented", capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
  assert.equal(capability(matrix, "route-048").formState.status, "implemented");
});

test("authenticated Organization and Project route evidence cannot regress to static claims", () => {
  const matrix = readMatrix();
  const evidence = "apps/webapp/test/authenticatedOrganizationRouteEvidence.test.ts";
  const fullAncestry = ["route-002", "route-004", "route-006", "route-074"];
  const organizationOnly = ["route-005", "route-073", "route-075"];

  for (const capabilityId of [...fullAncestry, ...organizationOnly]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.permission.status, "verified", capabilityId);
    assert.ok(["enforced", "organization-only"].includes(row.tenantScope.status), capabilityId);
    assert.equal(row.recovery.status, "verified", capabilityId);
    assert.equal(row.secretExposure.status, "verified", capabilityId);
    assert.equal(row.automatedEvidence.status, "verified", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
    assert.equal(row.browserEvidence.status, "required-not-verified", capabilityId);
  }
  for (const capabilityId of fullAncestry) {
    assert.deepEqual(
      capability(matrix, capabilityId).tenantScope.keys,
      ["organizationId", "projectId", "environmentId"],
      capabilityId,
    );
  }
  for (const capabilityId of ["route-002", "route-004", "route-006"]) {
    const row = capability(matrix, capabilityId);
    assert.match(row.currentBehavior, /MEMBER requires explicit ProjectMembership/, capabilityId);
    assert.match(row.permission.requirement, /same-Organization MEMBER/, capabilityId);
    assert.match(row.permission.requirement, /without explicit ProjectMembership/, capabilityId);
  }
  for (const capabilityId of organizationOnly) {
    assert.equal(capability(matrix, capabilityId).tenantScope.status, "organization-only", capabilityId);
    assert.deepEqual(capability(matrix, capabilityId).tenantScope.keys, ["organizationId"], capabilityId);
  }
  for (const capabilityId of ["route-005", "route-073", "route-074", "route-075"]) {
    assert.equal(capability(matrix, capabilityId).formState.status, "implemented", capabilityId);
  }
});

test("reviewed Agent isolation evidence stays operation-specific", () => {
  const matrix = readMatrix();
  const expectedEvidence = {
    "route-027": "apps/agent/src/agent-runtime/agent-tenancy-cutover.test.ts",
    "route-028": "apps/agent/src/agent-runtime/agent-crud-version-skills.test.ts",
    "route-030": "apps/agent/src/agent-runtime/agent-tenancy-cutover.test.ts",
    "route-032": "apps/agent/src/memory/conversation-pagination.test.ts",
    "route-033": "apps/agent/src/agent-runtime/agent-crud-version-skills.test.ts",
    "route-034": "apps/agent/src/agent-runtime/agent.controller.postman.test.ts",
    "route-035": "apps/agent/src/agent-runtime/agent-tenancy-cutover.test.ts",
    "route-036": "apps/agent/src/skills/skill-registry.service.test.ts",
    "route-037": "apps/agent/src/agent-runtime/agent-crud-tool-policy.test.ts",
    "route-039": "apps/agent/src/agent-runtime/agent-crud-version-skills.test.ts",
    "route-050": "apps/agent/src/files/files.controller.test.ts",
  };

  for (const [capabilityId, evidence] of Object.entries(expectedEvidence)) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.agentScope.status, "enforced", capabilityId);
    assert.deepEqual(row.agentScope.keys, ["agentId"], capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
});

test("focused direct Tool, Canary, and Agent Tool forms cannot regress", () => {
  const matrix = readMatrix();
  const evidence = "apps/webapp/test/authenticatedScopedFormRouteEvidence.test.ts";
  for (const capabilityId of ["route-025", "route-028", "route-037"]) {
    const row = capability(matrix, capabilityId);
    assert.equal(row.formState.status, "implemented", capabilityId);
    assert.ok(row.automatedEvidence.references.includes(evidence), capabilityId);
  }
});

test("reviewed v0 dispositions cannot regress", async (t) => {
  const cases = [
    ["agent-connect.mint-token.ts", "intentional-removal"],
    ["agent-orgs.$orgId/route.tsx", "redirect"],
    ["agent-orgs._index/route.tsx", "redirect"],
    ["agent-orgs.new/route.tsx", "redirect"],
    ["settings.mcp-tokens/route.tsx", "redirect"],
    ["api.v1.agent.attachments.presigned.ts", "improve"],
  ];
  for (const [suffix, expected] of cases) {
    await t.test(suffix, () => {
      const matrix = clone(readMatrix());
      v0Route(matrix, suffix).disposition = expected === "intentional-removal" ? "redirect" : "requires-product-decision";
      assert.match(errorsFor(matrix), new RegExp(`must be ${expected}`));
    });
  }
});

test("security deletion and compatibility targets are semantically pinned", () => {
  const matrix = clone(readMatrix());
  const mintToken = v0Route(matrix, "agent-connect.mint-token.ts");
  mintToken.rationale = "old endpoint";
  mintToken.currentRoute = matrix.currentRoutes[0].path;
  mintToken.capabilityId = matrix.currentRoutes[0].capabilityIds[0];
  v0Route(matrix, "agent-orgs.new/route.tsx").currentRoute = matrix.currentRoutes[0].path;
  v0Route(matrix, "api.v1.agent.attachments.presigned.ts").capabilityId = "route-001";
  const errors = errorsFor(matrix);
  assert.match(errors, /lacks security deletion rationale/);
  assert.match(errors, /is a deletion and must not retain a current target/);
  assert.match(errors, /agent-orgs\.new.*wrong current compatibility target/);
  assert.match(errors, /attachments\.presigned.*wrong retained capability/);
});

test("browser verification cannot be claimed without concrete evidence", () => {
  const matrix = clone(readMatrix());
  const row = capability(matrix, "postman-template-crud");
  row.browserEvidence.status = "verified";
  row.browserEvidence.references = [];
  assert.match(errorsFor(matrix), /browserEvidence.*must not be empty|invalid browserEvidence/);
});

test("completion is a separate expected-red gate with actionable blocker counts", () => {
  const matrix = readMatrix();
  const blockers = completionBlockers(matrix);
  assert.equal(blockers.find((blocker) => blocker.category === "confirmed defects"), undefined);
  assert.equal(blockers.find((blocker) => blocker.category === "destructive confirmation"), undefined);
  assert.deepEqual(
    blockers.map(({ category, count }) => ({ category, count })),
    [
      { category: "idempotency", count: 7 },
      { category: "concurrency", count: 9 },
      { category: "persisted-state evidence", count: 2 },
      { category: "browser evidence", count: 107 },
    ],
  );
  assert.throws(() => runCompletionGate(matrix), /completion gate is RED \(125 actionable blockers across 4 categories\)/);
});

test("every acceptance-critical completion category rejects unresolved and confirmed-defect states", async (t) => {
  const cases = [
    ["permission", "permission", "verified"],
    ["organization scope", "tenantScope", "enforced", "organizationId"],
    ["project scope", "tenantScope", "enforced", "projectId"],
    ["environment scope", "tenantScope", "enforced", "environmentId"],
    ["EndUser scope", "endUserScope", "not-applicable"],
    ["Agent scope", "agentScope", "not-applicable"],
    ["cluster scope", "clusterScope", "not-applicable"],
    ["loader behavior", "loaderState", "implemented"],
    ["action behavior", "actionState", "not-applicable"],
    ["form behavior", "formState", "not-applicable"],
    ["link behavior", "linkState", "implemented"],
    ["destructive confirmation", "destructiveConfirmation", "not-applicable"],
    ["idempotency", "idempotency", "not-applicable"],
    ["concurrency", "concurrency", "not-applicable"],
    ["recovery", "recovery", "not-applicable"],
    ["secret exposure", "secretExposure", "verified"],
  ];
  for (const [category, field, approvedStatus, tenantKey] of cases) {
    await t.test(category, () => {
      const matrix = clone(readMatrix());
      for (const row of matrix.capabilities) {
        row[field].status = approvedStatus;
        if (tenantKey && !row[field].keys.includes(tenantKey)) row[field].keys.push(tenantKey);
      }
      assert.equal(completionBlockers(matrix).find((blocker) => blocker.category === category), undefined);

      const row = capability(matrix, "route-001");
      row[field].status = "required-not-verified";
      assert.deepEqual(completionBlockers(matrix).find((blocker) => blocker.category === category)?.capabilityIds, ["route-001"]);

      row[field].status = "confirmed-defect";
      assert.deepEqual(completionBlockers(matrix).find((blocker) => blocker.category === category)?.capabilityIds, ["route-001"]);
    });
  }
});

test("capability design references cannot drift outside the governing manifest", () => {
  const matrix = clone(readMatrix());
  capability(matrix, "thread-fork").designReferences = ["not-a-governing-reference.dc.html"];
  assert.match(errorsFor(matrix, true), /uses unknown design reference/);
});

test("Markdown generation is deterministic", () => {
  const matrix = readMatrix();
  assert.equal(renderMarkdown(matrix), renderMarkdown(clone(matrix)));
});
