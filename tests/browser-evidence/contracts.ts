import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalOperatorScope } from "../persisted-state-gate/fixture-contract";

export const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
export const MATRIX_PATH = path.join(
  REPOSITORY_ROOT,
  "docs/audits/win-234-route-capability-parity.json"
);
export const CONTRACT_PATH = path.join(__dirname, "capability-contract.json");
export const VISUAL_MODES = [
  "desktop-light",
  "desktop-dark",
  "mobile-light",
  "mobile-dark",
] as const;
export type VisualMode = (typeof VISUAL_MODES)[number];
export type ScopeKey = "alpha" | "beta";

export type ManifestScope = {
  key: ScopeKey;
  organizationId: string;
  organizationSlug: string;
  projectId: string;
  projectSlug: string;
  environmentId: string;
  environmentSlug: string;
  operatorId: string;
  userId: string;
  endUserId: string;
  externalUserId: string;
  entityId: string;
  entityExternalId: string;
  clusterId: string;
  threadId: string;
  agentIds: string[];
  publicGuestAgentId: string;
  approvalId?: string;
  jobId: string;
};

export type FixtureManifest = {
  schemaVersion: 1;
  fixture: string;
  sha256: string;
  counts: Record<string, number>;
  scopes: [ManifestScope, ManifestScope];
};

type MatrixCapability = {
  capabilityId: string;
  currentRoute: string;
  tenantScope: { status: string };
  actionState: { status: string };
  persistedReadBack: { status: string };
};

export type NavigationContract = {
  expectedHttpStatus: 200;
  expectedFinalPath:
    | "target"
    | "environment/agents"
    | "environment/mcps"
    | "environment/settings/general"
    | "environment/thread"
    | "environment/thread/trace"
    | "organization/settings/team";
};

export type PaginationContract = {
  pageParam: string;
  pageSizeParam: string;
  resultSelector: string;
  rowIdentity: { selector: string; source: "text" | "value" };
  totalSelector: string;
  totalPattern: string;
  minTotal: number;
};

type CapabilityContractFile = {
  schemaVersion: 1;
  capabilityIds: string[];
  interactiveCapabilityIds: string[];
  mutationCapabilityIds: string[];
  paginationCapabilityIds: string[];
  navigationContracts: Record<string, NavigationContract>;
  mutationHandlers: Record<string, string>;
  paginationContracts: Record<string, PaginationContract>;
  targetOverrides: Record<string, string>;
};

export type BrowserCapability = MatrixCapability & {
  interactive: boolean;
  mutation: boolean;
  pagination: boolean;
  navigationContract: NavigationContract;
  mutationHandler?: string;
  paginationContract?: PaginationContract;
  targetOverride?: string;
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function duplicates(values: string[]) {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => (seen.has(value) ? true : !seen.add(value))))];
}

function assertExactSet(label: string, actual: string[], expected: string[]) {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  if (missing.length || extra.length || duplicates(actual).length) {
    throw new Error(
      `${label} is not exact: missing=${missing.join(",") || "none"} extra=${
        extra.join(",") || "none"
      } duplicates=${duplicates(actual).join(",") || "none"}`
    );
  }
}

export function loadBrowserCapabilities(): BrowserCapability[] {
  const matrix = readJson<{ capabilities: MatrixCapability[] }>(MATRIX_PATH);
  const contract = readJson<CapabilityContractFile>(CONTRACT_PATH);
  if (contract.schemaVersion !== 1) throw new Error("Unsupported browser capability contract");
  if (matrix.capabilities.length !== 107) {
    throw new Error(
      `Browser evidence requires exactly 107 matrix capabilities, found ${matrix.capabilities.length}`
    );
  }
  const matrixIds = matrix.capabilities.map(({ capabilityId }) => capabilityId);
  assertExactSet("browser capability IDs", contract.capabilityIds, matrixIds);
  for (const [label, values] of [
    ["interactive capability IDs", contract.interactiveCapabilityIds],
    ["mutation capability IDs", contract.mutationCapabilityIds],
    ["pagination capability IDs", contract.paginationCapabilityIds],
  ] as const) {
    const unknown = values.filter((value) => !matrixIds.includes(value));
    if (unknown.length || duplicates(values).length) {
      throw new Error(`${label} contains unknown or duplicate IDs: ${unknown.join(",")}`);
    }
  }
  assertExactSet(
    "navigation contract IDs",
    Object.keys(contract.navigationContracts),
    contract.capabilityIds
  );
  const derivedMutationIds = matrix.capabilities
    .filter(
      ({ actionState, persistedReadBack }) =>
        actionState.status === "implemented" && persistedReadBack.status !== "not-applicable"
    )
    .map(({ capabilityId }) => capabilityId);
  assertExactSet(
    "persisted interaction mutation IDs",
    contract.mutationCapabilityIds,
    derivedMutationIds
  );
  const nonInteractiveMutations = contract.mutationCapabilityIds.filter(
    (capabilityId) => !contract.interactiveCapabilityIds.includes(capabilityId)
  );
  if (nonInteractiveMutations.length) {
    throw new Error(
      `Mutation applicability includes non-interaction rows: ${nonInteractiveMutations.join(",")}`
    );
  }
  assertExactSet(
    "mutation handler IDs",
    Object.keys(contract.mutationHandlers),
    contract.mutationCapabilityIds
  );
  assertExactSet(
    "pagination contract IDs",
    Object.keys(contract.paginationContracts),
    contract.paginationCapabilityIds
  );
  for (const [capabilityId, navigation] of Object.entries(contract.navigationContracts)) {
    if (navigation.expectedHttpStatus !== 200 || !navigation.expectedFinalPath) {
      throw new Error(`Navigation contract is not exact for ${capabilityId}`);
    }
  }
  for (const [capabilityId, pagination] of Object.entries(contract.paginationContracts)) {
    if (
      !pagination.pageParam ||
      !pagination.pageSizeParam ||
      !pagination.resultSelector ||
      !pagination.rowIdentity.selector ||
      !pagination.totalSelector ||
      !pagination.totalPattern ||
      !Number.isInteger(pagination.minTotal) ||
      pagination.minTotal < 3
    ) {
      throw new Error(`Pagination contract is incomplete for ${capabilityId}`);
    }
  }
  const requiredPageParams = {
    "mcp-token-list": "page",
    "entity-mcp-bearer-token-list": "tokenPage",
    "mcp-tool-acl-policy": "aclPage",
    "thread-artifacts": "artifactPage",
  } as const;
  for (const [capabilityId, pageParam] of Object.entries(requiredPageParams)) {
    if (contract.paginationContracts[capabilityId]?.pageParam !== pageParam) {
      throw new Error(`${capabilityId} must use the pinned ${pageParam} pagination parameter`);
    }
  }
  return contract.capabilityIds.map((capabilityId) => {
    const matrixCapability = matrix.capabilities.find(
      (entry) => entry.capabilityId === capabilityId
    );
    if (!matrixCapability) throw new Error(`Missing matrix capability ${capabilityId}`);
    return {
      ...matrixCapability,
      interactive: contract.interactiveCapabilityIds.includes(capabilityId),
      mutation: contract.mutationCapabilityIds.includes(capabilityId),
      pagination: contract.paginationCapabilityIds.includes(capabilityId),
      navigationContract: contract.navigationContracts[capabilityId],
      mutationHandler: contract.mutationHandlers[capabilityId],
      paginationContract: contract.paginationContracts[capabilityId],
      targetOverride: contract.targetOverrides[capabilityId],
    };
  });
}

export function loadFixtureManifest(): FixtureManifest {
  const artifactRoot = path.resolve(
    process.env.WIN234_BROWSER_ARTIFACT_DIR ?? "artifacts/win234-browser"
  );
  const persistedStateRoot = path.resolve(
    process.env.WIN235_ARTIFACT_DIR ?? path.join(path.dirname(artifactRoot), "win235")
  );
  return readJson<FixtureManifest>(path.join(persistedStateRoot, "fixture-manifest.json"));
}

export function fixtureBodySha256(fixture: FixtureManifest): string {
  const { sha256: _sha256, ...body } = fixture;
  return createHash("sha256")
    .update(`${JSON.stringify(body, null, 2)}\n`)
    .digest("hex");
}

export function artifactRoot(): string {
  return path.resolve(process.env.WIN234_BROWSER_ARTIFACT_DIR ?? "artifacts/win234-browser");
}

function environmentPath(scope: ManifestScope) {
  return `/orgs/${scope.organizationSlug}/projects/${scope.projectSlug}/env/${scope.environmentSlug}`;
}

function routeParameters(scope: ManifestScope): Record<string, string> {
  const canonical = canonicalOperatorScope(scope.key);
  return {
    organizationSlug: scope.organizationSlug,
    projectParam: scope.projectSlug,
    envParam: scope.environmentSlug,
    agentId: scope.agentIds[0],
    entityId: scope.entityId,
    clusterId: scope.clusterId,
    threadId: scope.threadId,
    approvalId: scope.approvalId ?? canonical.approvalId,
    jobId: scope.jobId,
    userId: scope.endUserId,
  };
}

export function capabilityPath(capability: BrowserCapability, scope: ManifestScope): string {
  if (capability.targetOverride === "environment/agent-connect") {
    return `${environmentPath(scope)}/agent-connect`;
  }
  if (capability.targetOverride === "environment/memories") {
    return `${environmentPath(scope)}/memories`;
  }
  if (capability.targetOverride === "organization/settings/team") {
    return `/orgs/${scope.organizationSlug}/settings/team`;
  }
  if (capability.targetOverride === "embed") {
    return `/embed/${scope.agentIds[0]}?environmentId=${encodeURIComponent(scope.environmentId)}`;
  }
  if (capability.targetOverride === "root") return "/";

  const relativeRoute = capability.currentRoute.replace(/^apps\/webapp\/app\/routes\//, "");
  const routeId = relativeRoute
    .replace(/\/route\.(?:js|jsx|ts|tsx)$/, "")
    .replace(/\.(?:js|jsx|ts|tsx)$/, "");
  const values = routeParameters(scope);
  if (routeId.includes(".mcps.$entityId")) {
    values.entityId = scope.entityExternalId;
  }
  const segments = routeId
    .split(".")
    .filter((segment) => segment !== "_app" && segment !== "_index")
    .map((segment) => {
      const normalized = segment.replace(/_$/, "");
      if (!normalized.startsWith("$")) return normalized;
      const value = values[normalized.slice(1)];
      if (!value)
        throw new Error(
          `No fixture route parameter for ${normalized} (${capability.capabilityId})`
        );
      return value;
    });
  const pathname = segments.length ? `/${segments.join("/")}` : "/";
  if (pathname.endsWith(`/agents/${scope.agentIds[0]}/chat`)) {
    return `${pathname}?threadId=${encodeURIComponent(scope.threadId)}`;
  }
  return pathname;
}

export function expectedCapabilityPathname(
  capability: BrowserCapability,
  scope: ManifestScope
): string {
  const environment = environmentPath(scope);
  switch (capability.navigationContract.expectedFinalPath) {
    case "target":
      return new URL(capabilityPath(capability, scope), "http://browser-evidence.invalid").pathname;
    case "environment/agents":
      return `${environment}/agents`;
    case "environment/mcps":
      return `${environment}/mcps`;
    case "environment/settings/general":
      return `${environment}/settings/general`;
    case "environment/thread":
      return `${environment}/threads/${scope.threadId}`;
    case "environment/thread/trace":
      return `${environment}/threads/${scope.threadId}/trace`;
    case "organization/settings/team":
      return `/orgs/${scope.organizationSlug}/settings/team`;
  }
}

export function relativeArtifactPath(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/");
}
