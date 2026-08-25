import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  REPOSITORY_ROOT,
  VISUAL_MODES,
  artifactRoot,
  fixtureBodySha256,
  loadBrowserCapabilities,
  loadFixtureManifest,
} from "./contracts";
import { startBrowserHttpsProxy } from "./https-proxy";

type CandidateImages = {
  commitSha: string;
  agent: string;
  webapp: string;
  migrations: string;
};

async function createBrowserCredential(scope: ReturnType<typeof loadFixtureManifest>["scopes"][number]) {
  const agentUrl = process.env.PLATOS_AGENT_API_URL;
  const internalAuthToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
  if (!agentUrl || !internalAuthToken) {
    throw new Error("Browser credential setup requires the candidate Agent and internal auth");
  }
  const response = await fetch(new URL("/api/v1/agent/providers/keys/byok", agentUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-User-Id": scope.userId,
      "X-Platos-Internal-Auth": internalAuthToken,
    },
    body: JSON.stringify({
      provider: "win235-browser",
      label: "Browser MCP reference",
      envVarName: "WIN235_BROWSER_REFERENCE",
      plaintext: "win235-browser-reference-value",
      isDefault: false,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 201) {
    throw new Error(`Browser credential setup returned HTTP ${response.status}`);
  }
}

function exactHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
}

function digestReference(value: string, name: string) {
  if (!/^ghcr\.io\/.+@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} is not an immutable GHCR digest reference`);
  }
}

export default async function globalSetup() {
  const stopBrowserHttpsProxy = await startBrowserHttpsProxy();
  const output = artifactRoot();
  const persistedStateRoot = path.resolve(
    process.env.WIN235_ARTIFACT_DIR ?? path.join(path.dirname(output), "win235")
  );
  const candidateImages = JSON.parse(
    await readFile(path.join(persistedStateRoot, "candidate-images.json"), "utf8")
  ) as CandidateImages;
  const fixture = loadFixtureManifest();
  const capabilities = loadBrowserCapabilities();
  const head = exactHead();

  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Browser evidence HEAD is not immutable");
  if (candidateImages.commitSha !== head) {
    throw new Error(
      `Browser evidence is fail-closed: candidate commit ${candidateImages.commitSha} does not equal HEAD ${head}`
    );
  }
  if (process.env.PLATOS_CANDIDATE_SHA && process.env.PLATOS_CANDIDATE_SHA !== head) {
    throw new Error(
      `PLATOS_CANDIDATE_SHA ${process.env.PLATOS_CANDIDATE_SHA} does not equal browser evidence HEAD ${head}`
    );
  }
  for (const name of ["agent", "webapp", "migrations"] as const) {
    digestReference(candidateImages[name], name);
  }
  if (fixture.sha256 !== fixtureBodySha256(fixture)) {
    throw new Error("Canonical fixture manifest SHA-256 does not match its body");
  }
  if (fixture.fixture !== "win235-canonical-dense-v1" || fixture.scopes.length !== 2) {
    throw new Error("Browser evidence did not receive the canonical Alpha/Beta dense fixture");
  }
  for (const scope of fixture.scopes) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(scope.publicGuestAgentId) ||
      !scope.agentIds.includes(scope.publicGuestAgentId)
    ) {
      throw new Error(`Browser evidence ${scope.key} scope lacks its explicit public guest Agent`);
    }
  }
  await createBrowserCredential(fixture.scopes[0]);

  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, "cells"), { recursive: true });
  await mkdir(path.join(output, "screenshots"), { recursive: true });
  await mkdir(path.join(output, "traces"), { recursive: true });
  await writeFile(
    path.join(output, "run.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gate: "win234-authenticated-browser-evidence",
        commitSha: head,
        candidateImages,
        fixture: {
          schemaVersion: fixture.schemaVersion,
          fixture: fixture.fixture,
          sha256: fixture.sha256,
          counts: fixture.counts,
          principals: fixture.scopes.map(
            ({
              key,
              operatorId,
              organizationId,
              organizationSlug,
              projectId,
              projectSlug,
              environmentId,
              environmentSlug,
              threadId,
              publicGuestAgentId,
            }) => ({
              key,
              operatorId,
              organizationId,
              organizationSlug,
              projectId,
              projectSlug,
              environmentId,
              environmentSlug,
              threadId,
              publicGuestAgentId,
            })
          ),
        },
        matrix: {
          path: "docs/audits/win-234-route-capability-parity.json",
          sha256: createHash("sha256")
            .update(
              await readFile(
                path.join(REPOSITORY_ROOT, "docs/audits/win-234-route-capability-parity.json")
              )
            )
            .digest("hex"),
          capabilityCount: capabilities.length,
        },
        visualModes: VISUAL_MODES,
        expectedCellCount: capabilities.length * VISUAL_MODES.length,
        authentication: {
          principals: ["alpha", "beta"],
          issuancePath: "operatorAuth.issueOperatorSession",
          serializationPath: "commitOperatorSession",
          cookieStorage: "process-memory-only",
          persistedToArtifacts: false,
        },
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o644 }
  );
  return stopBrowserHttpsProxy;
}
