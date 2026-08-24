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
  assert.ok(blockers.find((blocker) => blocker.category === "permission")?.count > 0);
  assert.ok(blockers.find((blocker) => blocker.category === "persisted-state evidence")?.count > 0);
  assert.ok(blockers.find((blocker) => blocker.category === "browser evidence")?.count > 0);
  assert.throws(() => runCompletionGate(matrix), /completion gate is RED \(\d+ actionable blockers across \d+ categories\)/);
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
