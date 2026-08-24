#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MATRIX_PATH = join(ROOT, "docs/audits/win-234-route-capability-parity.json");
export const SUMMARY_PATH = join(ROOT, "docs/audits/win-234-route-capability-parity.generated.md");

export const EXPECTED_BASELINES = Object.freeze({
  currentRoutes: 84,
  v0TotalFiles: 429,
  v0TypeScriptFiles: 428,
  v0VerifiedTypeScriptRoutes: 427,
  v0NonTypeScriptFiles: 1,
});
export const V0_EXCLUDED_TEST_MODULE =
  "apps/webapp/app/routes/projects.v3.$projectRef.test.ts";
export const V0_PRODUCTION_TEST_SEGMENT_ROUTE =
  "apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.test.ai-generate-payload.tsx";

const RETAINED_DISPOSITIONS = new Set(["retain", "improve", "redirect"]);
const V0_DISPOSITIONS = new Set([
  ...RETAINED_DISPOSITIONS,
  "intentional-removal",
  "requires-product-decision",
]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "NONE"]);
const EVIDENCE_STATUSES = new Set(["verified", "static-contract-only", "required-not-verified", "not-applicable", "justified-exclusion", "confirmed-defect"]);
const APPLICABILITY_STATUSES = new Set(["implemented", "redirect", "required-not-verified", "not-applicable", "confirmed-defect"]);
const SCOPE_STATUSES = new Set(["enforced", "required-not-verified", "not-applicable", "confirmed-defect"]);
const COMPLETION_EVIDENCE_STATUSES = new Set(["verified", "not-applicable", "justified-exclusion"]);
const COMPLETION_SCOPE_STATUSES = new Set(["enforced", "not-applicable"]);
const COMPLETION_STATE_STATUSES = new Set(["implemented", "redirect", "not-applicable"]);

const REQUIRED_CAPABILITY_FIELDS = [
  "currentRoute",
  "capabilityId",
  "intent",
  "disposition",
  "v0Behavior",
  "currentBehavior",
  "http",
  "identifiers",
  "tenantScope",
  "endUserScope",
  "agentScope",
  "clusterScope",
  "permission",
  "loaderState",
  "actionState",
  "formState",
  "linkState",
  "persistedReadBack",
  "pagination",
  "totals",
  "destructiveConfirmation",
  "idempotency",
  "concurrency",
  "recovery",
  "secretExposure",
  "automatedEvidence",
  "browserEvidence",
  "designReferences",
  "ownershipIssues",
  "defect",
  "sourceOwnership",
];

const REQUIRED_CAPABILITY_CONTRACTS = Object.freeze({
  "mcp-token-create": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx",
    methods: [["POST", "/api/v1/agent/mcp/platform/tokens"]],
  },
  "mcp-token-list": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx",
    methods: [["GET", "/api/v1/agent/mcp/platform/tokens"]],
  },
  "mcp-token-revoke": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx",
    methods: [["POST", "/api/v1/agent/mcp/platform/tokens/:id/revoke"]],
  },
  "mcp-tool-acl-policy": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx",
    methods: [
      ["GET", "/api/v1/agent/mcp/entity/:entityId/tool-acl"],
      ["PATCH", "/api/v1/agent/mcp/entity/:entityId/tool-acl/:toolId"],
      ["POST", "/api/v1/agent/mcp/entity/:entityId/tool-acl/bulk"],
    ],
  },
  "mcp-combined-identity-modes": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx",
    methods: [["PATCH", "/api/v1/agent/entities/:entityId/mcp/config"]],
  },
  "mcp-identity-context": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx",
    methods: [["PATCH", "/api/v1/agent/entities/:entityId/mcp/config"]],
  },
  "mcp-credential-reference-migration": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx",
    methods: [["POST", "/api/v1/agent/entities"]],
  },
  "postman-template-crud": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx",
    methods: [
      ["GET", "/api/v1/agent/postman-templates?agentId=:agentId"],
      ["POST", "/api/v1/agent/postman-templates"],
      ["PUT", "/api/v1/agent/postman-templates/:id"],
      ["DELETE", "/api/v1/agent/postman-templates/:id"],
    ],
  },
  "postman-executable-mode": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx",
    methods: [["NONE", "Socket.IO Agent Postman execution"]],
    defect: true,
  },
  "entity-mcp-bearer-token-list": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx",
    methods: [["GET", "/api/v1/agent/mcp/entity/:entityId/tokens"]],
  },
  "entity-mcp-bearer-token-create": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx",
    methods: [["POST", "/api/v1/agent/mcp/entity/:entityId/tokens"]],
  },
  "entity-mcp-bearer-token-delete": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps.$entityId._index/route.tsx",
    methods: [["DELETE", "/api/v1/agent/mcp/entity/:entityId/tokens/:tokenId"]],
  },
  "attachment-presign-upload": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx",
    methods: [["POST", "/api/v1/agent/attachments/presigned"]],
  },
  "thread-artifacts": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route.tsx",
    methods: [["GET", "/api/v1/agent/threads/:threadId/artifacts"]],
  },
  "message-rating-lifecycle": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx",
    methods: [
      ["GET", "/api/v1/agent/messages/:messageId/rating"],
      ["POST", "/api/v1/agent/messages/:messageId/rating"],
      ["DELETE", "/api/v1/agent/messages/:messageId/rating"],
    ],
  },
  "thread-fork": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route.tsx",
    methods: [["POST", "/api/v1/agent/threads/:threadId/fork"]],
  },
  "message-pagination": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.threads.$threadId/route.tsx",
    methods: [["GET", "/api/v1/agent/threads/:threadId/messages"]],
  },
  "access-key-one-time-reveal": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx",
    methods: [["POST", "/api/v1/agent/access-key"]],
  },
  "access-key-rotation-correlation": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx",
    methods: [
      ["GET", "/api/v1/agent/access-key"],
      ["POST", "/api/v1/agent/access-key"],
    ],
  },
  "access-key-revoke": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx",
    methods: [["DELETE", "/api/v1/agent/access-key"]],
  },
  "access-key-allowed-origins": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx",
    methods: [["POST", "/api/v1/agent/access-key/origins"]],
  },
  "access-key-browser-request-correlation": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx",
    methods: [["POST", "/api/v1/agent/access-key"]],
    defect: true,
  },
  "agent-tools-loader-action-mismatch": {
    route: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.tools/route.tsx",
    methods: [
      ["GET", "/api/v1/agent/agents/:agentId/tool-mappings"],
      ["PATCH", "/api/v1/agent/tools/:sourceEntity/:toolName/enabled"],
    ],
    defect: true,
  },
});

const REQUIRED_SEMANTIC_FRAGMENTS = Object.freeze({
  "mcp-token-create": {
    fragments: { http: ["name", "permissions", "ttlSeconds", "tier"], secretExposure: ["plt_mcp_", "tokenHash"] },
    statuses: { "tenantScope.status": "enforced", "actionState.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
  "mcp-token-list": {
    fragments: { http: ["permissions", "revokedAt", "createdAt"], secretExposure: ["tokenHash"] },
    statuses: { "tenantScope.status": "enforced", "loaderState.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
  "mcp-token-revoke": {
    fragments: { http: ["id missing", "scoped token not found"] },
    statuses: { "tenantScope.status": "enforced", "actionState.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
  "mcp-tool-acl-policy": {
    fragments: {
      "http.0.response": ["exposed", "minIdentityMode", "allowedPatIds", "scopeLabels", "lastReviewedAt"],
      "http.1.requestDto": ["exposed", "minIdentityMode", "allowedPatIds", "scopeLabels"],
      "http.2.requestDto": ["expose", "hide", "set_identity", "toolIds"],
    },
    statuses: { "defect.status": "confirmed-defect" },
  },
  "mcp-combined-identity-modes": {
    fragments: { currentBehavior: ["bearer+oidc+anonymous"], defect: ["plus-delimited"] },
    statuses: { "persistedReadBack.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
  "mcp-identity-context": {
    fragments: { http: ["identityProviders", "branding", "redirectUriAllowlist", "rateLimitPerMinute"] },
    statuses: { "tenantScope.status": "enforced", "endUserScope.status": "enforced" },
  },
  "mcp-credential-reference-migration": {
    fragments: { http: ["credsSecretKey", "headersTemplate"], secretExposure: ["bare same-Environment name", "plaintext"] },
    statuses: { "tenantScope.status": "enforced" },
  },
  "postman-template-crud": {
    fragments: { identifiers: ["agentId", "templateId"] },
    statuses: { "agentScope.status": "enforced", "persistedReadBack.status": "required-not-verified" },
  },
  "postman-executable-mode": {
    fragments: {
      currentBehavior: ["executable Postman control is absent"],
      identifiers: ["simulateEndUserId", "sessionContextOverride"],
      permission: ["Organization OWNER or ADMIN"],
    },
    statuses: { "defect.status": "confirmed-defect", "persistedReadBack.status": "confirmed-defect" },
  },
  "entity-mcp-bearer-token-list": {
    fragments: { http: ["plt_ent_", "McpBearerToken", "tokenHash"] },
    statuses: { "tenantScope.status": "enforced", "agentScope.status": "not-applicable", "loaderState.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
  "entity-mcp-bearer-token-create": {
    fragments: { http: ["label", "scopes", "expiresIn", "plt_ent_"], secretExposure: ["shown once", "tokenHash"] },
    statuses: { "tenantScope.status": "enforced", "actionState.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
  "entity-mcp-bearer-token-delete": {
    fragments: { identifiers: ["entityId", "tokenId"], http: ["revoked"] },
    statuses: { "destructiveConfirmation.status": "required-not-verified", "tenantScope.status": "enforced", "actionState.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
  "attachment-presign-upload": {
    fragments: { currentBehavior: ["resolves attachmentIds", "no canonical presign/upload control"], secretExposure: ["presigned", "object-store"] },
    statuses: { "endUserScope.status": "enforced", "agentScope.status": "enforced", "defect.status": "confirmed-defect" },
  },
  "thread-artifacts": {
    fragments: { identifiers: ["threadId"], totals: ["bounded page"] },
    statuses: { "endUserScope.status": "enforced", "agentScope.status": "enforced", "loaderState.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
  "message-rating-lifecycle": {
    fragments: { http: ["rating: 1 | -1", "Rating must be +1 or -1", "Invalid message id"] },
    statuses: { "endUserScope.status": "enforced", "agentScope.status": "enforced", "defect.status": "confirmed-defect" },
  },
  "thread-fork": {
    fragments: { identifiers: ["threadId", "messageId"], linkState: ["child Thread"] },
    statuses: { "persistedReadBack.status": "required-not-verified", "defect.status": "confirmed-defect" },
  },
  "message-pagination": {
    fragments: { currentBehavior: ["limit=100&allUsers=true"], pagination: ["Hard-coded limit=100", "No total"] },
    statuses: { "pagination.status": "confirmed-defect", "totals.status": "confirmed-defect", "persistedReadBack.status": "confirmed-defect" },
  },
  "access-key-one-time-reveal": {
    fragments: { http: ["keyHash", "keyPrefix", "Raw key material is not accepted"], secretExposure: ["private pending material", "persistence success"] },
    statuses: { "tenantScope.status": "enforced", "defect.status": "confirmed-defect", "persistedReadBack.status": "confirmed-defect" },
  },
  "access-key-rotation-correlation": {
    fragments: { currentBehavior: ["validUntil", "replacedById"], concurrency: ["Environment row lock", "one-active-per-Environment"] },
    statuses: { "concurrency.status": "static-contract-only", "persistedReadBack.status": "required-not-verified" },
  },
  "access-key-revoke": {
    fragments: { currentBehavior: ["active/unexpired", "Environment-owned"] },
    statuses: { "destructiveConfirmation.status": "required-not-verified", "tenantScope.status": "enforced" },
  },
  "access-key-allowed-origins": {
    fragments: { http: ["origins: string[]"] },
    statuses: { "persistedReadBack.status": "required-not-verified" },
  },
  "access-key-browser-request-correlation": {
    fragments: { currentBehavior: ["no attempt ID"], secretExposure: ["private pending material", "attempt ID"] },
    statuses: { "defect.status": "confirmed-defect", "persistedReadBack.status": "confirmed-defect" },
  },
  "agent-tools-loader-action-mismatch": {
    fragments: { currentBehavior: ["Agent-specific", "Environment-level"], identifiers: ["agentId", "sourceEntity", "toolName"] },
    statuses: { "persistedReadBack.status": "confirmed-defect", "defect.status": "confirmed-defect" },
  },
});

const REVIEWED_V0_DISPOSITIONS = Object.freeze({
  "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-connect.mint-token.ts": {
    disposition: "intentional-removal",
    rationale: "security deletion",
    noCurrentTarget: true,
  },
  "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-orgs.$orgId/route.tsx": {
    disposition: "redirect",
    currentRoute: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.$entityId/route.tsx",
  },
  "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-orgs._index/route.tsx": {
    disposition: "redirect",
    currentRoute: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities._index/route.tsx",
  },
  "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-orgs.new/route.tsx": {
    disposition: "redirect",
    currentRoute: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities.new/route.tsx",
  },
  "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.mcp-tokens/route.tsx": {
    disposition: "redirect",
    currentRoute: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations.mcp/route.tsx",
  },
  "apps/webapp/app/routes/api.v1.agent.attachments.presigned.ts": {
    disposition: "improve",
    currentRoute: "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx",
    capabilityId: "attachment-presign-upload",
  },
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function walk(root) {
  const files = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

export function hashTree(root, repositoryRoot = ROOT) {
  const absoluteRoot = resolve(repositoryRoot, root);
  const records = walk(absoluteRoot).map((path) => {
    const repositoryPath = relative(repositoryRoot, path).split("\\").join("/");
    return `${repositoryPath}\0${sha256(readFileSync(path))}\n`;
  });
  return sha256(records.join(""));
}

export function currentRouteInventory(repositoryRoot = ROOT) {
  const routesRoot = join(repositoryRoot, "apps/webapp/app/routes");
  return walk(routesRoot)
    .filter((path) => {
      const routePath = relative(routesRoot, path).split("\\").join("/");
      const directRouteModule = !routePath.includes("/") && /\.(?:js|jsx|ts|tsx)$/.test(routePath);
      const nestedRouteModule = /(^|\/)route\.(?:js|jsx|ts|tsx)$/.test(routePath);
      return (directRouteModule || nestedRouteModule) && !/\.(?:test|spec)\./.test(routePath);
    })
    .map((path) => relative(repositoryRoot, path).split("\\").join("/"))
    .sort();
}

function gitObjectExists(commit, repositoryRoot = ROOT) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repositoryRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function v0RouteInventory(commit, repositoryRoot = ROOT) {
  if (!gitObjectExists(commit, repositoryRoot)) return null;
  const output = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", commit, "--", "apps/webapp/app/routes"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const allFiles = output.split("\n").filter(Boolean).sort();
  const typeScriptFiles = allFiles.filter((path) => /\.(?:ts|tsx)$/.test(path));
  const excludedTestModules = typeScriptFiles.filter((path) => path === V0_EXCLUDED_TEST_MODULE);
  const verifiedTypeScriptRoutes = typeScriptFiles.filter((path) => path !== V0_EXCLUDED_TEST_MODULE);
  const nonTypeScriptFiles = allFiles.filter((path) => !/\.(?:ts|tsx)$/.test(path));
  return { allFiles, typeScriptFiles, excludedTestModules, verifiedTypeScriptRoutes, nonTypeScriptFiles };
}

export function readMatrix(path = MATRIX_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function duplicates(values) {
  const seen = new Set();
  return [...new Set(values.filter((value) => (seen.has(value) ? true : !seen.add(value))))];
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function emptyArrayPaths(value, path = "capability") {
  if (Array.isArray(value)) {
    if (value.length === 0) return [path];
    return value.flatMap((entry, index) => emptyArrayPaths(entry, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => emptyArrayPaths(entry, `${path}.${key}`));
}

const PLACEHOLDER_PATTERNS = [
  /^x$/i,
  /\/bogus(?:\/|$)/i,
  /\b(?:placeholder|lorem ipsum|tbd|todo|fixme)\b/i,
  /generic repeated template/i,
];

function placeholderPaths(value, path = "capability") {
  if (typeof value === "string") {
    return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value)) ? [path] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => placeholderPaths(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => placeholderPaths(entry, `${path}.${key}`));
}

function validateState(errors, capability, field) {
  const value = capability[field];
  if (!value || !APPLICABILITY_STATUSES.has(value.status) || !hasText(value.detail)) {
    errors.push(`capability ${capability.capabilityId} has invalid ${field}`);
  }
}

function validateScope(errors, capability, field) {
  const value = capability[field];
  if (!value || !SCOPE_STATUSES.has(value.status) || !Array.isArray(value.keys) || value.keys.length === 0) {
    errors.push(`capability ${capability.capabilityId} has invalid ${field}`);
  }
}

function validateEvidence(errors, capability, field) {
  const value = capability[field];
  if (!value || !EVIDENCE_STATUSES.has(value.status) || !Array.isArray(value.references) || value.references.length === 0 || value.references.some((entry) => !hasText(entry))) {
    errors.push(`capability ${capability.capabilityId} has invalid ${field}`);
  }
}

function hasMethodEndpoint(capability, method, endpoint) {
  return capability.http?.some((contract) => contract.method === method && contract.endpoint === endpoint);
}

function nestedValue(value, path) {
  return path.split(".").reduce((entry, key) => entry?.[key], value);
}

function validateSourceOwnership(errors, capability, repositoryRoot, inspectRepository) {
  const ownership = capability.sourceOwnership;
  if (!ownership || !["canonical-backend", "justified-no-backend"].includes(ownership.classification)) {
    errors.push(`capability ${capability.capabilityId} lacks a valid sourceOwnership classification`);
    return;
  }
  if (!Array.isArray(ownership.sourceEvidence) || ownership.sourceEvidence.length === 0) {
    errors.push(`capability ${capability.capabilityId} lacks sourceOwnership evidence`);
    return;
  }
  if (ownership.classification === "canonical-backend") {
    for (const layer of ["controllers", "services", "models"]) {
      if (!Array.isArray(ownership[layer]) || ownership[layer].length === 0) {
        errors.push(`capability ${capability.capabilityId} lacks canonical ${layer}`);
        continue;
      }
      for (const owner of ownership[layer]) {
        if (!hasText(owner.symbol) || !hasText(owner.source)) errors.push(`capability ${capability.capabilityId} has invalid canonical ${layer} owner`);
      }
    }
  } else if (!hasText(ownership.justification) || !ownership.justification.includes(capability.currentRoute)) {
    errors.push(`capability ${capability.capabilityId} lacks a route-specific no-backend justification`);
  }
  for (const evidence of ownership.sourceEvidence) {
    if (!hasText(evidence.source) || !Array.isArray(evidence.fragments) || evidence.fragments.length === 0 || evidence.fragments.some((fragment) => !hasText(fragment) || fragment.length < 4)) {
      errors.push(`capability ${capability.capabilityId} has invalid sourceOwnership evidence`);
      continue;
    }
    if (!inspectRepository) continue;
    const absolutePath = join(repositoryRoot, evidence.source);
    if (!existsSync(absolutePath)) {
      errors.push(`capability ${capability.capabilityId} ownership source is missing: ${evidence.source}`);
      continue;
    }
    const source = readFileSync(absolutePath, "utf8");
    for (const fragment of evidence.fragments) {
      if (!source.includes(fragment)) errors.push(`capability ${capability.capabilityId} ownership source ${evidence.source} lacks exact fragment ${fragment}`);
    }
  }
  if (inspectRepository && ownership.classification === "canonical-backend") {
    for (const layer of ["controllers", "services", "models"]) {
      for (const owner of ownership[layer] ?? []) {
        const absolutePath = join(repositoryRoot, owner.source);
        if (!existsSync(absolutePath)) {
          errors.push(`capability ${capability.capabilityId} canonical ${layer} source is missing: ${owner.source}`);
          continue;
        }
        if (!readFileSync(absolutePath, "utf8").includes(owner.symbol)) errors.push(`capability ${capability.capabilityId} canonical ${layer} source lacks owner symbol ${owner.symbol}`);
      }
    }
  }
}

function validateCapability(errors, capability, currentRoutePaths, repositoryRoot, inspectRepository) {
  for (const field of REQUIRED_CAPABILITY_FIELDS) {
    if (capability[field] === null || capability[field] === undefined || capability[field] === "") {
      errors.push(`capability ${capability.capabilityId ?? "<missing>"} lacks ${field}`);
    }
  }
  if (!hasText(capability.capabilityId) || !hasText(capability.currentRoute)) return;
  for (const path of emptyArrayPaths(capability, `capability ${capability.capabilityId}`)) {
    errors.push(`${path} must not be empty`);
  }
  for (const path of placeholderPaths(capability, `capability ${capability.capabilityId}`)) errors.push(`${path} contains a rejected placeholder`);
  if (!currentRoutePaths.has(capability.currentRoute)) {
    errors.push(`capability ${capability.capabilityId} references unknown current route ${capability.currentRoute}`);
  }
  if (!RETAINED_DISPOSITIONS.has(capability.disposition)) {
    errors.push(`capability ${capability.capabilityId} has invalid disposition ${capability.disposition}`);
  }
  if (!Array.isArray(capability.http) || capability.http.length === 0) {
    errors.push(`capability ${capability.capabilityId} has no HTTP contracts`);
  } else {
    for (const contract of capability.http) {
      if (!HTTP_METHODS.has(contract.method) || !hasText(contract.endpoint) || !hasText(contract.role)) {
        errors.push(`capability ${capability.capabilityId} has invalid HTTP method/endpoint/role`);
      }
      if (!contract.requestDto || !EVIDENCE_STATUSES.has(contract.requestDto.status) || !hasText(contract.requestDto.shape)) {
        errors.push(`capability ${capability.capabilityId} has invalid request DTO contract`);
      }
      if (!contract.response || !Array.isArray(contract.response.successStatuses) || contract.response.successStatuses.length === 0 || !hasText(contract.response.shape)) {
        errors.push(`capability ${capability.capabilityId} has invalid response contract`);
      } else if (contract.method !== "NONE" && contract.response.successStatuses.some((status) => !Number.isInteger(status) || status < 200 || status >= 400)) {
        errors.push(`capability ${capability.capabilityId} has invalid success HTTP status`);
      }
      if (!Array.isArray(contract.stableErrors) || contract.stableErrors.length === 0 || contract.stableErrors.some((error) => !hasText(error.codeOrMessage) || !(error.status === "not-applicable" || (Number.isInteger(error.status) && error.status >= 400 && error.status < 600)))) {
        errors.push(`capability ${capability.capabilityId} has invalid stable error contract`);
      }
    }
  }
  if (!capability.identifiers || !EVIDENCE_STATUSES.has(capability.identifiers.status) || !Array.isArray(capability.identifiers.values) || capability.identifiers.values.length === 0 || capability.identifiers.values.some((identifier) => !hasText(identifier.name) || !hasText(identifier.type) || !hasText(identifier.source))) {
    errors.push(`capability ${capability.capabilityId} has invalid identifiers`);
  }
  for (const field of ["tenantScope", "endUserScope", "agentScope", "clusterScope"]) validateScope(errors, capability, field);
  if (!capability.permission || !EVIDENCE_STATUSES.has(capability.permission.status) || !hasText(capability.permission.requirement)) {
    errors.push(`capability ${capability.capabilityId} has invalid permission`);
  }
  for (const field of ["loaderState", "actionState", "formState", "linkState"]) validateState(errors, capability, field);
  for (const field of ["persistedReadBack", "automatedEvidence", "browserEvidence"]) validateEvidence(errors, capability, field);
  if (!capability.pagination || !APPLICABILITY_STATUSES.has(capability.pagination.status) || !hasText(capability.pagination.strategy) || !hasText(capability.pagination.limit) || !hasText(capability.pagination.totalStatus)) {
    errors.push(`capability ${capability.capabilityId} has invalid pagination`);
  }
  if (!capability.totals || !EVIDENCE_STATUSES.has(capability.totals.status) || !hasText(capability.totals.semantics)) {
    errors.push(`capability ${capability.capabilityId} has invalid totals`);
  }
  for (const field of ["destructiveConfirmation", "idempotency", "concurrency", "recovery"]) validateEvidence(errors, capability, field);
  if (!capability.secretExposure || !EVIDENCE_STATUSES.has(capability.secretExposure.status) || !hasText(capability.secretExposure.classification) || !Array.isArray(capability.secretExposure.requirements) || capability.secretExposure.requirements.length === 0) {
    errors.push(`capability ${capability.capabilityId} has invalid secretExposure`);
  }
  if (!Array.isArray(capability.designReferences) || capability.designReferences.length === 0 || !Array.isArray(capability.ownershipIssues) || capability.ownershipIssues.length === 0) {
    errors.push(`capability ${capability.capabilityId} lacks design or ownership references`);
  }
  if (!capability.defect || !EVIDENCE_STATUSES.has(capability.defect.status) || !hasText(capability.defect.summary)) {
    errors.push(`capability ${capability.capabilityId} has invalid defect contract`);
  }
  validateSourceOwnership(errors, capability, repositoryRoot, inspectRepository);
}

export function validateMatrix(matrix, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? ROOT;
  const inspectRepository = options.inspectRepository ?? true;
  const errors = [];
  const currentRoutes = matrix.currentRoutes ?? [];
  const v0Routes = matrix.v0Routes ?? [];
  const capabilities = matrix.capabilities ?? [];

  if (matrix.schemaVersion !== "2.0") errors.push("schemaVersion must be 2.0");
  if (currentRoutes.length !== EXPECTED_BASELINES.currentRoutes) errors.push(`current route count is ${currentRoutes.length}, expected ${EXPECTED_BASELINES.currentRoutes}`);
  if (v0Routes.length !== EXPECTED_BASELINES.v0VerifiedTypeScriptRoutes) errors.push(`v0 route count is ${v0Routes.length}, expected ${EXPECTED_BASELINES.v0VerifiedTypeScriptRoutes}`);
  if (matrix.baselines?.current?.expectedExecutableRoutes !== EXPECTED_BASELINES.currentRoutes) errors.push("matrix current baseline metadata is incorrect");
  const v0Baseline = matrix.baselines?.v0;
  if (v0Baseline?.expectedTotalFiles !== EXPECTED_BASELINES.v0TotalFiles || v0Baseline?.expectedTypeScriptFiles !== EXPECTED_BASELINES.v0TypeScriptFiles || v0Baseline?.expectedVerifiedTypeScriptRouteModules !== EXPECTED_BASELINES.v0VerifiedTypeScriptRoutes || v0Baseline?.expectedNonTypeScriptFiles !== EXPECTED_BASELINES.v0NonTypeScriptFiles) {
    errors.push("matrix v0 baseline metadata is incorrect");
  }
  if (JSON.stringify(v0Baseline?.excludedTestModules) !== JSON.stringify([V0_EXCLUDED_TEST_MODULE])) errors.push("matrix must exclude exactly the reviewed v0 collocated test module");

  for (const duplicate of duplicates(currentRoutes.map((route) => route.path))) errors.push(`duplicate current route: ${duplicate}`);
  for (const duplicate of duplicates(v0Routes.map((route) => route.path))) errors.push(`duplicate v0 route: ${duplicate}`);
  for (const duplicate of duplicates(capabilities.map((capability) => `${capability.currentRoute}\0${capability.capabilityId}`))) errors.push(`duplicate current_route + capability_id: ${duplicate.replace("\0", " / ")}`);

  const currentRoutePaths = new Set(currentRoutes.map((route) => route.path));
  const capabilityById = new Map(capabilities.map((capability) => [capability.capabilityId, capability]));
  for (const route of currentRoutes) {
    if (!RETAINED_DISPOSITIONS.has(route.disposition) || !hasText(route.family) || !hasText(route.userIntent)) errors.push(`current route ${route.path} lacks a valid family, intent, or disposition`);
    if (!Array.isArray(route.capabilityIds) || route.capabilityIds.length === 0) errors.push(`current route ${route.path} has no capabilityIds`);
    for (const capabilityId of route.capabilityIds ?? []) {
      const capability = capabilityById.get(capabilityId);
      if (!capability || capability.currentRoute !== route.path) errors.push(`current route ${route.path} references invalid capability ${capabilityId}`);
    }
  }
  for (const capability of capabilities) validateCapability(errors, capability, currentRoutePaths, repositoryRoot, inspectRepository);
  for (const field of ["intent", "currentBehavior"]) {
    const repeated = countBy(capabilities.map((capability) => capability[field]))
      .filter(([value, count]) => hasText(value) && count > 2);
    for (const [value, count] of repeated) errors.push(`${count} capabilities reuse a generic ${field} template: ${value}`);
  }

  for (const [capabilityId, expected] of Object.entries(REQUIRED_CAPABILITY_CONTRACTS)) {
    const capability = capabilityById.get(capabilityId);
    if (!capability) {
      errors.push(`required retained capability is missing: ${capabilityId}`);
      continue;
    }
    if (capability.currentRoute !== expected.route) errors.push(`required capability ${capabilityId} has wrong current route`);
    for (const [method, endpoint] of expected.methods) {
      if (!hasMethodEndpoint(capability, method, endpoint)) errors.push(`required capability ${capabilityId} lacks ${method} ${endpoint}`);
    }
    if (expected.defect && (capability.defect?.status !== "confirmed-defect" || capability.persistedReadBack?.status !== "confirmed-defect")) {
      errors.push(`required capability ${capabilityId} must record the confirmed loader/action read-back defect`);
    }
  }
  for (const [capabilityId, expected] of Object.entries(REQUIRED_SEMANTIC_FRAGMENTS)) {
    const capability = capabilityById.get(capabilityId);
    if (!capability) continue;
    for (const [field, fragments] of Object.entries(expected.fragments ?? {})) {
      const serialized = JSON.stringify(nestedValue(capability, field));
      for (const fragment of fragments) {
        if (!serialized.includes(fragment)) errors.push(`required capability ${capabilityId} ${field} lacks reviewed semantic fragment ${fragment}`);
      }
    }
    for (const [field, status] of Object.entries(expected.statuses ?? {})) {
      if (nestedValue(capability, field) !== status) errors.push(`required capability ${capabilityId} ${field} must be ${status}`);
    }
  }

  for (const route of v0Routes) {
    if (!V0_DISPOSITIONS.has(route.disposition)) errors.push(`v0 route ${route.path} lacks a valid disposition`);
    if (!hasText(route.family) || !hasText(route.rationale)) errors.push(`v0 route ${route.path} lacks family or rationale`);
    if (route.family === "ambiguous-legacy" && route.disposition !== "requires-product-decision") errors.push(`ambiguous v0 route ${route.path} must require a product decision`);
    if (route.family.startsWith("trigger-") && route.disposition !== "intentional-removal") errors.push(`Trigger-derived v0 route ${route.path} must be an intentional removal`);
    if (RETAINED_DISPOSITIONS.has(route.disposition)) {
      if (!hasText(route.currentRoute) || !currentRoutePaths.has(route.currentRoute)) errors.push(`retained v0 route ${route.path} lacks a valid currentRoute`);
      if (!hasText(route.capabilityId) || !capabilityById.has(route.capabilityId)) errors.push(`retained v0 route ${route.path} lacks a valid capabilityId`);
    }
  }
  for (const [path, expected] of Object.entries(REVIEWED_V0_DISPOSITIONS)) {
    const route = v0Routes.find((entry) => entry.path === path);
    if (!route) {
      errors.push(`reviewed v0 route is missing: ${path}`);
      continue;
    }
    if (route.disposition !== expected.disposition) errors.push(`reviewed v0 route ${path} must be ${expected.disposition}`);
    if (expected.currentRoute && route.currentRoute !== expected.currentRoute) errors.push(`reviewed v0 route ${path} has wrong current compatibility target`);
    if (expected.capabilityId && route.capabilityId !== expected.capabilityId) errors.push(`reviewed v0 route ${path} has wrong retained capability`);
    if (expected.rationale && !route.rationale.toLowerCase().includes(expected.rationale)) errors.push(`reviewed v0 route ${path} lacks ${expected.rationale} rationale`);
    if (expected.noCurrentTarget && (route.currentRoute || route.capabilityId)) errors.push(`reviewed v0 route ${path} is a deletion and must not retain a current target`);
  }
  if (!v0Routes.some((route) => route.path === V0_PRODUCTION_TEST_SEGMENT_ROUTE)) errors.push("production .test. URL-segment route is missing from v0 inventory");
  if (v0Routes.some((route) => route.path === V0_EXCLUDED_TEST_MODULE)) errors.push("collocated v0 test module must not be recorded as an executable route");

  if (inspectRepository) {
    const expectedCurrent = currentRoutes.map((route) => route.path).sort();
    const observedCurrent = currentRouteInventory(repositoryRoot);
    if (JSON.stringify(expectedCurrent) !== JSON.stringify(observedCurrent)) {
      const expected = new Set(expectedCurrent);
      const observed = new Set(observedCurrent);
      for (const path of observedCurrent.filter((path) => !expected.has(path))) errors.push(`current route missing from matrix: ${path}`);
      for (const path of expectedCurrent.filter((path) => !observed.has(path))) errors.push(`matrix current route no longer exists: ${path}`);
    }
    const observedV0 = v0RouteInventory(matrix.baselines.v0.commit, repositoryRoot);
    if (observedV0) {
      if (observedV0.allFiles.length !== EXPECTED_BASELINES.v0TotalFiles) errors.push(`pinned v0 total file count is ${observedV0.allFiles.length}, expected ${EXPECTED_BASELINES.v0TotalFiles}`);
      if (observedV0.typeScriptFiles.length !== EXPECTED_BASELINES.v0TypeScriptFiles) errors.push(`pinned v0 TypeScript file count is ${observedV0.typeScriptFiles.length}, expected ${EXPECTED_BASELINES.v0TypeScriptFiles}`);
      if (observedV0.verifiedTypeScriptRoutes.length !== EXPECTED_BASELINES.v0VerifiedTypeScriptRoutes) errors.push(`pinned v0 verified route count is ${observedV0.verifiedTypeScriptRoutes.length}, expected ${EXPECTED_BASELINES.v0VerifiedTypeScriptRoutes}`);
      if (observedV0.nonTypeScriptFiles.length !== EXPECTED_BASELINES.v0NonTypeScriptFiles) errors.push(`pinned v0 non-TypeScript file count is ${observedV0.nonTypeScriptFiles.length}, expected ${EXPECTED_BASELINES.v0NonTypeScriptFiles}`);
      if (JSON.stringify(observedV0.excludedTestModules) !== JSON.stringify([V0_EXCLUDED_TEST_MODULE])) errors.push("pinned v0 exclusion policy drifted");
      const expectedV0 = v0Routes.map((route) => route.path).sort();
      if (JSON.stringify(expectedV0) !== JSON.stringify(observedV0.verifiedTypeScriptRoutes)) errors.push(`v0 inventory differs from pinned commit ${matrix.baselines.v0.commit}`);
    }
    for (const source of matrix.designSources ?? []) {
      const absolutePath = source.path.startsWith("/") ? source.path : join(repositoryRoot, source.path);
      if (!existsSync(absolutePath)) {
        if (source.availability === "required") errors.push(`required design source is missing: ${source.path}`);
        continue;
      }
      const observedHash = source.kind === "tree" ? hashTree(source.path, repositoryRoot) : sha256(readFileSync(absolutePath));
      if (observedHash !== source.sha256) errors.push(`design source drifted: ${source.path}`);
    }
    const designRoot = join(repositoryRoot, "design/platos-ui-refactor");
    const designReferences = readdirSync(designRoot).filter((name) => name.endsWith(".dc.html")).sort();
    const manifestSource = readFileSync(join(repositoryRoot, "apps/webapp/app/components/platos/referenceRouteManifest.ts"), "utf8");
    const manifestReferences = [...manifestSource.matchAll(/reference:\s*"([^"]+)"/g)].map((match) => match[1]).sort();
    if (JSON.stringify(designReferences) !== JSON.stringify(manifestReferences)) errors.push("referenceRouteManifest no longer classifies the exact design reference set");
    const knownReferences = new Set(designReferences);
    for (const capability of capabilities) {
      for (const reference of capability.designReferences ?? []) if (!knownReferences.has(reference)) errors.push(`capability ${capability.capabilityId} uses unknown design reference ${reference}`);
    }
  }
  return errors;
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function escapeCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderMarkdown(matrix) {
  const capabilitiesByRoute = new Map();
  for (const capability of matrix.capabilities) {
    const rows = capabilitiesByRoute.get(capability.currentRoute) ?? [];
    rows.push(capability);
    capabilitiesByRoute.set(capability.currentRoute, rows);
  }
  const lines = [
    "# WIN-234 / WIN-238 route and capability parity matrix (generated)",
    "",
    "> Generated from `docs/audits/win-234-route-capability-parity.json`. Do not edit by hand; run `pnpm generate:route-parity`.",
    "",
    "This prerequisite is an explicit audit contract, not a completion claim. `required-not-verified` and `confirmed-defect` rows remain visible until persisted-state and authenticated-browser evidence replaces them.",
    "",
    "## Baselines",
    "",
    `- Current: \`${matrix.baselines.current.commit}\` — **${matrix.currentRoutes.length}** executable routes.`,
    `- v0 archaeology: \`${matrix.baselines.v0.commit}\` — **${matrix.baselines.v0.expectedTotalFiles}** total route-tree files, **${matrix.baselines.v0.expectedTypeScriptFiles}** TypeScript files, **${matrix.v0Routes.length}** verified TypeScript route modules after excluding exactly \`${V0_EXCLUDED_TEST_MODULE}\`, and **${matrix.baselines.v0.expectedNonTypeScriptFiles}** non-TypeScript file.`,
    `- Capability rows: **${matrix.capabilities.length}**, keyed by \`current_route + capability_id\`.`,
    "- Inventory/schema gate: `pnpm audit:route-parity` (CI-safe while explicit defects and missing evidence remain recorded).",
    "- Completion gate: `pnpm audit:route-parity:completion` (expected red until every retained capability is complete).",
    "",
    "## Design inputs",
    "",
    "| Source | Kind | Availability | SHA-256 |",
    "|---|---|---|---|",
    ...matrix.designSources.map((source) => `| \`${escapeCell(source.path)}\` | ${source.kind} | ${source.availability} | \`${source.sha256}\` |`),
    "",
    "## Disposition summary",
    "",
    "| Inventory | Disposition | Rows |",
    "|---|---|---:|",
    ...countBy(matrix.currentRoutes.map((route) => route.disposition)).map(([name, count]) => `| current routes | ${name} | ${count} |`),
    ...countBy(matrix.v0Routes.map((route) => route.disposition)).map(([name, count]) => `| v0 routes | ${name} | ${count} |`),
    "",
    "## Current route capabilities",
    "",
    "| Current route | Capability ID | Disposition | HTTP contracts | Read-back | Defect | Automated evidence | Browser evidence |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const route of matrix.currentRoutes) {
    for (const capability of (capabilitiesByRoute.get(route.path) ?? []).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId))) {
      const http = capability.http.map((contract) => `${contract.method} ${contract.endpoint}`).join("; ");
      lines.push(`| \`${escapeCell(route.path)}\` | \`${capability.capabilityId}\` | ${capability.disposition} | ${escapeCell(http)} | ${capability.persistedReadBack.status} | ${capability.defect.status} | ${capability.automatedEvidence.status} | ${capability.browserEvidence.status} |`);
    }
  }
  const completion = completionBlockers(matrix);
  lines.push(
    "",
    "## Completion gate status (expected red)",
    "",
    "| Blocker category | Count | Requirement |",
    "|---|---:|---|",
    ...completion.map((blocker) => `| ${escapeCell(blocker.category)} | ${blocker.count} | ${escapeCell(blocker.requirement)} |`),
  );
  lines.push("", "## v0 archaeology by family", "");
  for (const [family] of countBy(matrix.v0Routes.map((route) => route.family))) {
    const routes = matrix.v0Routes.filter((route) => route.family === family);
    lines.push(`### ${family} (${routes.length})`, "", "| v0 source | Disposition | Current target / capability | Rationale |", "|---|---|---|---|");
    for (const route of routes) {
      const target = route.currentRoute ? `\`${escapeCell(route.currentRoute)}\` / \`${escapeCell(route.capabilityId)}\`` : "—";
      lines.push(`| \`${escapeCell(route.path)}\` | ${route.disposition} | ${target} | ${escapeCell(route.rationale)} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Evidence semantics",
    "",
    "- `static-contract-only`: exact source, method, endpoint, DTO, scope, or model evidence is recorded, but runtime behavior is not claimed.",
    "- `required-not-verified`: mandatory persisted-state or authenticated-browser evidence remains outstanding.",
    "- `confirmed-defect`: source proves a contract mismatch or absent retained interaction; the row must remain blocking until repaired and read back.",
    "- `requires-product-decision`: reserved for legacy behavior whose source and canonical ownership do not resolve a safe disposition.",
    "- `intentional-removal`: explicit Trigger-derived or security-deleted behavior that must not be resurrected.",
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

export function completionBlockers(matrix) {
  const blockers = [];
  const add = (category, capabilities, requirement) => {
    if (capabilities.length) blockers.push({ category, count: capabilities.length, capabilityIds: capabilities.map((entry) => entry.capabilityId).sort(), requirement });
  };
  const unresolvedEvidence = (field) => matrix.capabilities.filter((capability) => !COMPLETION_EVIDENCE_STATUSES.has(capability[field].status));
  const unresolvedScope = (field) => matrix.capabilities.filter((capability) => !COMPLETION_SCOPE_STATUSES.has(capability[field].status));
  const unresolvedTenantDimension = (key) => matrix.capabilities.filter((capability) =>
    !COMPLETION_SCOPE_STATUSES.has(capability.tenantScope.status) ||
    (capability.tenantScope.status === "enforced" && !capability.tenantScope.keys.includes(key)),
  );
  const unresolvedState = (field) => matrix.capabilities.filter((capability) => !COMPLETION_STATE_STATUSES.has(capability[field].status));
  add(
    "confirmed defects",
    matrix.capabilities.filter((capability) => capability.defect.status === "confirmed-defect"),
    "Repair the source-backed defect and replace the defect status with verified evidence.",
  );
  add("permission", unresolvedEvidence("permission"), "Verify permission behavior or record an approved not-applicable/justified-exclusion status.");
  add("organization scope", unresolvedTenantDimension("organizationId"), "Verify Organization isolation or record an approved not-applicable status.");
  add("project scope", unresolvedTenantDimension("projectId"), "Verify Project isolation or record an approved not-applicable status.");
  add("environment scope", unresolvedTenantDimension("environmentId"), "Verify Environment isolation or record an approved not-applicable status.");
  add("EndUser scope", unresolvedScope("endUserScope"), "Verify EndUser isolation or record an approved not-applicable status.");
  add("Agent scope", unresolvedScope("agentScope"), "Verify Agent isolation or record an approved not-applicable status.");
  add("cluster scope", unresolvedScope("clusterScope"), "Verify cluster isolation or record an approved not-applicable status.");
  add("loader behavior", unresolvedState("loaderState"), "Verify loader behavior or record an approved redirect/not-applicable status.");
  add("action behavior", unresolvedState("actionState"), "Verify action behavior or record an approved redirect/not-applicable status.");
  add("form behavior", unresolvedState("formState"), "Verify form behavior or record an approved redirect/not-applicable status.");
  add("link behavior", unresolvedState("linkState"), "Verify link and deep-link behavior or record an approved redirect/not-applicable status.");
  add("destructive confirmation", unresolvedEvidence("destructiveConfirmation"), "Verify destructive confirmation or record an approved not-applicable/justified-exclusion status.");
  add("idempotency", unresolvedEvidence("idempotency"), "Verify replay and duplicate-submission behavior or record an approved not-applicable/justified-exclusion status.");
  add("concurrency", unresolvedEvidence("concurrency"), "Verify concurrent behavior or record an approved not-applicable/justified-exclusion status.");
  add("recovery", unresolvedEvidence("recovery"), "Verify failure, retry, and unavailable-backend recovery or record an approved not-applicable/justified-exclusion status.");
  add("secret exposure", unresolvedEvidence("secretExposure"), "Verify secret-safe payloads, errors, logs, storage, and snapshots or record an approved not-applicable/justified-exclusion status.");
  add(
    "persisted-state evidence",
    matrix.capabilities.filter((capability) =>
      capability.persistedReadBack.status !== "verified" &&
      !(capability.persistedReadBack.status === "not-applicable" && capability.sourceOwnership.classification === "justified-no-backend"),
    ),
    "Provide create/update/delete/read-back evidence against the canonical clean-schema owner.",
  );
  add(
    "automated behavioral evidence",
    matrix.capabilities.filter((capability) => capability.automatedEvidence.status !== "verified"),
    "Replace static or pending references with passing behavioral test evidence.",
  );
  add(
    "browser evidence",
    matrix.capabilities.filter((capability) => !["verified", "justified-exclusion"].includes(capability.browserEvidence.status)),
    "Provide authenticated browser evidence or a source-backed justified exclusion.",
  );
  add(
    "pagination and totals",
    matrix.capabilities.filter((capability) => [capability.pagination.status, capability.totals.status].some((status) => ["required-not-verified", "confirmed-defect"].includes(status))),
    "Prove complete totals and usable pagination/virtualization for dense retained data.",
  );
  return blockers;
}

export function runCompletionGate(matrix = readMatrix()) {
  const inventoryErrors = validateMatrix(matrix);
  if (inventoryErrors.length) throw new Error(`Route parity inventory/schema audit failed before completion evaluation:\n- ${inventoryErrors.join("\n- ")}`);
  const blockers = completionBlockers(matrix);
  if (!blockers.length) return;
  const lines = blockers.map((blocker) => {
    const sample = blocker.capabilityIds.slice(0, 12).join(", ");
    const remaining = blocker.count > 12 ? `, +${blocker.count - 12} more` : "";
    return `- ${blocker.category}: ${blocker.count}\n  ${blocker.requirement}\n  Capabilities: ${sample}${remaining}`;
  });
  throw new Error(`WIN-234/WIN-238 completion gate is RED (${blockers.reduce((sum, blocker) => sum + blocker.count, 0)} actionable blockers across ${blockers.length} categories):\n${lines.join("\n")}`);
}

export function runCheck(matrix = readMatrix()) {
  const errors = validateMatrix(matrix);
  if (errors.length) throw new Error(`Route parity matrix check failed:\n- ${errors.join("\n- ")}`);
  const expectedSummary = renderMarkdown(matrix);
  const observedSummary = existsSync(SUMMARY_PATH) ? readFileSync(SUMMARY_PATH, "utf8") : "";
  if (observedSummary !== expectedSummary) throw new Error("Generated route parity Markdown is stale; run `pnpm generate:route-parity`");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = readMatrix();
  if (process.argv.includes("--completion")) {
    try {
      runCompletionGate(matrix);
      console.log("WIN-234/WIN-238 completion gate is green.");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else {
    const errors = validateMatrix(matrix);
    if (errors.length) {
    console.error(`Route parity matrix check failed:\n- ${errors.join("\n- ")}`);
    process.exitCode = 1;
    } else if (process.argv.includes("--write")) {
      writeFileSync(SUMMARY_PATH, renderMarkdown(matrix));
      console.log(`Wrote ${relative(ROOT, SUMMARY_PATH)}`);
    } else {
      try {
        runCheck(matrix);
        console.log(`Route parity inventory/schema audit is current (${matrix.currentRoutes.length} current, ${matrix.v0Routes.length} v0, ${matrix.capabilities.length} capabilities).`);
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    }
  }
}
