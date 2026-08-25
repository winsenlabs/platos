import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  VISUAL_MODES,
  consumeValidatedBrowserEvidenceReference,
  resolveArtifactDirectoryArgument,
  verifyBrowserEvidenceDirectory,
} from "./verify-artifacts.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const HEAD = "a".repeat(40);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("browser verifier CLI ignores pnpm separators and rejects extra paths", () => {
  assert.equal(
    resolveArtifactDirectoryArgument(["--", "artifacts/browser"], undefined),
    "artifacts/browser"
  );
  assert.equal(
    resolveArtifactDirectoryArgument(["--"], "configured/browser"),
    "configured/browser"
  );
  assert.throws(
    () => resolveArtifactDirectoryArgument(["first", "second"], undefined),
    /at most one browser artifact-directory/
  );
});

test("verifier rejects a missing capability cell", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const cells = await cellFiles(evidence);
    await unlink(path.join(evidence, "cells", cells[0]));
    await assert.rejects(verify(evidence, persisted), /missing a capability\/mode cell/);
  });
});

test("verifier rejects a missing visual mode", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const runPath = path.join(evidence, "run.json");
    const run = await readJson(runPath);
    run.visualModes = run.visualModes.filter((mode) => mode !== "mobile-dark");
    await writeJson(runPath, run);
    await assert.rejects(verify(evidence, persisted), /exact four visual modes/);
  });
});

test("verifier rejects a cell without real-session auth", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const cellPath = await firstCellPath(evidence);
    const cell = await readJson(cellPath);
    cell.auth.alpha = false;
    await writeJson(cellPath, cell);
    await assert.rejects(verify(evidence, persisted), /real Alpha\/Beta serialized sessions/);
  });
});

test("verifier rejects a 404 or non-canonical final route", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const cellPath = await firstCellPath(evidence);
    const cell = await readJson(cellPath);
    cell.route.httpStatus = 404;
    cell.route.reloadHttpStatus = 404;
    cell.route.finalPathname = "/404";
    await writeJson(cellPath, cell);
    await assert.rejects(verify(evidence, persisted), /navigation status drifted/);
  });
});

test("verifier rejects a mutation without hard-reload read-back", async () => {
  await withFixture(async ({ evidence, persisted, contract }) => {
    const cellPath = path.join(
      evidence,
      "cells",
      `${contract.mutationCapabilityIds[0]}--desktop-light.json`
    );
    const cell = await readJson(cellPath);
    cell.mutation.hardReloadReadBack = false;
    await writeJson(cellPath, cell);
    await assert.rejects(verify(evidence, persisted), /hard-reload persisted read-back/);
  });
});

test("verifier rejects a mutation whose observed payload changes after hard reload", async () => {
  await withFixture(async ({ evidence, persisted, contract }) => {
    const cellPath = path.join(
      evidence,
      "cells",
      `${contract.mutationCapabilityIds[0]}--desktop-light.json`
    );
    const cell = await readJson(cellPath);
    cell.mutation.witness.postReloadPayloadSha256 = "c".repeat(64);
    await writeJson(cellPath, cell);
    await assert.rejects(
      verify(evidence, persisted),
      /same canonical UI payload after hard reload/
    );
  });
});

test("verifier rejects incomplete message rating DELETE and operator-denial evidence", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const cellPath = path.join(
      evidence,
      "cells",
      "message-rating-lifecycle--desktop-light.json"
    );
    const cell = await readJson(cellPath);
    delete cell.mutation.witness.lifecycle.operatorDeleteDenied;
    await writeJson(cellPath, cell);
    await assert.rejects(verify(evidence, persisted), /lacks operator DELETE denial/);

    cell.mutation.witness.lifecycle.operatorDeleteDenied = true;
    cell.mutation.witness.lifecycle.postDeleteReloadFieldSha256 = "f".repeat(64);
    await writeJson(cellPath, cell);
    await assert.rejects(verify(evidence, persisted), /DELETE field did not survive hard reload/);
  });
});

for (const regression of [
  { capabilityId: "message-rating-lifecycle", hash: "field" },
  { capabilityId: "agent-tools-loader-action-mismatch", hash: "field" },
  { capabilityId: "access-key-allowed-origins", hash: "payload" },
  { capabilityId: "mcp-token-revoke", hash: "field" },
  { capabilityId: "entity-mcp-bearer-token-delete", hash: "payload" },
  { capabilityId: "mcp-combined-identity-modes", hash: "field" },
  { capabilityId: "mcp-identity-context", hash: "payload" },
  { capabilityId: "mcp-tool-acl-policy", hash: "field" },
]) {
  test(`verifier rejects a successful no-op for ${regression.capabilityId}`, async () => {
    await withFixture(async ({ evidence, persisted }) => {
      const cellPath = path.join(
        evidence,
        "cells",
        `${regression.capabilityId}--desktop-light.json`
      );
      const cell = await readJson(cellPath);
      if (regression.hash === "field") {
        cell.mutation.witness.postActionFieldSha256 = cell.mutation.witness.preActionFieldSha256;
        await writeJson(cellPath, cell);
        await assert.rejects(verify(evidence, persisted), /successful no-op/);
      } else {
        cell.mutation.witness.postActionPayloadSha256 =
          cell.mutation.witness.preActionPayloadSha256;
        await writeJson(cellPath, cell);
        await assert.rejects(verify(evidence, persisted), /did not change canonical UI payload/);
      }
    });
  });
}

test("verifier rejects a missing screenshot or trace artifact", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const cell = await readJson(await firstCellPath(evidence));
    await unlink(path.join(evidence, cell.artifacts.screenshot));
    await assert.rejects(verify(evidence, persisted), /ENOENT/);
  });
});

test("verifier rejects secret-bearing metadata and emits no validated reference", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const cellPath = await firstCellPath(evidence);
    const cell = await readJson(cellPath);
    cell.token = "Bearer should-never-be-metadata";
    await writeJson(cellPath, cell);
    await assert.rejects(verify(evidence, persisted), /forbidden secret-bearing key token/);
    await assert.rejects(readFile(path.join(evidence, "validated-reference.json")), /ENOENT/);
  });
});

test("verifier emits an exact-head validated reference only for complete evidence", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const manifest = await verify(evidence, persisted);
    const reference = await readJson(path.join(evidence, "validated-reference.json"));
    assert.equal(manifest.coverage.cells, 428);
    assert.equal(reference.commitSha, HEAD);
    assert.equal(reference.evidenceSha256, manifest.artifactManifestSha256);
    assert.equal(reference.kind, "win234-validated-browser-evidence-reference");
    const consumed = await consumeValidatedBrowserEvidenceReference(evidence, {
      repositoryRoot: REPOSITORY_ROOT,
      expectedHead: HEAD,
    });
    assert.deepEqual(consumed, reference);
  });
});

test("validated reference consumer rejects a manifest changed after verification", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    await verify(evidence, persisted);
    const manifestPath = path.join(evidence, "manifest.json");
    const manifest = await readJson(manifestPath);
    manifest.coverage.cells -= 1;
    await writeJson(manifestPath, manifest);
    await assert.rejects(
      consumeValidatedBrowserEvidenceReference(evidence, {
        repositoryRoot: REPOSITORY_ROOT,
        expectedHead: HEAD,
      }),
      /manifest hash is invalid/
    );
  });
});

test("validated reference consumer recomputes every cell, screenshot, and trace identity", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    const manifest = await verify(evidence, persisted);
    const entry = manifest.cells[0];
    for (const artifact of [entry.cell, entry.screenshot, entry.trace]) {
      const file = path.join(evidence, artifact.path);
      const original = await readFile(file);
      await writeFile(file, Buffer.concat([original, Buffer.from("tampered")]));
      await assert.rejects(
        consumeValidatedBrowserEvidenceReference(evidence, {
          repositoryRoot: REPOSITORY_ROOT,
          expectedHead: HEAD,
        }),
        /(?:size|hash) drifted/
      );
      await writeFile(file, original);
    }
  });
});

test("validated reference consumer rejects artifact identity mutation in the reference", async () => {
  await withFixture(async ({ evidence, persisted }) => {
    await verify(evidence, persisted);
    const referencePath = path.join(evidence, "validated-reference.json");
    const reference = await readJson(referencePath);
    reference.cells[0].trace.size += 1;
    await writeJson(referencePath, reference);
    await assert.rejects(
      consumeValidatedBrowserEvidenceReference(evidence, {
        repositoryRoot: REPOSITORY_ROOT,
        expectedHead: HEAD,
      }),
      /artifact identities drifted/
    );
  });
});

function verify(evidence, persisted) {
  return verifyBrowserEvidenceDirectory(evidence, {
    repositoryRoot: REPOSITORY_ROOT,
    persistedStateDirectory: persisted,
    expectedHead: HEAD,
  });
}

async function withFixture(operation) {
  const root = await mkdtemp(path.join(tmpdir(), "win234-browser-verifier-"));
  try {
    const fixture = await fixtureDirectory(root);
    await operation(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function cellFiles(evidence) {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(path.join(evidence, "cells"))).filter((name) => name.endsWith(".json"));
}

async function firstCellPath(evidence) {
  const files = await cellFiles(evidence);
  return path.join(evidence, "cells", files.sort()[0]);
}

async function fixtureDirectory(root) {
  const evidence = path.join(root, "browser");
  const persisted = path.join(root, "win235");
  const contract = await readJson(
    path.join(REPOSITORY_ROOT, "tests/browser-evidence/capability-contract.json")
  );
  const matrixPath = path.join(REPOSITORY_ROOT, "docs/audits/win-234-route-capability-parity.json");
  const matrixBytes = await readFile(matrixPath);
  const matrix = JSON.parse(matrixBytes.toString("utf8"));
  const matrixById = new Map(
    matrix.capabilities.map((capability) => [capability.capabilityId, capability])
  );
  const digestHex = { agent: "a", webapp: "b", migrations: "c" };
  const image = (name) => `ghcr.io/winsenlabs/${name}@sha256:${digestHex[name].repeat(64)}`;
  const candidateImages = {
    commitSha: HEAD,
    agent: image("agent"),
    webapp: image("webapp"),
    migrations: image("migrations"),
  };
  const fixtureBody = {
    schemaVersion: 1,
    fixture: "win235-canonical-dense-v1",
    fixtureTimestamp: "2026-08-24T00:00:00.000Z",
    counts: { organizations: 2, agents: 40, turns: 120 },
    scopes: [
      { key: "alpha", operatorId: "alpha-operator" },
      { key: "beta", operatorId: "beta-operator" },
    ],
  };
  const persistedFixture = {
    ...fixtureBody,
    sha256: sha256(`${JSON.stringify(fixtureBody, null, 2)}\n`),
  };
  await writeJson(path.join(persisted, "fixture-manifest.json"), persistedFixture);
  await writeJson(path.join(persisted, "candidate-images.json"), candidateImages);
  await writeJson(path.join(evidence, "run.json"), {
    schemaVersion: 1,
    gate: "win234-authenticated-browser-evidence",
    commitSha: HEAD,
    candidateImages,
    fixture: {
      schemaVersion: 1,
      fixture: persistedFixture.fixture,
      sha256: persistedFixture.sha256,
      counts: persistedFixture.counts,
      principals: [
        {
          key: "alpha",
          operatorId: "alpha-operator",
          organizationSlug: "alpha-org",
          projectSlug: "alpha-project",
          environmentSlug: "alpha-environment",
          threadId: "alpha-thread",
        },
        {
          key: "beta",
          operatorId: "beta-operator",
          organizationSlug: "beta-org",
          projectSlug: "beta-project",
          environmentSlug: "beta-environment",
          threadId: "beta-thread",
        },
      ],
    },
    matrix: {
      path: "docs/audits/win-234-route-capability-parity.json",
      sha256: sha256(matrixBytes),
      capabilityCount: 107,
    },
    visualModes: VISUAL_MODES,
    expectedCellCount: 428,
    authentication: {
      principals: ["alpha", "beta"],
      issuancePath: "operatorAuth.issueOperatorSession",
      serializationPath: "commitOperatorSession",
      cookieStorage: "process-memory-only",
      persistedToArtifacts: false,
    },
  });

  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([0])]);
  for (const capabilityId of contract.capabilityIds) {
    const capability = matrixById.get(capabilityId);
    assert.ok(capability);
    for (const visualMode of VISUAL_MODES) {
      const stem = `${capabilityId}--${visualMode}`;
      const screenshot = `screenshots/${stem}.png`;
      const trace = `traces/${stem}.trace.json`;
      const mutation = contract.mutationCapabilityIds.includes(capabilityId);
      const pagination = contract.paginationCapabilityIds.includes(capabilityId);
      const navigation = contract.navigationContracts[capabilityId];
      const environmentPath = "/orgs/alpha-org/projects/alpha-project/env/alpha-environment";
      const finalPathByContract = {
        target: "/fixture",
        "environment/agents": `${environmentPath}/agents`,
        "environment/mcps": `${environmentPath}/mcps`,
        "environment/settings/general": `${environmentPath}/settings/general`,
        "environment/thread": `${environmentPath}/threads/alpha-thread`,
        "environment/thread/trace": `${environmentPath}/threads/alpha-thread/trace`,
        "organization/settings/team": "/orgs/alpha-org/settings/team",
      };
      const expectedPathname = finalPathByContract[navigation.expectedFinalPath];
      await writeJson(path.join(evidence, "cells", `${stem}.json`), {
        schemaVersion: 1,
        capabilityId,
        currentRoute: capability.currentRoute,
        visualMode,
        visual: {
          device: visualMode.startsWith("desktop-") ? "desktop" : "mobile",
          colorScheme: visualMode.endsWith("-dark") ? "dark" : "light",
          viewport: visualMode.startsWith("desktop-")
            ? { width: 1280, height: 720 }
            : { width: 412, height: 915 },
        },
        status: "passed",
        route: {
          requestedPathname: "/fixture",
          expectedPathname,
          finalPathname: expectedPathname,
          authenticated: true,
          deepLinkRefresh: true,
          httpStatus: 200,
          reloadHttpStatus: 200,
        },
        auth: {
          alpha: true,
          beta: true,
          issuance: "server-side-real-session",
          serialization: "commitOperatorSession",
          cookiePersistence: false,
        },
        keyboard: {
          required: contract.interactiveCapabilityIds.includes(capabilityId),
          focused: contract.interactiveCapabilityIds.includes(capabilityId),
        },
        permission: {
          kind:
            capability.tenantScope.status === "enforced"
              ? "cross-tenant-denied"
              : "public-contract",
          verified: true,
        },
        pagination: {
          required: pagination,
          performed: pagination && visualMode === "desktop-light",
          ...(pagination && visualMode !== "desktop-light"
            ? { delegatedMode: "desktop-light" }
            : {}),
          ...(pagination && visualMode === "desktop-light"
            ? {
                totalPages: 5,
                rowIdentitySha256: {
                  first: "1".repeat(64),
                  middle: "2".repeat(64),
                  final: "3".repeat(64),
                },
              }
            : {}),
          pages: pagination && visualMode === "desktop-light" ? ["first", "middle", "final"] : [],
        },
        mutation: {
          required: mutation,
          performed: mutation && visualMode === "desktop-light",
          hardReloadReadBack: mutation && visualMode === "desktop-light",
          handler: contract.mutationHandlers[capabilityId],
          ...(mutation && visualMode !== "desktop-light" ? { delegatedMode: "desktop-light" } : {}),
          ...(mutation && visualMode === "desktop-light"
            ? {
                witness: {
                  kind: "id",
                  identitySha256: "a".repeat(64),
                  intendedFieldSha256: "b".repeat(64),
                  preActionFieldSha256: "c".repeat(64),
                  postActionFieldSha256: "d".repeat(64),
                  postReloadFieldSha256: "d".repeat(64),
                  preActionPayloadSha256: "e".repeat(64),
                  postActionPayloadSha256: "f".repeat(64),
                  postReloadPayloadSha256: "f".repeat(64),
                  ...(capabilityId === "message-rating-lifecycle"
                    ? {
                        lifecycle: {
                          preDeleteFieldSha256: "d".repeat(64),
                          postDeleteFieldSha256: "c".repeat(64),
                          postDeleteReloadFieldSha256: "c".repeat(64),
                          preDeletePayloadSha256: "f".repeat(64),
                          postDeletePayloadSha256: "e".repeat(64),
                          postDeleteReloadPayloadSha256: "e".repeat(64),
                          operatorPostDenied: true,
                          operatorDeleteDenied: true,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        },
        artifacts: { screenshot, trace },
      });
      await mkdir(path.join(evidence, "screenshots"), { recursive: true });
      await writeFile(path.join(evidence, screenshot), png);
      await writeJson(path.join(evidence, trace), {
        schemaVersion: 1,
        kind: "secret-sanitized-browser-trace",
        capabilityId,
        visualMode,
        includesRequestHeaders: false,
        includesRequestBodies: false,
        includesCookies: false,
        steps: [
          { name: "route", status: "passed", pathname: "/fixture" },
          { name: "refresh", status: "passed", pathname: "/fixture" },
          { name: "permission", status: "passed", pathname: "/fixture" },
        ],
      });
    }
  }
  return { evidence, persisted, contract };
}
