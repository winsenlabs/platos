import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../app/services/database.server";
import {
  agentPanel,
  agentRequestResult,
  agentResponse,
  credentialRequestResult,
} from "../app/services/platosAgent.server";
import { commitOperatorSession, operatorAuth } from "../app/services/auth.server";
import {
  PERFORMANCE_RECEIPT_FILE,
  verifyPerformanceVerificationReceipt,
} from "../../../tests/persisted-state-gate/performance-verification-receipt.mjs";

type ManifestScope = {
  key: "alpha" | "beta";
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
  clusterId: string;
  threadId: string;
  agentIds: string[];
  profileMemoryId: string;
  graphEntityIds: string[];
};

type FixtureManifest = {
  schemaVersion: 1;
  sha256: string;
  counts: Record<string, number>;
  scopes: [ManifestScope, ManifestScope];
};

type AssertionArtifact = {
  id: string;
  status: "passed" | "failed";
  httpStatus?: number;
  errorCode?: string;
  readBack?: Record<string, unknown>;
  message?: string;
};

const artifactDirectory = path.resolve(process.env.WIN235_ARTIFACT_DIR ?? "../../artifacts/win235");
const fixturePath = path.join(artifactDirectory, "fixture-manifest.json");
const webappUrl = process.env.WIN235_WEBAPP_URL;
const candidateImages = {
  agent: process.env.WIN235_AGENT_IMAGE,
  webapp: process.env.WIN235_WEBAPP_IMAGE,
  migrations: process.env.WIN235_MIGRATIONS_IMAGE,
};
const assertions: AssertionArtifact[] = [];
const requiredAssertionIds = new Set([
  "fixture.postgres-dense-counts",
  "fixture.thread-density",
  "loader.agents.persisted-total",
  "loader.agents.generated-link",
  "action.agent.create",
  "action.agent.update",
  "controller.cluster.bind",
  "controller.thread.archive-and-restore",
  "action.memory.visibility",
  "action.memory.edit",
  "action.memory.import",
  "controller.memory.relate",
  "controller.provider.rotate",
  "action.memory.archive",
  "action.memory.restore",
  "controller.agent.delete",
  "negative.enum-mismatch",
  "negative.organization",
  "negative.project",
  "negative.environment",
  "negative.agent",
  "negative.end-user",
  "negative.agent-cluster",
]);
let manifest: FixtureManifest;
let primary: ManifestScope;
let secondary: ManifestScope;
let operatorCookie: string;

const remixRouteIds = {
  agents: "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents._index",
  agentCreate: "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.new",
  agentUpdate:
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId._index",
  memories:
    "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index",
} as const;

async function check<T extends Omit<AssertionArtifact, "id" | "status">>(
  id: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    const detail = await operation();
    assertions.push({ id, status: "passed", ...detail });
    return detail;
  } catch (error) {
    assertions.push({
      id,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function environmentPath(scope: ManifestScope) {
  return `/orgs/${scope.organizationSlug}/projects/${scope.projectSlug}/env/${scope.environmentSlug}`;
}

function webappDataRequest(pathname: string, routeId: string, init: RequestInit = {}) {
  if (!webappUrl) throw new Error("WIN235_WEBAPP_URL is required for production-image integration");
  const url = new URL(pathname, webappUrl);
  url.searchParams.set("_data", routeId);
  return fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      Cookie: operatorCookie,
      Accept: "application/json",
      ...init.headers,
    },
  });
}

function webappPageRequest(pathname: string) {
  if (!webappUrl) throw new Error("WIN235_WEBAPP_URL is required for production-image integration");
  return fetch(new URL(pathname, webappUrl), {
    headers: { Cookie: operatorCookie, Accept: "text/html" },
  });
}

async function responsePayload(response: Response) {
  const body = await response.text();
  const diagnostics = [
    `status=${response.status} ${response.statusText}`,
    `url=${response.url}`,
    `redirected=${response.redirected}`,
    `location=${response.headers.get("location") ?? "none"}`,
    `content-type=${response.headers.get("content-type") ?? "none"}`,
  ].join(" ");
  if (!body) {
    throw new Error(`Expected JSON but received an empty body: ${diagnostics}`);
  }
  try {
    return JSON.parse(body) as Record<string, any>;
  } catch {
    throw new Error(`Expected JSON: ${diagnostics} body=${JSON.stringify(body.slice(0, 300))}`);
  }
}

function agentForm(name: string, slug = "win235-action-agent") {
  return new URLSearchParams({
    name,
    slug,
    model: "fixture:deterministic",
    systemPrompt: "Persist every accepted mutation.",
    maxSteps: "10",
    contextLimit: "1000",
    historyMode: "rolling",
    compactThreshold: "100",
    executionMode: "direct",
    visibility: "private",
    toolMode: "direct",
    toolExposure: "meta",
    modelRoutes: JSON.stringify([
      { label: "fixture", model: "fixture:deterministic", isDefault: true },
    ]),
    promptBlocks: "[]",
  });
}

describe.sequential("WIN-235 persisted-state completion gate", () => {
  beforeAll(async () => {
    if (!webappUrl) throw new Error("WIN235_WEBAPP_URL is required");
    for (const [name, image] of Object.entries(candidateImages)) {
      if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) {
        throw new Error(`WIN235_${name.toUpperCase()}_IMAGE must be an immutable digest reference`);
      }
    }
    manifest = JSON.parse(await readFile(fixturePath, "utf8")) as FixtureManifest;
    [primary, secondary] = manifest.scopes;
    const session = await operatorAuth.issueOperatorSession({ userId: primary.operatorId });
    const runnerCookie = (await commitOperatorSession(session.token, session.expiresAt)).split(
      ";",
      1
    )[0];
    // The test runner uses NODE_ENV=test, while the exact production webapp
    // candidate intentionally uses the secure __Host- cookie name.
    operatorCookie = runnerCookie.replace(/^[^=]+=/, "__Host-platos_operator_session=");
  });

  afterAll(async () => {
    await mkdir(artifactDirectory, { recursive: true });
    const expectedCommit = process.env.GITHUB_SHA;
    if (!expectedCommit) throw new Error("GITHUB_SHA is required by the persisted-state gate");
    const [performanceArtifactRaw, performanceReceipt] = await Promise.all([
      readFile(path.join(artifactDirectory, "performance-results.json"), "utf8"),
      readFile(path.join(artifactDirectory, PERFORMANCE_RECEIPT_FILE), "utf8").then((raw) =>
        JSON.parse(raw)
      ),
    ]);
    verifyPerformanceVerificationReceipt(
      performanceReceipt,
      performanceArtifactRaw,
      expectedCommit
    );
    const passedIds = new Set(
      assertions
        .filter((assertion) => assertion.status === "passed")
        .map((assertion) => assertion.id)
    );
    const status =
      assertions.some((assertion) => assertion.status === "failed") ||
      [...requiredAssertionIds].some((id) => !passedIds.has(id))
        ? "failed"
        : "passed";
    await writeFile(
      path.join(artifactDirectory, "gate-results.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          gate: "win235-persisted-state",
          commitSha: process.env.GITHUB_SHA ?? "local-uncommitted",
          fixture: {
            schemaVersion: manifest?.schemaVersion ?? 1,
            sha256: manifest?.sha256 ?? "0".repeat(64),
            counts: manifest?.counts ?? {},
          },
          images: candidateImages,
          status,
          assertions,
          measurements: {
            status: "enforced",
            budgetsFile: "tests/persisted-state-gate/budgets.v1.json",
            performanceArtifact: "performance-results.json",
            performanceReceipt: PERFORMANCE_RECEIPT_FILE,
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await database.$disconnect();
  });

  it("reads back the exact canonical dense fixture from the clean schema", async () => {
    await check("fixture.postgres-dense-counts", async () => {
      const actual = {
        organizations: await database.organization.count(),
        projects: await database.project.count(),
        environments: await database.environment.count(),
        agents: await database.agent.count(),
        threads: await database.thread.count(),
        turns: await database.turn.count(),
        tools: await database.tool.count(),
        memories: await database.memory.count(),
        graphEntities: await database.memoryEntity.count(),
      };
      expect(actual).toEqual({
        organizations: 2,
        projects: 2,
        environments: 2,
        agents: 40,
        threads: 2,
        turns: 120,
        tools: 200,
        memories: 384,
        graphEntities: 141,
      });
      return { readBack: actual };
    });

    await check("fixture.thread-density", async () => {
      for (const scope of manifest.scopes) {
        const count = await database.turn.count({ where: { threadId: scope.threadId } });
        expect(count).toBe(60);
      }
      return { readBack: { threads: 2, turnsPerThread: 60 } };
    });
  });

  it("exercises a real Remix loader through the webapp Agent adapter", async () => {
    await check("loader.agents.persisted-total", async () => {
      const response = await webappDataRequest(
        `${environmentPath(primary)}/agents`,
        remixRouteIds.agents
      );
      const payload = await responsePayload(response);
      const persistedTotal = await database.agentBinding.count({
        where: {
          environmentId: primary.environmentId,
          agent: { isActive: true },
        },
      });
      expect(response.status).toBe(200);
      expect(payload.panel.ok).toBe(true);
      expect(payload.panel.data.total).toBe(persistedTotal);
      expect(payload.panel.data.agents).toHaveLength(persistedTotal);
      return {
        httpStatus: response.status,
        readBack: { total: payload.panel.data.total, persistedTotal },
      };
    });

    await check("loader.agents.generated-link", async () => {
      const response = await webappPageRequest(`${environmentPath(primary)}/agents`);
      const html = await response.text();
      const href = `${environmentPath(primary)}/agents/${primary.agentIds[0]}`;
      expect(response.status).toBe(200);
      expect(html).toContain(`href="${href}"`);
      return { httpStatus: response.status, readBack: { href } };
    });
  });

  it("persists create, update, bind, archive, import, relate, rotate, and delete mutations", async () => {
    let createdAgentId = "";
    await check("action.agent.create", async () => {
      const response = await webappDataRequest(
        `${environmentPath(primary)}/agents/new`,
        remixRouteIds.agentCreate,
        { method: "POST", body: agentForm("WIN-235 Action Agent") }
      );
      const payload = await responsePayload(response);
      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      createdAgentId = payload.result.id;
      const readBack = await database.agent.findUnique({
        where: { id: createdAgentId },
        include: { versions: true, bindings: true },
      });
      expect(readBack).toMatchObject({ name: "WIN-235 Action Agent", isActive: true });
      expect(readBack?.versions).toHaveLength(1);
      expect(readBack?.bindings).toHaveLength(1);
      return { httpStatus: response.status, readBack: { id: readBack?.id, name: readBack?.name } };
    });

    await check("action.agent.update", async () => {
      const form = agentForm("WIN-235 Action Agent Updated");
      form.set("systemPrompt", "Persisted update creates version two.");
      form.set("versionNote", "WIN-235 persisted update");
      const response = await webappDataRequest(
        `${environmentPath(primary)}/agents/${createdAgentId}`,
        remixRouteIds.agentUpdate,
        { method: "POST", body: form }
      );
      const payload = await responsePayload(response);
      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      const readBack = await database.agent.findUnique({
        where: { id: createdAgentId },
        include: { versions: { orderBy: { versionNumber: "asc" } } },
      });
      expect(readBack?.name).toBe("WIN-235 Action Agent Updated");
      expect(readBack?.versions).toHaveLength(2);
      return {
        httpStatus: response.status,
        readBack: { name: readBack?.name, versions: readBack?.versions.length },
      };
    });

    await check("controller.cluster.bind", async () => {
      const result = await agentRequestResult<{ ok: boolean }>(
        `/api/v1/agent/clusters/${primary.clusterId}/agents`,
        primary,
        { method: "POST", body: { agentId: createdAgentId, role: "member" } }
      );
      expect(result.status).toBe(201);
      expect(result.payload.ok).toBe(true);
      const binding = await database.agentBinding.findUnique({
        where: {
          environmentId_agentId: { environmentId: primary.environmentId, agentId: createdAgentId },
        },
      });
      expect(binding?.clusterId).toBe(primary.clusterId);
      return { httpStatus: result.status, readBack: { clusterId: binding?.clusterId } };
    });

    await check("controller.thread.archive-and-restore", async () => {
      const threadOwnerScope = {
        ...primary,
        userId: primary.externalUserId,
        agentId: primary.agentIds[0],
      };
      const archive = await agentRequestResult(
        `/api/v1/agent/threads/${primary.threadId}/archive`,
        threadOwnerScope,
        {
          method: "POST",
        }
      );
      expect(archive.status).toBe(201);
      const archived = await database.thread.findUnique({ where: { id: primary.threadId } });
      expect(archived?.archivedAt).not.toBeNull();
      const restore = await agentRequestResult(
        `/api/v1/agent/threads/${primary.threadId}/unarchive`,
        threadOwnerScope,
        {
          method: "POST",
        }
      );
      expect(restore.status).toBe(201);
      const restored = await database.thread.findUnique({ where: { id: primary.threadId } });
      expect(restored?.archivedAt).toBeNull();
      return {
        httpStatus: restore.status,
        readBack: { archived: true, archiveHttpStatus: archive.status, restored: true },
      };
    });

    await check("action.memory.visibility", async () => {
      const updateResponse = await webappDataRequest(
        `${environmentPath(primary)}/memories`,
        remixRouteIds.memories,
        {
          method: "POST",
          body: new URLSearchParams({
            intent: "memory-visibility",
            userId: primary.endUserId,
            agentId: primary.agentIds[0],
            id: primary.profileMemoryId,
            visibility: "hidden",
          }),
        }
      );
      const updatePayload = await responsePayload(updateResponse);
      expect(updateResponse.status, JSON.stringify(updatePayload)).toBe(200);
      expect(updatePayload.ok).toBe(true);
      const readBack = await database.memory.findUnique({ where: { id: primary.profileMemoryId } });
      expect(readBack?.agentVisible).toBe(false);
      expect(readBack?.visibility).toBe("hidden");
      return {
        httpStatus: updateResponse.status,
        readBack: {
          id: primary.profileMemoryId,
          agentVisible: false,
          visibility: readBack?.visibility,
        },
      };
    });

    await check("action.memory.edit", async () => {
      const editedContent = "WIN-235 edited profile memory";
      const editedProfileKey = "win235-edited-profile";
      const updateResponse = await webappDataRequest(
        `${environmentPath(primary)}/memories`,
        remixRouteIds.memories,
        {
          method: "POST",
          body: new URLSearchParams({
            intent: "memory-update",
            userId: primary.endUserId,
            agentId: primary.agentIds[0],
            id: primary.profileMemoryId,
            content: editedContent,
            kind: "profile",
            visibility: "hidden",
            profileKey: editedProfileKey,
            metadata: "{}",
          }),
        }
      );
      const updatePayload = await responsePayload(updateResponse);
      expect(updateResponse.status, JSON.stringify(updatePayload)).toBe(200);
      expect(updatePayload.ok).toBe(true);

      const persisted = await database.memory.findUnique({
        where: { id: primary.profileMemoryId },
      });
      expect(persisted).toMatchObject({
        id: primary.profileMemoryId,
        kind: "profile",
        profileKey: editedProfileKey,
        visibility: "hidden",
        agentVisible: false,
      });
      const readBack = await agentRequestResult<{
        memories: Array<{ id: string; content: string; metadata: unknown }>;
      }>(`/api/v1/memory?userId=${encodeURIComponent(primary.endUserId)}&kind=profile`, {
        ...primary,
        agentId: primary.agentIds[0],
      });
      expect(readBack.status).toBe(200);
      expect(
        readBack.payload.memories.find((memory) => memory.id === primary.profileMemoryId)
      ).toMatchObject({
        id: primary.profileMemoryId,
        content: editedContent,
        metadata: { profileKey: editedProfileKey },
      });
      return {
        httpStatus: updateResponse.status,
        readBack: {
          id: primary.profileMemoryId,
          kind: persisted?.kind,
          profileKey: persisted?.profileKey,
          visibility: persisted?.visibility,
          content: editedContent,
        },
      };
    });

    await check("action.memory.import", async () => {
      const importedMemoryContent = "WIN-235 imported profile memory";
      const importedMemoryWhere = {
        environmentId: primary.environmentId,
        endUserId: primary.endUserId,
        agentId: createdAgentId,
        kind: "profile",
        source: "imported",
      } as const;
      const beforeMemoryIds = new Set(
        (
          await database.memory.findMany({
            where: importedMemoryWhere,
            select: { id: true },
          })
        ).map((memory) => memory.id)
      );
      const bundle = {
        version: 2,
        memories: [
          {
            id: "win235-import-memory-1",
            kind: "profile",
            content: importedMemoryContent,
            metadata: { profileKey: "win235-imported-profile" },
            visibility: "private",
            agentVisible: false,
            source: "manual",
          },
        ],
        entities: [
          {
            id: "win235-import-entity-from",
            entityKey: "win235:import:from",
            entityType: "person",
            label: "From",
            aliases: [],
          },
          {
            id: "win235-import-entity-to",
            entityKey: "win235:import:to",
            entityType: "project",
            label: "To",
            aliases: [],
          },
        ],
        relationships: [
          {
            id: "win235-import-relationship-1",
            fromEntityId: "win235-import-entity-from",
            toEntityId: "win235-import-entity-to",
            fromEntityKey: "win235:import:from",
            toEntityKey: "win235:import:to",
            relationshipType: "works_on",
            sourceMemoryId: "win235-import-memory-1",
          },
        ],
      };
      const response = await webappDataRequest(
        `${environmentPath(primary)}/memories`,
        remixRouteIds.memories,
        {
          method: "POST",
          body: new URLSearchParams({
            intent: "memory-import",
            userId: primary.endUserId,
            agentId: createdAgentId,
            mode: "merge",
            bundle: JSON.stringify(bundle),
          }),
        }
      );
      const payload = await responsePayload(response);
      expect(response.status).toBe(200);
      expect(payload.result).toMatchObject({
        ok: true,
        memoriesImported: 1,
        entitiesImported: 2,
        relationshipsImported: 1,
      });
      const [persistedMemories, from, to] = await Promise.all([
        database.memory.findMany({
          where: importedMemoryWhere,
          select: { id: true },
        }),
        database.memoryEntity.findFirst({
          where: { environmentId: primary.environmentId, entityKey: "win235:import:from" },
        }),
        database.memoryEntity.findFirst({
          where: { environmentId: primary.environmentId, entityKey: "win235:import:to" },
        }),
      ]);
      const newMemoryIds = persistedMemories
        .map((memory) => memory.id)
        .filter((id) => !beforeMemoryIds.has(id));
      expect(newMemoryIds).toHaveLength(1);
      const memoryId = newMemoryIds[0];
      const memoryResult = await agentRequestResult<{
        memories: Array<{ id: string; content: string; metadata: unknown }>;
        total: number;
      }>(`/api/v1/memory?userId=${encodeURIComponent(primary.endUserId)}&kind=profile`, {
        ...primary,
        agentId: createdAgentId,
      });
      expect(memoryResult.status).toBe(200);
      const memory = memoryResult.payload.memories.find((candidate) => candidate.id === memoryId);
      expect(memory).toMatchObject({
        id: memoryId,
        content: importedMemoryContent,
        metadata: { profileKey: "win235-imported-profile" },
      });
      expect(from).not.toBeNull();
      expect(to).not.toBeNull();
      const relationship = await database.memoryRelationship.findFirst({
        where: { fromEntityId: from!.id, toEntityId: to!.id, relationshipType: "works_on" },
      });
      expect(relationship).not.toBeNull();
      return {
        httpStatus: response.status,
        readBack: {
          memoryId,
          memoryReadHttpStatus: memoryResult.status,
          relationshipId: relationship?.id,
        },
      };
    });

    await check("controller.memory.relate", async () => {
      const result = await agentRequestResult<{ relationshipId: string }>(
        "/api/v1/memory/relate",
        { ...primary, agentId: createdAgentId },
        {
          method: "POST",
          body: {
            userId: primary.endUserId,
            fromEntityKey: "win235:relate:from",
            toEntityKey: "win235:relate:to",
            relationshipType: "depends_on",
          },
        }
      );
      expect(result.status).toBe(201);
      const relationship = await database.memoryRelationship.findUnique({
        where: { id: result.payload.relationshipId },
      });
      expect(relationship?.relationshipType).toBe("depends_on");
      return { httpStatus: result.status, readBack: { relationshipId: relationship?.id } };
    });

    await check("controller.provider.rotate", async () => {
      const created = await credentialRequestResult<{ key: { id: string; credentialId: string } }>(
        "/api/v1/agent/providers/keys/byok",
        primary,
        {
          method: "POST",
          body: {
            provider: "win235-fixture",
            label: "Canonical fixture key",
            envVarName: "WIN235_FIXTURE_KEY",
            plaintext: "win235-first-secret-value",
            isDefault: true,
          },
        }
      );
      expect(created.status).toBe(201);
      const rotated = await credentialRequestResult(
        `/api/v1/agent/providers/keys/${created.payload.key.id}/rotate-secret`,
        primary,
        { method: "POST", body: { plaintext: "win235-rotated-secret-value" } }
      );
      expect(rotated.status).toBe(201);
      const credential = await database.credential.findUnique({
        where: { id: created.payload.key.credentialId },
        include: { activeSecretVersion: true, secretVersions: true },
      });
      expect(credential?.activeSecretVersion?.secretRevision).toBe(2);
      expect(credential?.secretVersions).toHaveLength(2);
      return {
        httpStatus: rotated.status,
        readBack: {
          credentialId: credential?.id,
          createHttpStatus: created.status,
          activeSecretRevision: credential?.activeSecretVersion?.secretRevision,
          versions: credential?.secretVersions.length,
        },
      };
    });

    await check("action.memory.archive", async () => {
      const response = await webappDataRequest(
        `${environmentPath(primary)}/memories`,
        remixRouteIds.memories,
        {
          method: "POST",
          body: new URLSearchParams({
            intent: "memory-archive",
            userId: primary.endUserId,
            agentId: primary.agentIds[0],
            id: primary.profileMemoryId,
          }),
        }
      );
      expect(response.status).toBe(200);
      const archived = await database.memory.findUnique({ where: { id: primary.profileMemoryId } });
      expect(archived?.archivedAt).not.toBeNull();
      return {
        httpStatus: response.status,
        readBack: { id: primary.profileMemoryId, exists: true, archived: true },
      };
    });

    await check("action.memory.restore", async () => {
      const response = await webappDataRequest(
        `${environmentPath(primary)}/memories`,
        remixRouteIds.memories,
        {
          method: "POST",
          body: new URLSearchParams({
            intent: "memory-restore",
            userId: primary.endUserId,
            agentId: primary.agentIds[0],
            id: primary.profileMemoryId,
          }),
        }
      );
      expect(response.status).toBe(200);
      const restored = await database.memory.findUnique({ where: { id: primary.profileMemoryId } });
      expect(restored?.archivedAt).toBeNull();
      return {
        httpStatus: response.status,
        readBack: { id: primary.profileMemoryId, exists: true, archived: false },
      };
    });

    await check("controller.agent.delete", async () => {
      const result = await agentRequestResult<{ deleted: boolean }>(
        `/api/v1/agent/agents/${createdAgentId}`,
        primary,
        { method: "DELETE" }
      );
      expect(result.status).toBe(200);
      expect(result.payload.deleted).toBe(true);
      const [agent, binding] = await Promise.all([
        database.agent.findUnique({ where: { id: createdAgentId } }),
        database.agentBinding.findUnique({
          where: {
            environmentId_agentId: {
              environmentId: primary.environmentId,
              agentId: createdAgentId,
            },
          },
        }),
      ]);
      expect(agent?.isActive).toBe(false);
      expect(binding).toBeNull();
      return {
        httpStatus: result.status,
        readBack: { id: createdAgentId, active: agent?.isActive, bindingExists: false },
      };
    });
  });

  it("returns stable status/error contracts and rejects every cross-scope axis", async () => {
    await check("negative.enum-mismatch", async () => {
      const form = agentForm("WIN-235 invalid enum must not persist", "win235-invalid-enum-agent");
      form.set("toolMode", "tool-wrapper");
      const response = await webappDataRequest(
        `${environmentPath(primary)}/agents/new`,
        remixRouteIds.agentCreate,
        { method: "POST", body: form }
      );
      const payload = await responsePayload(response);
      expect(response.status).toBe(400);
      expect(payload).toEqual({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid toolMode",
        },
      });
      expect(
        await database.agent.count({
          where: {
            projectId: primary.projectId,
            name: "WIN-235 invalid enum must not persist",
          },
        })
      ).toBe(0);
      return {
        httpStatus: response.status,
        errorCode: payload.error.code,
        readBack: { persisted: false },
      };
    });

    await check("negative.organization", async () => {
      const response = await agentResponse("/api/v1/agent/agents", {
        ...primary,
        organizationId: secondary.organizationId,
      });
      const payload = await responsePayload(response);
      expect(response.status).toBe(200);
      expect(payload.total).toBe(0);
      expect(payload.agents).toEqual([]);
      return { httpStatus: response.status, readBack: { total: payload.total } };
    });

    await check("negative.project", async () => {
      const response = await agentResponse("/api/v1/agent/agents", {
        ...primary,
        projectId: secondary.projectId,
      });
      const payload = await responsePayload(response);
      expect(response.status).toBe(200);
      expect(payload.total).toBe(0);
      expect(payload.agents).toEqual([]);
      return { httpStatus: response.status, readBack: { total: payload.total } };
    });

    await check("negative.environment", async () => {
      const response = await agentResponse("/api/v1/agent/agents", {
        ...primary,
        environmentId: secondary.environmentId,
      });
      const payload = await responsePayload(response);
      expect(response.status).toBe(200);
      expect(payload.total).toBe(0);
      expect(payload.agents).toEqual([]);
      return { httpStatus: response.status, readBack: { total: payload.total } };
    });

    await check("negative.agent", async () => {
      const response = await agentResponse(
        "/api/v1/memory?userId=" + encodeURIComponent(primary.endUserId),
        { ...primary, agentId: secondary.agentIds[0] }
      );
      const payload = await responsePayload(response);
      expect(response.status).toBe(403);
      expect(payload.error).toBe("INVALID_AGENT_SCOPE");
      return { httpStatus: response.status, errorCode: payload.error };
    });

    await check("negative.end-user", async () => {
      const response = await webappDataRequest(
        `${environmentPath(primary)}/memories`,
        remixRouteIds.memories,
        {
          method: "POST",
          body: new URLSearchParams({
            intent: "memory-create",
            userId: secondary.endUserId,
            agentId: primary.agentIds[0],
            content: "cross-scope EndUser must not persist",
            kind: "fact",
            visibility: "private",
          }),
        }
      );
      const payload = await responsePayload(response);
      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("MEMORY_END_USER_CONTEXT_REQUIRED");
      expect(
        await database.memory.count({ where: { content: "cross-scope EndUser must not persist" } })
      ).toBe(0);
      return {
        httpStatus: response.status,
        errorCode: payload.error.code,
        readBack: { persisted: false },
      };
    });

    await check("negative.agent-cluster", async () => {
      const result = await agentPanel(`/api/v1/agent/clusters/${secondary.clusterId}`, primary);
      expect(result.ok).toBe(false);
      if (result.ok !== false) throw new Error("cross-scope AgentCluster unexpectedly resolved");
      expect(result.error.status).toBe(404);
      expect(result.error.code).toBe("AGENT_API_ERROR");
      return { httpStatus: result.error.status, errorCode: result.error.code };
    });
  });
});
