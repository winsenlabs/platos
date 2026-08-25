#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIRECTORY, "../..");
export const VISUAL_MODES = ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactHead(repositoryRoot = ROOT) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function canonicalFixtureHash(fixture) {
  const { sha256: _sha256, ...body } = fixture;
  return sha256(`${JSON.stringify(body, null, 2)}\n`);
}

function assertSecretSafe(value, location = "metadata") {
  if (typeof value === "string") {
    assert.doesNotMatch(
      value,
      /(?:^|\s)(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/i,
      `${location} contains an authorization value`
    );
    assert.doesNotMatch(
      value,
      /plt_(?:mcp|ent)_[A-Za-z0-9_-]+/,
      `${location} contains a bearer token`
    );
    assert.doesNotMatch(value, /platos_live_[A-Za-z0-9_-]+/, `${location} contains an access key`);
    assert.doesNotMatch(
      value,
      /tr_(?:dev|prod|test)_[A-Za-z0-9_-]+/,
      `${location} contains an access key`
    );
    assert.doesNotMatch(
      value,
      /(?:set-cookie|cookie:)\s*[^;\s]+=/i,
      `${location} contains cookie material`
    );
    assert.doesNotMatch(
      value,
      /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
      `${location} contains a JWT-like value`
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretSafe(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(
      key,
      /^(?:token|tokenValue|cookieValue|authorization|password|secret|sessionMaterial|rawKey|keyHash)$/i,
      `${location} contains forbidden secret-bearing key ${key}`
    );
    assertSecretSafe(entry, `${location}.${key}`);
  }
}

function safeArtifactPath(root, relative, expectedPrefix) {
  assert.equal(typeof relative, "string", "artifact path must be a string");
  assert.ok(
    relative.startsWith(`${expectedPrefix}/`),
    `artifact path must be under ${expectedPrefix}`
  );
  assert.ok(!path.isAbsolute(relative), "artifact path must be relative");
  const resolved = path.resolve(root, relative);
  assert.ok(resolved.startsWith(`${root}${path.sep}`), "artifact path escapes evidence root");
  return resolved;
}

async function assertScreenshot(file) {
  const metadata = await stat(file);
  assert.ok(
    metadata.isFile() && metadata.size > PNG_SIGNATURE.length,
    `${file} is not a non-empty screenshot`
  );
  const bytes = await readFile(file);
  assert.ok(
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
    `${file} is not a PNG screenshot`
  );
}

async function fileIdentity(file, relativePath) {
  const [metadata, bytes] = await Promise.all([stat(file), readFile(file)]);
  assert.ok(metadata.isFile(), `${file} is not an artifact file`);
  return { path: relativePath, size: metadata.size, sha256: sha256(bytes) };
}

function assertFileIdentity(actual, expected, label) {
  assert.equal(actual.path, expected.path, `${label} path drifted`);
  assert.equal(actual.size, expected.size, `${label} size drifted`);
  assert.equal(actual.sha256, expected.sha256, `${label} hash drifted`);
}

async function assertTrace(file, cell) {
  const trace = await json(file);
  assert.equal(trace.schemaVersion, 1, "trace schema version drifted");
  assert.equal(
    trace.kind,
    "secret-sanitized-browser-trace",
    "trace is not secret-sanitized structured evidence"
  );
  assert.equal(trace.capabilityId, cell.capabilityId, "trace capability identity drifted");
  assert.equal(trace.visualMode, cell.visualMode, "trace mode identity drifted");
  assert.equal(trace.includesRequestHeaders, false, "trace includes request headers");
  assert.equal(trace.includesRequestBodies, false, "trace includes request bodies");
  assert.equal(trace.includesCookies, false, "trace includes cookies");
  assert.ok(
    Array.isArray(trace.steps) && trace.steps.length >= 3,
    "trace has no browser action sequence"
  );
  assert.equal(
    trace.steps.filter((step) => step.status !== "passed").length,
    0,
    "trace contains a failed step"
  );
  assertSecretSafe(trace, "trace");
}

function expectedCellKeys(contract) {
  return contract.capabilityIds.flatMap((capabilityId) =>
    VISUAL_MODES.map((mode) => `${capabilityId}\0${mode}`)
  );
}

function assertExactKeys(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  assert.equal(actualSet.size, actual.length, `${label} contains duplicate keys`);
  assert.deepEqual([...actualSet].sort(), [...expectedSet].sort(), `${label} is not exact`);
}

function expectedFinalPathname(navigation, requestedPathname, scope) {
  const environment = `/orgs/${scope.organizationSlug}/projects/${scope.projectSlug}/env/${scope.environmentSlug}`;
  switch (navigation.expectedFinalPath) {
    case "target":
      return requestedPathname;
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
    default:
      assert.fail(`unknown navigation final path ${navigation.expectedFinalPath}`);
  }
}

export async function verifyBrowserEvidenceDirectory(directory, options = {}) {
  const root = path.resolve(directory);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? ROOT);
  const persistedStateRoot = path.resolve(
    options.persistedStateDirectory ??
      process.env.WIN235_ARTIFACT_DIR ??
      path.join(path.dirname(root), "win235")
  );
  const head = options.expectedHead ?? exactHead(repositoryRoot);
  assert.match(head, /^[a-f0-9]{40}$/, "expected browser evidence HEAD is not immutable");

  const [run, contract, matrix, persistedFixture, persistedImages] = await Promise.all([
    json(path.join(root, "run.json")),
    json(path.join(repositoryRoot, "tests/browser-evidence/capability-contract.json")),
    json(path.join(repositoryRoot, "docs/audits/win-234-route-capability-parity.json")),
    json(path.join(persistedStateRoot, "fixture-manifest.json")),
    json(path.join(persistedStateRoot, "candidate-images.json")),
  ]);
  const matrixBytes = await readFile(
    path.join(repositoryRoot, "docs/audits/win-234-route-capability-parity.json")
  );

  assert.equal(run.schemaVersion, 1, "run schema version drifted");
  assert.equal(run.gate, "win234-authenticated-browser-evidence", "unexpected browser gate name");
  assert.equal(run.commitSha, head, "browser run does not identify exact HEAD");
  assert.equal(run.candidateImages.commitSha, head, "candidate images are not exact HEAD");
  assert.deepEqual(
    run.candidateImages,
    persistedImages,
    "browser run image identity differs from persisted-state candidate identity"
  );
  for (const name of ["agent", "webapp", "migrations"]) {
    assert.match(
      run.candidateImages[name],
      /^ghcr\.io\/.+@sha256:[a-f0-9]{64}$/,
      `${name} is not digest pinned`
    );
  }
  assert.equal(
    persistedFixture.sha256,
    canonicalFixtureHash(persistedFixture),
    "persisted fixture hash is invalid"
  );
  assert.equal(
    run.fixture.fixture,
    "win235-canonical-dense-v1",
    "browser run used the wrong fixture"
  );
  assert.equal(run.fixture.sha256, persistedFixture.sha256, "browser run fixture identity drifted");
  assert.deepEqual(
    run.fixture.counts,
    persistedFixture.counts,
    "browser run fixture counts drifted"
  );
  assert.deepEqual(
    run.fixture.principals.map(({ key }) => key),
    ["alpha", "beta"],
    "browser run lacks Alpha/Beta principals"
  );
  const alphaPrincipal = run.fixture.principals.find(({ key }) => key === "alpha");
  for (const key of ["organizationSlug", "projectSlug", "environmentSlug", "threadId"]) {
    assert.equal(
      typeof alphaPrincipal?.[key],
      "string",
      `browser run Alpha principal lacks ${key}`
    );
    assert.ok(alphaPrincipal[key], `browser run Alpha principal has empty ${key}`);
  }
  assert.equal(
    run.authentication.issuancePath,
    "operatorAuth.issueOperatorSession",
    "browser sessions were not issued by operatorAuth"
  );
  assert.equal(
    run.authentication.serializationPath,
    "commitOperatorSession",
    "browser cookies bypassed the server serializer"
  );
  assert.equal(
    run.authentication.cookieStorage,
    "process-memory-only",
    "browser auth cookies were persisted"
  );
  assert.equal(
    run.authentication.persistedToArtifacts,
    false,
    "browser auth material was written to artifacts"
  );
  assert.equal(contract.schemaVersion, 1, "capability contract version drifted");
  assert.equal(
    matrix.capabilities.length,
    107,
    "route capability matrix no longer contains 107 cells"
  );
  assertExactKeys(
    contract.capabilityIds,
    matrix.capabilities.map(({ capabilityId }) => capabilityId),
    "capability contract"
  );
  assertExactKeys(
    Object.keys(contract.navigationContracts),
    contract.capabilityIds,
    "navigation contracts"
  );
  const derivedMutationIds = matrix.capabilities
    .filter(
      ({ actionState, persistedReadBack }) =>
        actionState.status === "implemented" && persistedReadBack.status !== "not-applicable"
    )
    .map(({ capabilityId }) => capabilityId);
  assertExactKeys(
    contract.mutationCapabilityIds,
    derivedMutationIds,
    "persisted interaction mutation capabilities"
  );
  assert.equal(
    contract.mutationCapabilityIds.filter(
      (capabilityId) => !contract.interactiveCapabilityIds.includes(capabilityId)
    ).length,
    0,
    "mutation applicability includes route-shell or non-interaction capabilities"
  );
  assertExactKeys(
    Object.keys(contract.paginationContracts),
    contract.paginationCapabilityIds,
    "pagination contracts"
  );
  assert.equal(
    contract.paginationContracts["thread-artifacts"].pageParam,
    "artifactPage",
    "artifact pagination parameter drifted"
  );
  assert.deepEqual(
    [
      contract.paginationContracts["mcp-token-list"].pageParam,
      contract.paginationContracts["entity-mcp-bearer-token-list"].pageParam,
      contract.paginationContracts["mcp-tool-acl-policy"].pageParam,
    ],
    ["page", "tokenPage", "aclPage"],
    "distinct MCP pagination parameters drifted"
  );
  assert.equal(run.matrix.sha256, sha256(matrixBytes), "browser run matrix hash is not exact HEAD");
  assert.equal(run.matrix.capabilityCount, 107, "browser run capability count drifted");
  assert.deepEqual(
    run.visualModes,
    VISUAL_MODES,
    "browser run does not declare the exact four visual modes"
  );
  assert.equal(run.expectedCellCount, 428, "browser run expected cell count drifted");
  assertSecretSafe(run, "run");

  const cellFiles = (await readdir(path.join(root, "cells")))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.equal(cellFiles.length, 428, "browser evidence is missing a capability/mode cell");
  const cells = await Promise.all(cellFiles.map((name) => json(path.join(root, "cells", name))));
  assertExactKeys(
    cells.map(({ capabilityId, visualMode }) => `${capabilityId}\0${visualMode}`),
    expectedCellKeys(contract),
    "browser evidence cells"
  );
  const matrixById = new Map(
    matrix.capabilities.map((capability) => [capability.capabilityId, capability])
  );
  const cellFileByKey = new Map(
    cellFiles.map((name) => {
      const stem = name.replace(/\.json$/, "");
      const mode = VISUAL_MODES.find((candidate) => stem.endsWith(`--${candidate}`));
      assert.ok(mode, `cell filename ${name} lacks an exact visual mode`);
      return [`${stem.slice(0, -(mode.length + 2))}\0${mode}`, name];
    })
  );
  const summaryCells = [];

  for (const cell of cells) {
    const label = `${cell.capabilityId}/${cell.visualMode}`;
    const capability = matrixById.get(cell.capabilityId);
    assert.ok(capability, `${label} has no matrix capability`);
    assert.equal(cell.schemaVersion, 1, `${label} schema version drifted`);
    assert.ok(VISUAL_MODES.includes(cell.visualMode), `${label} has an unknown visual mode`);
    assert.equal(
      cell.visual.device,
      cell.visualMode.startsWith("desktop-") ? "desktop" : "mobile",
      `${label} device mode drifted`
    );
    assert.equal(
      cell.visual.colorScheme,
      cell.visualMode.endsWith("-dark") ? "dark" : "light",
      `${label} color scheme drifted`
    );
    assert.ok(
      Number.isInteger(cell.visual.viewport.width) && Number.isInteger(cell.visual.viewport.height),
      `${label} viewport is unmeasured`
    );
    if (cell.visual.device === "desktop")
      assert.ok(cell.visual.viewport.width >= 1000, `${label} is not a desktop viewport`);
    else assert.ok(cell.visual.viewport.width < 1000, `${label} is not a mobile viewport`);
    assert.equal(cell.currentRoute, capability.currentRoute, `${label} route identity drifted`);
    assert.equal(cell.status, "passed", `${label} did not pass`);
    const navigation = contract.navigationContracts[cell.capabilityId];
    assert.ok(navigation, `${label} lacks a navigation contract`);
    assert.equal(navigation.expectedHttpStatus, 200, `${label} successful status is not pinned`);
    assert.equal(cell.route.authenticated, true, `${label} was not authenticated routing`);
    assert.equal(cell.route.deepLinkRefresh, true, `${label} lacks deep-link refresh`);
    assert.equal(
      cell.route.httpStatus,
      navigation.expectedHttpStatus,
      `${label} navigation status drifted`
    );
    assert.equal(
      cell.route.reloadHttpStatus,
      navigation.expectedHttpStatus,
      `${label} reload status drifted`
    );
    assert.equal(
      cell.route.expectedPathname,
      expectedFinalPathname(navigation, cell.route.requestedPathname, alphaPrincipal),
      `${label} expected canonical pathname is not contract-derived`
    );
    assert.equal(
      cell.route.expectedPathname,
      cell.route.finalPathname,
      `${label} final canonical pathname drifted`
    );
    assert.notEqual(cell.route.finalPathname, "/404", `${label} accepted a 404 route`);
    assert.deepEqual(
      cell.auth,
      {
        alpha: true,
        beta: true,
        issuance: "server-side-real-session",
        serialization: "commitOperatorSession",
        cookiePersistence: false,
      },
      `${label} does not prove real Alpha/Beta serialized sessions`
    );
    assert.equal(cell.permission.verified, true, `${label} lacks permission/error evidence`);
    assert.ok(
      ["cross-tenant-denied", "unauthenticated-denied", "public-contract"].includes(
        cell.permission.kind
      ),
      `${label} permission/error evidence is invalid`
    );
    if (capability.tenantScope.status === "enforced") {
      assert.equal(
        cell.permission.kind,
        "cross-tenant-denied",
        `${label} lacks an Alpha/Beta tenant denial`
      );
    }
    const interactive = contract.interactiveCapabilityIds.includes(cell.capabilityId);
    assert.equal(cell.keyboard.required, interactive, `${label} keyboard applicability drifted`);
    if (interactive)
      assert.equal(cell.keyboard.focused, true, `${label} lacks keyboard focus evidence`);

    const pagination = contract.paginationCapabilityIds.includes(cell.capabilityId);
    assert.equal(cell.pagination.required, pagination, `${label} pagination applicability drifted`);
    if (pagination && cell.visualMode === "desktop-light") {
      assert.equal(cell.pagination.performed, true, `${label} lacks pagination browser evidence`);
      const paginationContract = contract.paginationContracts[cell.capabilityId];
      assert.ok(paginationContract, `${label} lacks its explicit pagination contract`);
      for (const key of [
        "pageParam",
        "pageSizeParam",
        "resultSelector",
        "totalSelector",
        "totalPattern",
      ]) {
        assert.equal(
          typeof paginationContract[key],
          "string",
          `${label} pagination ${key} is not pinned`
        );
        assert.ok(paginationContract[key], `${label} pagination ${key} is empty`);
      }
      assert.ok(
        paginationContract.rowIdentity?.selector,
        `${label} pagination row identity is not pinned`
      );
      assert.ok(paginationContract.minTotal >= 3, `${label} pagination minimum total is too small`);
      assert.ok(
        Number.isInteger(cell.pagination.totalPages) &&
          cell.pagination.totalPages >= paginationContract.minTotal,
        `${label} pagination total is not dense`
      );
      assert.deepEqual(
        cell.pagination.pages,
        ["first", "middle", "final"],
        `${label} lacks first/middle/final pages`
      );
      assert.deepEqual(
        Object.keys(cell.pagination.rowIdentitySha256 ?? {}).sort(),
        ["final", "first", "middle"],
        `${label} lacks row identities for each page`
      );
      for (const hash of Object.values(cell.pagination.rowIdentitySha256)) {
        assert.match(hash, /^[a-f0-9]{64}$/, `${label} has an invalid row identity hash`);
      }
      assert.equal(
        new Set(Object.values(cell.pagination.rowIdentitySha256)).size,
        3,
        `${label} repeated first/middle/final rows`
      );
    } else if (pagination) {
      assert.equal(
        cell.pagination.delegatedMode,
        "desktop-light",
        `${label} pagination delegation is not deterministic`
      );
    }

    const mutation = contract.mutationCapabilityIds.includes(cell.capabilityId);
    assert.equal(cell.mutation.required, mutation, `${label} mutation applicability drifted`);
    if (mutation && cell.visualMode === "desktop-light") {
      assert.equal(cell.mutation.performed, true, `${label} lacks a real browser mutation`);
      assert.equal(
        cell.mutation.hardReloadReadBack,
        true,
        `${label} lacks hard-reload persisted read-back`
      );
      assert.equal(
        cell.mutation.handler,
        contract.mutationHandlers[cell.capabilityId],
        `${label} used the wrong route-specific mutation handler`
      );
      assert.ok(
        ["id", "revision", "marker"].includes(cell.mutation.witness?.kind),
        `${label} lacks an observed UI identity`
      );
      for (const key of [
        "identitySha256",
        "intendedFieldSha256",
        "preActionFieldSha256",
        "postActionFieldSha256",
        "postReloadFieldSha256",
        "preActionPayloadSha256",
        "postActionPayloadSha256",
        "postReloadPayloadSha256",
      ]) {
        assert.match(cell.mutation.witness?.[key], /^[a-f0-9]{64}$/, `${label} lacks ${key}`);
      }
      assert.notEqual(
        cell.mutation.witness.preActionFieldSha256,
        cell.mutation.witness.postActionFieldSha256,
        `${label} intended field mutation was a successful no-op`
      );
      assert.notEqual(
        cell.mutation.witness.preActionPayloadSha256,
        cell.mutation.witness.postActionPayloadSha256,
        `${label} mutation did not change canonical UI payload`
      );
      assert.equal(
        cell.mutation.witness.postActionFieldSha256,
        cell.mutation.witness.postReloadFieldSha256,
        `${label} did not read back the same intended field after hard reload`
      );
      assert.equal(
        cell.mutation.witness.postActionPayloadSha256,
        cell.mutation.witness.postReloadPayloadSha256,
        `${label} did not read back the same canonical UI payload after hard reload`
      );
      if (cell.capabilityId === "message-rating-lifecycle") {
        const lifecycle = cell.mutation.witness.lifecycle;
        for (const key of [
          "preDeleteFieldSha256",
          "postDeleteFieldSha256",
          "postDeleteReloadFieldSha256",
          "preDeletePayloadSha256",
          "postDeletePayloadSha256",
          "postDeleteReloadPayloadSha256",
        ]) {
          assert.match(lifecycle?.[key], /^[a-f0-9]{64}$/, `${label} lacks lifecycle ${key}`);
        }
        assert.equal(
          lifecycle.preDeleteFieldSha256,
          cell.mutation.witness.postReloadFieldSha256,
          `${label} rating DELETE did not start from the persisted POST state`
        );
        assert.notEqual(
          lifecycle.preDeleteFieldSha256,
          lifecycle.postDeleteFieldSha256,
          `${label} rating DELETE was a successful no-op`
        );
        assert.notEqual(
          lifecycle.preDeletePayloadSha256,
          lifecycle.postDeletePayloadSha256,
          `${label} rating DELETE did not change canonical UI payload`
        );
        assert.equal(
          lifecycle.postDeleteFieldSha256,
          lifecycle.postDeleteReloadFieldSha256,
          `${label} rating DELETE field did not survive hard reload`
        );
        assert.equal(
          lifecycle.postDeletePayloadSha256,
          lifecycle.postDeleteReloadPayloadSha256,
          `${label} rating DELETE payload did not survive hard reload`
        );
        assert.equal(lifecycle.operatorPostDenied, true, `${label} lacks operator POST denial`);
        assert.equal(lifecycle.operatorDeleteDenied, true, `${label} lacks operator DELETE denial`);
      }
    } else if (mutation) {
      assert.equal(
        cell.mutation.delegatedMode,
        "desktop-light",
        `${label} mutation delegation is not deterministic`
      );
    }

    const screenshot = safeArtifactPath(root, cell.artifacts.screenshot, "screenshots");
    const trace = safeArtifactPath(root, cell.artifacts.trace, "traces");
    await Promise.all([assertScreenshot(screenshot), assertTrace(trace, cell)]);
    const cellFile = cellFileByKey.get(`${cell.capabilityId}\0${cell.visualMode}`);
    assert.ok(cellFile, `${label} has no cell artifact path`);
    const cellRelative = `cells/${cellFile}`;
    const [cellIdentity, screenshotIdentity, traceIdentity] = await Promise.all([
      fileIdentity(path.join(root, cellRelative), cellRelative),
      fileIdentity(screenshot, cell.artifacts.screenshot),
      fileIdentity(trace, cell.artifacts.trace),
    ]);
    summaryCells.push({
      capabilityId: cell.capabilityId,
      visualMode: cell.visualMode,
      cell: cellIdentity,
      screenshot: screenshotIdentity,
      trace: traceIdentity,
    });
    assertSecretSafe(cell, `cell ${label}`);
  }

  summaryCells.sort((left, right) =>
    `${left.capabilityId}:${left.visualMode}`.localeCompare(
      `${right.capabilityId}:${right.visualMode}`
    )
  );
  const manifestBody = {
    schemaVersion: 1,
    gate: "win234-authenticated-browser-evidence",
    status: "passed",
    commitSha: head,
    candidateImages: run.candidateImages,
    fixture: {
      fixture: persistedFixture.fixture,
      sha256: persistedFixture.sha256,
      counts: persistedFixture.counts,
    },
    matrix: run.matrix,
    coverage: {
      capabilities: 107,
      visualModes: 4,
      cells: 428,
      mutationCapabilities: contract.mutationCapabilityIds.length,
      paginationCapabilities: contract.paginationCapabilityIds.length,
    },
    cells: summaryCells,
  };
  const artifactManifestSha256 = sha256(`${JSON.stringify(manifestBody, null, 2)}\n`);
  const manifest = { ...manifestBody, artifactManifestSha256 };
  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, "validated-reference.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "win234-validated-browser-evidence-reference",
        commitSha: head,
        evidenceManifest: "manifest.json",
        evidenceSha256: artifactManifestSha256,
        matrixSha256: run.matrix.sha256,
        fixtureSha256: persistedFixture.sha256,
        candidateImages: run.candidateImages,
        coverage: manifest.coverage,
        cells: manifest.cells,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await consumeValidatedBrowserEvidenceReference(root, {
    repositoryRoot,
    expectedHead: head,
  });
  return manifest;
}

export async function consumeValidatedBrowserEvidenceReference(directory, options = {}) {
  const root = path.resolve(directory);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? ROOT);
  const head = options.expectedHead ?? exactHead(repositoryRoot);
  const [manifest, reference, contract] = await Promise.all([
    json(path.join(root, "manifest.json")),
    json(path.join(root, "validated-reference.json")),
    json(path.join(repositoryRoot, "tests/browser-evidence/capability-contract.json")),
  ]);
  const { artifactManifestSha256, ...manifestBody } = manifest;
  const calculated = sha256(`${JSON.stringify(manifestBody, null, 2)}\n`);
  assert.equal(
    manifest.gate,
    "win234-authenticated-browser-evidence",
    "validated browser manifest gate drifted"
  );
  assert.equal(manifest.status, "passed", "validated browser manifest is not green");
  assert.equal(manifest.commitSha, head, "validated browser manifest is not exact HEAD");
  assert.equal(artifactManifestSha256, calculated, "validated browser manifest hash is invalid");
  assert.equal(reference.schemaVersion, 1, "validated browser reference version drifted");
  assert.equal(
    reference.kind,
    "win234-validated-browser-evidence-reference",
    "unexpected validated browser reference kind"
  );
  assert.equal(reference.commitSha, head, "validated browser reference is not exact HEAD");
  assert.equal(
    reference.evidenceManifest,
    "manifest.json",
    "validated browser reference path drifted"
  );
  assert.equal(reference.evidenceSha256, calculated, "validated browser reference hash drifted");
  assert.equal(
    reference.matrixSha256,
    manifest.matrix.sha256,
    "validated browser matrix identity drifted"
  );
  assert.equal(
    reference.fixtureSha256,
    manifest.fixture.sha256,
    "validated browser fixture identity drifted"
  );
  assert.deepEqual(
    reference.candidateImages,
    manifest.candidateImages,
    "validated browser image identity drifted"
  );
  assert.deepEqual(reference.coverage, manifest.coverage, "validated browser coverage drifted");
  assert.deepEqual(
    reference.cells,
    manifest.cells,
    "validated browser artifact identities drifted"
  );
  assert.deepEqual(
    reference.coverage,
    {
      capabilities: 107,
      visualModes: 4,
      cells: 428,
      mutationCapabilities: contract.mutationCapabilityIds.length,
      paginationCapabilities: contract.paginationCapabilityIds.length,
    },
    "validated browser coverage is incomplete"
  );
  assert.equal(
    manifest.cells.length,
    428,
    "validated browser manifest artifact index is incomplete"
  );
  assertExactKeys(
    manifest.cells.map(({ capabilityId, visualMode }) => `${capabilityId}\0${visualMode}`),
    expectedCellKeys(contract),
    "validated browser manifest cells"
  );
  for (const entry of manifest.cells) {
    for (const [kind, expected] of Object.entries({
      cell: entry.cell,
      screenshot: entry.screenshot,
      trace: entry.trace,
    })) {
      const prefix = kind === "cell" ? "cells" : `${kind}s`;
      const file = safeArtifactPath(root, expected.path, prefix);
      const actual = await fileIdentity(file, expected.path);
      assertFileIdentity(actual, expected, `${entry.capabilityId}/${entry.visualMode} ${kind}`);
    }
  }
  assertSecretSafe(reference, "validated reference");
  return reference;
}

export function resolveArtifactDirectoryArgument(args, configuredDirectory) {
  const positional = args.filter((argument) => argument !== "--");
  assert.ok(positional.length <= 1, "expected at most one browser artifact-directory argument");
  return positional[0] || configuredDirectory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = resolveArtifactDirectoryArgument(
    process.argv.slice(2),
    process.env.WIN234_BROWSER_ARTIFACT_DIR
  );
  assert.ok(
    directory,
    "usage: node tests/browser-evidence/verify-artifacts.mjs <artifact-directory>"
  );
  const manifest = await verifyBrowserEvidenceDirectory(directory);
  process.stdout.write(
    `Verified authenticated browser evidence: ${manifest.coverage.capabilities} capabilities, ${manifest.coverage.cells} cells, exact HEAD ${manifest.commitSha}\n`
  );
}
