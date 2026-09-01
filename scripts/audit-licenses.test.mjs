import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildLicenseIndex,
  fetchLicense,
  licenseIndexText,
} from "./audit-licenses.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const components = [
  { name: "alpha", version: "1.0.0" },
  { name: "@scope/beta", version: "2.0.0" },
  { name: "@internal/private", version: "0.0.1" },
];
const responses = new Map([
  ["alpha@1.0.0", { license: "MIT", resolvedFrom: "version", resolutionStatus: "resolved", status: 200, sourceTimestamp: "2024-01-02T03:04:05.000Z" }],
  ["@scope/beta@2.0.0", { license: "Apache-2.0", resolvedFrom: "package", resolutionStatus: "resolved", status: 200, sourceTimestamp: "2025-06-07T08:09:10.000Z" }],
  ["@internal/private@0.0.1", { license: null, resolvedFrom: "not-found", resolutionStatus: "not-found", status: 404, sourceTimestamp: null }],
]);

const resolveLicense = async (name, version) => structuredClone(responses.get(`${name}@${version}`));

test("licence index generation is byte-identical across runs and independent of wall time", async () => {
  const scratch = mkdtempSync("/var/tmp/platos-license-index-");
  const firstPath = resolve(scratch, "first.json");
  const secondPath = resolve(scratch, "second.json");
  const originalNow = Date.now;
  try {
    Date.now = () => 1;
    const first = await buildLicenseIndex({
      lockfileText: "lockfileVersion: '9.0'\n",
      components,
      resolveLicense,
      concurrency: 2,
    });
    writeFileSync(firstPath, licenseIndexText(first));

    Date.now = () => 9_999_999_999_999;
    const second = await buildLicenseIndex({
      lockfileText: "lockfileVersion: '9.0'\n",
      components: [...components].reverse(),
      resolveLicense,
      concurrency: 3,
    });
    writeFileSync(secondPath, licenseIndexText(second));

    assert.equal(readFileSync(firstPath, "utf8"), readFileSync(secondPath, "utf8"));
    assert.equal(first.resolvedAt, "2025-06-07T08:09:10.000Z");
    assert.equal(
      first.resolvedAtPolicy,
      "maximum registry version publication timestamp across successful external resolutions; every successful resolution is timestamped; non-success statuses are excluded"
    );
    assert.equal(first.successfulResolutionCount, 2);
    assert.equal(first.resolvedAtExcludedCount, 1);
    assert.deepEqual(Object.keys(first.index), [
      "@internal/private@0.0.1",
      "@scope/beta@2.0.0",
      "alpha@1.0.0",
    ]);
  } finally {
    Date.now = originalNow;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("source metadata mutation changes the stable resolvedAt value", async () => {
  const baseline = await buildLicenseIndex({
    lockfileText: "lockfileVersion: '9.0'\n",
    components,
    resolveLicense,
  });
  const mutated = await buildLicenseIndex({
    lockfileText: "lockfileVersion: '9.0'\n",
    components,
    resolveLicense: async (name, version) => {
      const result = await resolveLicense(name, version);
      if (name === "alpha") result.sourceTimestamp = "2026-01-01T00:00:00.000Z";
      return result;
    },
  });
  assert.equal(baseline.resolvedAt, "2025-06-07T08:09:10.000Z");
  assert.equal(mutated.resolvedAt, "2026-01-01T00:00:00.000Z");
  assert.notEqual(licenseIndexText(baseline), licenseIndexText(mutated));
});

test("mixed present and missing publication timestamps fail closed", async () => {
  await assert.rejects(
    buildLicenseIndex({
      lockfileText: "lockfileVersion: '9.0'\n",
      components: components.slice(0, 2),
      resolveLicense: async (name, version) => {
        const result = await resolveLicense(name, version);
        if (name === "alpha") delete result.sourceTimestamp;
        return result;
      },
    }),
    /alpha@1\.0\.0: successful resolution is missing its publication timestamp/
  );
});

test("invalid publication timestamps fail closed", async () => {
  for (const invalidTimestamp of ["not-a-publication-time", "2024-01-02"]) {
    await assert.rejects(
      buildLicenseIndex({
        lockfileText: "lockfileVersion: '9.0'\n",
        components: components.slice(0, 2),
        resolveLicense: async (name, version) => {
          const result = await resolveLicense(name, version);
          if (name === "alpha") result.sourceTimestamp = invalidTimestamp;
          return result;
        },
      }),
      /alpha@1\.0\.0: successful resolution has an invalid publication timestamp/
    );
  }
});

function externalError(message, code) {
  const error = new TypeError(message);
  error.cause = { code };
  return error;
}

async function failureEvidence(fetchImpl) {
  let calls = 0;
  const failed = await fetchLicense("external-failure", "1.0.0", {
    fetchImpl: async (...args) => {
      calls++;
      return fetchImpl(...args);
    },
    sleep: async () => {},
  });
  assert.equal(calls, 3);
  const document = await buildLicenseIndex({
    lockfileText: "lockfileVersion: '9.0'\n",
    components: [
      { name: "alpha", version: "1.0.0" },
      { name: "external-failure", version: "1.0.0" },
    ],
    resolveLicense: async (name, version) => name === "alpha"
      ? structuredClone(responses.get(`${name}@${version}`))
      : structuredClone(failed),
  });
  return licenseIndexText(document);
}

test("DNS and TLS exception message mutations produce byte-identical network failure evidence", async () => {
  const dns = await failureEvidence(async () => {
    throw externalError("getaddrinfo ENOTFOUND registry-a.invalid", "ENOTFOUND");
  });
  const tls = await failureEvidence(async () => {
    throw externalError("certificate expired for secret.internal.example", "CERT_HAS_EXPIRED");
  });
  assert.equal(dns, tls);
  assert.match(dns, /"failureCategory": "network"/);
  assert.doesNotMatch(dns, /ENOTFOUND|CERT_HAS_EXPIRED|registry-a|secret\.internal/);
});

test("JSON exception message mutations produce byte-identical invalid-json evidence", async () => {
  const responseWithJsonError = (message) => async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError(message); },
  });
  const truncated = await failureEvidence(responseWithJsonError("Unexpected end of JSON at byte 8127"));
  const token = await failureEvidence(responseWithJsonError("Unexpected token < in private proxy body"));
  assert.equal(truncated, token);
  assert.match(truncated, /"failureCategory": "invalid-json"/);
  assert.doesNotMatch(truncated, /Unexpected|private proxy|8127/);
});

test("HTTP, timeout, and missing metadata failures use the bounded taxonomy", async () => {
  const http = await fetchLicense("http-failure", "1.0.0", {
    fetchImpl: async () => ({ ok: false, status: 503 }),
    sleep: async () => {},
  });
  assert.deepEqual(http, {
    license: null,
    resolvedFrom: "error",
    resolutionStatus: "failed",
    failureCategory: "http-status",
    retryCount: 3,
    status: 503,
    sourceTimestamp: null,
  });

  const timeout = await fetchLicense("timeout", "1.0.0", {
    fetchImpl: async () => { throw externalError("host-specific timeout detail", "ETIMEDOUT"); },
    sleep: async () => {},
  });
  assert.equal(timeout.failureCategory, "timeout");
  assert.equal("error" in timeout, false);

  const missing = await fetchLicense("missing-time", "1.0.0", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ versions: { "1.0.0": { license: "MIT" } }, time: {} }),
    }),
    sleep: async () => {},
  });
  assert.equal(missing.failureCategory, "missing-metadata");
  assert.equal(missing.failureDetail, "source-timestamp-missing");

  const invalid = await fetchLicense("invalid-time", "1.0.0", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        versions: { "1.0.0": { license: "MIT" } },
        time: { "1.0.0": "2024-01-02" },
      }),
    }),
    sleep: async () => {},
  });
  assert.equal(invalid.failureCategory, "missing-metadata");
  assert.equal(invalid.failureDetail, "source-timestamp-invalid");

  await assert.rejects(
    buildLicenseIndex({
      lockfileText: "lockfileVersion: '9.0'\n",
      components: [
        { name: "alpha", version: "1.0.0" },
        { name: "missing-time", version: "1.0.0" },
      ],
      resolveLicense: async (name, version) => name === "alpha"
        ? structuredClone(responses.get(`${name}@${version}`))
        : structuredClone(missing),
    }),
    /missing-time@1\.0\.0: registry metadata lacks required version\/publication metadata \(source-timestamp-missing\)/
  );
});

const PROVENANCE_PATH = "docs/audits/sbom/licence-resolution.json";
const PROVENANCE_SUMMARY_PATH = "docs/audits/sbom/licence-resolution.md";
const CLOSURE_PATH = "docs/audits/sbom/closure-contract.md";
const TAG_OBSERVATION_PATH = "docs/audits/sbom/provenance/trigger-dev-v4.4.4-ref.json";
const NPM_METADATA_PATH = "docs/audits/sbom/provenance/trigger-dev-core-4.4.4.registry.json";
const NPM_TARBALL_PATH = "docs/audits/sbom/provenance/trigger-dev-core-4.4.4.tgz";
const SOURCE_TAG = "v4.4.4";
const SOURCE_COMMIT = "5ea36e08f25728ff2a75a31dfd82f4fe9c981002";
const IMPORT_COMMIT = "f5be33998fa7039884ffb7bd32274f0cb6bed6d9";
const BASELINE_COMMIT = "8ee9f5ec8ea28436134c7fca113b0412eed73a61";
const SOURCE_REPOSITORY = `https://github.com/${["trig", "gerdotdev"].join("")}/${["trig", "ger.dev"].join("")}`;
const ROOT_APACHE_BLOB = "5e468e5078530707eb8d28fe28cad2f72fb64bf0";
const INHERITED_MIT_BLOB = "e51e7b10aa6e13f878b34a8ae347c3f9feb76e4b";
const UPSTREAM_CORE_TREE = "665d3692f317b0eaa1071d80692ad0d197916d63";
const UPSTREAM_OTLP_TREE = "8d9b3e38529a09463164680b0002a95759a2009b";
const UPSTREAM_CORE_MANIFEST_BLOB = "35e60bd7c897b3bb55bbf23241ef9aaf0ed3806c";
const UPSTREAM_OTLP_MANIFEST_BLOB = "72e46c2f9d3bdb9681f144726e1c38adce711b64";
const IMPORT_OTLP_MANIFEST_BLOB = "792b00a347e431b1bf60afcc29a6d51986a1b1d4";
const NPM_TARBALL_SHA512 = "9bbe3c5bab45fde206cc46858eebe589c0aac68a79185c67b7f7926fb920d20f590b6556d2205afeb3b1e1a0909641dde0c2a7dc1fadd8b40b867fde23d9070f";
const EXPECTED_DIFFERING_PATHS = Object.freeze([
  "package.json",
  "src/v3/idempotencyKeys.ts",
  "src/v3/schemas/common.ts",
  "src/v3/schemas/runEngine.ts",
  "src/v3/serverOnly/k8s.ts",
  "src/v3/serverOnly/shutdownManager.ts",
  "src/v3/types/tasks.ts",
  "src/v3/utils/getEnv.ts",
]);
const SHIPPING_EVIDENCE_PATHS = Object.freeze([
  "docs/audits/sbom/platos-agent.cdx.json",
  "docs/audits/sbom/platos-webapp.cdx.json",
  "docs/audits/sbom/platos-webapp.image-inventory.json",
]);

function localBytes(path, overrides = new Map()) {
  const value = overrides.get(path);
  if (value !== undefined) return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return readFileSync(join(repositoryRoot, path));
}

function localText(path, overrides = new Map()) {
  return localBytes(path, overrides).toString("utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(algorithm, value, encoding = "hex") {
  return createHash(algorithm).update(value).digest(encoding);
}

function tarOutput(args) {
  return execFileSync("tar", args, {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitObjectIdentity(type, content) {
  const header = Buffer.from(`${type} ${content.length}\0`, "utf8");
  return {
    id: createHash("sha1").update(header).update(content).digest("hex"),
    type,
    sha256: sha256(content),
    size: content.length,
  };
}

function gitOutput(args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitText(args) {
  return gitOutput(args).trim();
}

function gitObjectAt(spec, type) {
  const id = gitText(["rev-parse", spec]);
  return gitObjectIdentity(type, gitOutput(["cat-file", type, id], "buffer"));
}

function parseLsTree(output) {
  const entries = [];
  let start = 0;
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue;
    const record = output.subarray(start, index);
    start = index + 1;
    const tab = record.indexOf(9);
    const [mode, type, objectId] = record.subarray(0, tab).toString("ascii").split(" ");
    entries.push({
      path: record.subarray(tab + 1).toString("utf8"),
      mode,
      type,
      objectId,
    });
  }
  return entries;
}

function gitFilesAt(commit, path) {
  return parseLsTree(gitOutput(["ls-tree", "-r", "-z", `${commit}:${path}`], "buffer")).map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    blob: entry.objectId,
  }));
}

function treeIdentityFromEntries(entries) {
  const sorted = [...entries].sort((left, right) => Buffer.compare(
    Buffer.from(`${left.path}${left.type === "tree" ? "/" : ""}`),
    Buffer.from(`${right.path}${right.type === "tree" ? "/" : ""}`),
  ));
  const content = Buffer.concat(sorted.flatMap((entry) => [
    Buffer.from(`${entry.mode.replace(/^0/u, "")} ${entry.path}\0`, "utf8"),
    Buffer.from(entry.objectId, "hex"),
  ]));
  return gitObjectIdentity("tree", content);
}

function treeIdentityFromFiles(files) {
  const root = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.directories.has(part)) node.directories.set(part, { directories: new Map(), files: [] });
      node = node.directories.get(part);
    }
    node.files.push({ path: name, mode: file.mode, type: "blob", objectId: file.blob });
  }

  function identify(node) {
    const entries = [...node.files];
    for (const [path, child] of node.directories) {
      entries.push({ path, mode: "040000", type: "tree", objectId: identify(child).id });
    }
    return treeIdentityFromEntries(entries);
  }

  return identify(root);
}

function manifestFields(value) {
  return {
    name: value.name,
    version: value.version,
    private: value.private === true,
    license: value.license,
    publishAccess: value.publishConfig?.access ?? null,
  };
}

function gitManifestFields(commit, path) {
  return manifestFields(JSON.parse(gitText(["show", `${commit}:${path}`])));
}

function exactKeys(errors, label, value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${label} fields must be exactly ${wanted.join(", ")}`);
  }
}

function equalValue(errors, label, actual, expected) {
  if (!Object.is(actual, expected)) errors.push(`${label} must equal ${JSON.stringify(expected)}`);
}

function strictReceiptSchema(receipt, errors) {
  exactKeys(errors, "receipt", receipt, ["$schema", "schemaVersion", "generatedBy", "legalDecision", "sources", "initialImport", "currentState"]);
  exactKeys(errors, "legalDecision", receipt.legalDecision, ["status", "decided", "question", "decidedOn", "decidedBy", "decision", "rationale", "appliedChanges", "otlpImporterTreatment", "noticeTextSource", "scope"]);
  exactKeys(errors, "legalDecision.noticeTextSource", receipt.legalDecision?.noticeTextSource, ["extractedFrom", "memberPath", "tarballSha1", "method"]);
  exactKeys(errors, "sources", receipt.sources, ["upstreamGit", "npm"]);
  const upstream = receipt.sources?.upstreamGit;
  exactKeys(errors, "sources.upstreamGit", upstream, ["repository", "tag", "tagRefUrl", "commit", "commitUrl", "treeUrl", "tagMapping", "rootTree", "coreTree", "otlpTree", "artifacts"]);
  exactKeys(errors, "sources.upstreamGit.tagMapping", upstream?.tagMapping, ["classification", "offlineVerified", "reviewedAt", "statement", "mappingObservationSourceUrl", "immutableCommitUrl", "snapshot"]);
  exactKeys(errors, "sources.upstreamGit.tagMapping.snapshot", upstream?.tagMapping?.snapshot, ["path", "sha256", "size", "schema"]);
  exactKeys(errors, "sources.upstreamGit.rootTree", upstream?.rootTree, ["path", "url", "object", "contentBase64"]);
  for (const key of ["coreTree", "otlpTree"]) {
    exactKeys(errors, `sources.upstreamGit.${key}`, upstream?.[key], ["path", "url", "object", "fileCount", "files"]);
  }
  for (const treeKey of ["coreTree", "otlpTree"]) {
    for (const [index, entry] of (upstream?.[treeKey]?.files ?? []).entries()) {
      exactKeys(errors, `${treeKey}.files[${index}]`, entry, ["path", "mode", "blob"]);
    }
  }

  exactKeys(errors, "upstream artifacts", upstream?.artifacts, ["rootLicense", "coreManifest", "coreLicense", "coreChangelog", "otlpManifest", "otlpLicense"]);
  for (const [key, artifact] of Object.entries(upstream?.artifacts ?? {})) {
    exactKeys(errors, `upstream artifact ${key}`, artifact, key === "coreChangelog" ? ["path", "url", "object"] : ["path", "url", "object", "fields"]);
    exactKeys(errors, `upstream artifact ${key} object`, artifact.object, ["id", "type", "sha256", "size"]);
  }

  const npm = receipt.sources?.npm;
  exactKeys(errors, "sources.npm", npm, ["package", "version", "packageVersionUrl", "registryMetadataUrl", "metadataSnapshot", "manifestFields", "tarball", "extracted"]);
  exactKeys(errors, "sources.npm.metadataSnapshot", npm?.metadataSnapshot, ["classification", "snapshotAuthenticityOfflineVerified", "path", "sha256", "size", "schema"]);
  exactKeys(errors, "sources.npm.manifestFields", npm?.manifestFields, ["name", "version", "license"]);
  exactKeys(errors, "sources.npm.tarball", npm?.tarball, ["url", "shasum", "integrity", "sha256", "size", "fileCount", "unpackedSize", "localPath", "sha512Hex"]);
  exactKeys(errors, "sources.npm.extracted", npm?.extracted, ["manifest", "license"]);
  exactKeys(errors, "sources.npm.extracted.manifest", npm?.extracted?.manifest, ["path", "gitBlob", "sha256", "size", "fields"]);
  exactKeys(errors, "sources.npm.extracted.license", npm?.extracted?.license, ["path", "gitBlob", "sha256", "size", "spdx"]);

  const imported = receipt.initialImport;
  exactKeys(errors, "initialImport", imported, ["commit", "rootTree", "coreTree", "otlpTree", "artifacts", "equality", "coreComparison", "limitation"]);
  for (const key of ["rootTree", "coreTree", "otlpTree"]) exactKeys(errors, `initialImport.${key}`, imported?.[key], ["path", "object"]);
  exactKeys(errors, "initialImport.artifacts", imported?.artifacts, ["rootLicense", "coreManifest", "coreLicense", "coreChangelog", "otlpManifest", "otlpLicense"]);
  for (const [key, artifact] of Object.entries(imported?.artifacts ?? {})) {
    const hasFields = key === "coreManifest" || key === "otlpManifest";
    exactKeys(errors, `initial import artifact ${key}`, artifact, hasFields ? ["path", "object", "fields"] : ["path", "object"]);
    exactKeys(errors, `initial import artifact ${key} object`, artifact.object, ["id", "type", "sha256", "size"]);
  }
  exactKeys(errors, "initialImport.equality", imported?.equality, ["rootLicenseBlobEqual", "coreLicenseBlobEqual", "coreChangelogBlobEqual", "otlpLicenseBlobEqual"]);
  exactKeys(errors, "initialImport.coreComparison", imported?.coreComparison, ["upstreamFileCount", "importFileCount", "commonPathCount", "identicalBlobAndModeCount", "differingCommonPathCount", "differingCommonPaths", "upstreamOnlyCount", "upstreamOnly", "importOnlyCount", "importOnly"]);
  for (const [index, entry] of (imported?.coreComparison?.differingCommonPaths ?? []).entries()) {
    exactKeys(errors, `differingCommonPaths[${index}]`, entry, ["path", "upstreamMode", "upstreamBlob", "importMode", "importBlob"]);
  }
  for (const key of ["upstreamOnly", "importOnly"]) {
    for (const [index, entry] of (imported?.coreComparison?.[key] ?? []).entries()) exactKeys(errors, `${key}[${index}]`, entry, ["path", "mode", "blob"]);
  }
  exactKeys(errors, "initialImport.limitation", imported?.limitation, ["mergeBasePreserved", "laterSourceCommitsShareRelevantCoreTree", "canonicalAnchorIsPhysicalCheckoutProof", "statement"]);

  const current = receipt.currentState;
  exactKeys(errors, "currentState", current, ["baselineCommit", "core", "otlpImporter", "shippingSbomAbsence", "stateAsOf"]);
  exactKeys(errors, "currentState.core", current?.core, ["manifest", "license", "notice"]);
  exactKeys(errors, "currentState.core.notice", current?.core?.notice, ["path", "object", "retains", "publishedInTarball"]);
  exactKeys(errors, "currentState.core.notice object", current?.core?.notice?.object, ["id", "type", "sha256", "size"]);
  exactKeys(errors, "currentState.otlpImporter", current?.otlpImporter, ["manifest", "license", "inheritedMetadata", "private"]);
  for (const [label, artifact] of [["current core manifest", current?.core?.manifest], ["current OTLP manifest", current?.otlpImporter?.manifest]]) {
    exactKeys(errors, label, artifact, ["path", "object", "fields"]);
    exactKeys(errors, `${label} object`, artifact?.object, ["id", "type", "sha256", "size"]);
  }
  for (const [label, artifact] of [["current core license", current?.core?.license], ["current OTLP license", current?.otlpImporter?.license]]) {
    // The core licence additionally records the retained upstream MIT notice
    // applied by the 2026-09-01 owner decision; the OTLP importer does not.
    exactKeys(errors, label, artifact, ["path", "object", "spdx"]);
    exactKeys(errors, `${label} object`, artifact?.object, ["id", "type", "sha256", "size"]);
  }
  for (const [index, entry] of (current?.shippingSbomAbsence ?? []).entries()) exactKeys(errors, `shippingSbomAbsence[${index}]`, entry, ["path", "sha256", "size", "packageName", "absent"]);
}

function compareLocalArtifact(errors, label, recorded, bytes) {
  const actual = gitObjectIdentity("blob", bytes);
  if (JSON.stringify(recorded?.object) !== JSON.stringify(actual)) errors.push(`${label} object hash/size must match independently read bytes`);
}

function compareGitArtifact(errors, label, recorded, commit, path) {
  const actual = gitObjectAt(`${commit}:${path}`, "blob");
  if (JSON.stringify(recorded?.object) !== JSON.stringify(actual)) errors.push(`${label} object hash/size must match local Git history`);
}

function coreComparison(upstreamFiles, importFiles) {
  const upstreamByPath = new Map(upstreamFiles.map((entry) => [entry.path, entry]));
  const importByPath = new Map(importFiles.map((entry) => [entry.path, entry]));
  const commonPaths = [...upstreamByPath.keys()].filter((path) => importByPath.has(path));
  const differingCommonPaths = commonPaths.filter((path) => {
    const upstream = upstreamByPath.get(path);
    const imported = importByPath.get(path);
    return upstream.mode !== imported.mode || upstream.blob !== imported.blob;
  }).map((path) => ({
    path,
    upstreamMode: upstreamByPath.get(path).mode,
    upstreamBlob: upstreamByPath.get(path).blob,
    importMode: importByPath.get(path).mode,
    importBlob: importByPath.get(path).blob,
  }));
  const upstreamOnly = upstreamFiles.filter((entry) => !importByPath.has(entry.path));
  const importOnly = importFiles.filter((entry) => !upstreamByPath.has(entry.path));
  return {
    upstreamFileCount: upstreamFiles.length,
    importFileCount: importFiles.length,
    commonPathCount: commonPaths.length,
    identicalBlobAndModeCount: commonPaths.length - differingCommonPaths.length,
    differingCommonPathCount: differingCommonPaths.length,
    differingCommonPaths,
    upstreamOnlyCount: upstreamOnly.length,
    upstreamOnly,
    importOnlyCount: importOnly.length,
    importOnly,
  };
}

function provenanceErrors(receipt, overrides = new Map()) {
  const errors = [];
  strictReceiptSchema(receipt, errors);

  equalValue(errors, "$schema", receipt.$schema, "platos.audit.licence-resolution/v2");
  equalValue(errors, "schemaVersion", receipt.schemaVersion, 2);
  equalValue(errors, "receipt generator", receipt.generatedBy, "WIN-252 reviewed provenance construction; local Git and vendored artifact verification: node --test scripts/audit-licenses.test.mjs");
  // 2026-09-01 owner decision. These pins previously locked the receipt in the
  // OPEN state so automation could not close the item. The item is now closed by
  // the owner, so the pins lock the DECIDED state instead — same rigour, and the
  // retained-notice invariant below is strictly additional.
  equalValue(errors, "legal status", receipt.legalDecision?.status, "DECIDED_BY_OWNER");
  equalValue(errors, "legal decision flag", receipt.legalDecision?.decided, true);
  equalValue(errors, "legal question", receipt.legalDecision?.question, "Whether the imported package-level MIT permission notice must be retained alongside current Apache-2.0 materials.");
  equalValue(errors, "legal decision date", receipt.legalDecision?.decidedOn, "2026-09-01");
  equalValue(errors, "legal notice source tarball", receipt.legalDecision?.noticeTextSource?.extractedFrom, "docs/audits/sbom/provenance/trigger-dev-core-4.4.4.tgz");
  equalValue(errors, "legal notice source member", receipt.legalDecision?.noticeTextSource?.memberPath, "package/LICENSE");
  equalValue(errors, "legal notice source sha1", receipt.legalDecision?.noticeTextSource?.tarballSha1, "9544b5ded8dd8deb2371081389961792bccfde4e");
  equalValue(errors, "legal scope", receipt.legalDecision?.scope, "This receipt records the owner's applied decision and the facts supporting it. It does not constitute legal advice.");

  const upstream = receipt.sources?.upstreamGit;
  equalValue(errors, "upstream repository", upstream?.repository, SOURCE_REPOSITORY);
  equalValue(errors, "upstream tag", upstream?.tag, SOURCE_TAG);
  equalValue(errors, "upstream commit", upstream?.commit, SOURCE_COMMIT);
  equalValue(errors, "tag mapping classification", upstream?.tagMapping?.classification, "EXTERNALLY_REVIEWED_POINT_IN_TIME_FACT");
  equalValue(errors, "tag mapping offline verification", upstream?.tagMapping?.offlineVerified, false);
  equalValue(errors, "tag mapping review date", upstream?.tagMapping?.reviewedAt, "2026-08-31");
  equalValue(errors, "tag mapping observation URL", upstream?.tagMapping?.mappingObservationSourceUrl, `${SOURCE_REPOSITORY}.git`);
  equalValue(errors, "tag mapping immutable commit URL", upstream?.tagMapping?.immutableCommitUrl, `${SOURCE_REPOSITORY}/commit/${SOURCE_COMMIT}`);
  equalValue(errors, "tag mapping statement", upstream?.tagMapping?.statement, `The ${SOURCE_TAG} to ${SOURCE_COMMIT} mapping was externally observed at review time; this repository does not independently verify the live tag mapping offline.`);
  equalValue(errors, "upstream root tree", upstream?.rootTree?.object?.id, "bfb46fce073cb70c2140ddc153e968759792441f");
  equalValue(errors, "upstream core tree", upstream?.coreTree?.object?.id, UPSTREAM_CORE_TREE);
  equalValue(errors, "upstream OTLP tree", upstream?.otlpTree?.object?.id, UPSTREAM_OTLP_TREE);
  equalValue(errors, "upstream root tree path", upstream?.rootTree?.path, "");
  equalValue(errors, "upstream core tree path", upstream?.coreTree?.path, "packages/core");
  equalValue(errors, "upstream OTLP tree path", upstream?.otlpTree?.path, "internal-packages/otlp-importer");
  for (const url of [upstream?.commitUrl, upstream?.treeUrl, upstream?.rootTree?.url, upstream?.coreTree?.url, upstream?.otlpTree?.url]) {
    if (!url?.includes(SOURCE_COMMIT)) errors.push("every immutable upstream object URL must contain the exact source commit");
  }
  equalValue(errors, "release tag URL", upstream?.tagRefUrl, `${SOURCE_REPOSITORY}/releases/tag/${SOURCE_TAG}`);
  const tagSnapshotBytes = localBytes(TAG_OBSERVATION_PATH, overrides);
  const tagSnapshotReference = upstream?.tagMapping?.snapshot;
  if (JSON.stringify(tagSnapshotReference) !== JSON.stringify({
    path: TAG_OBSERVATION_PATH,
    sha256: sha256(tagSnapshotBytes),
    size: tagSnapshotBytes.length,
    schema: "platos.external-git-ref-observation/v1",
  })) errors.push("tag mapping snapshot path/hash/size must match the exact vendored bytes");
  const tagSnapshot = JSON.parse(tagSnapshotBytes.toString("utf8"));
  exactKeys(errors, "tag observation snapshot", tagSnapshot, ["$schema", "classification", "reviewedAt", "offlineVerified", "observationMethod", "mappingObservationSourceUrl", "immutableCommitUrl", "rawOutput", "rawOutputSha256"]);
  const expectedRefOutput = `${SOURCE_COMMIT}\trefs/tags/${SOURCE_TAG}\n`;
  if (JSON.stringify(tagSnapshot) !== JSON.stringify({
    $schema: "platos.external-git-ref-observation/v1",
    classification: "EXTERNALLY_REVIEWED_POINT_IN_TIME_FACT",
    reviewedAt: "2026-08-31",
    offlineVerified: false,
    observationMethod: `git ls-remote --refs ${SOURCE_REPOSITORY}.git refs/tags/${SOURCE_TAG}`,
    mappingObservationSourceUrl: `${SOURCE_REPOSITORY}.git`,
    immutableCommitUrl: `${SOURCE_REPOSITORY}/commit/${SOURCE_COMMIT}`,
    rawOutput: expectedRefOutput,
    rawOutputSha256: sha256(Buffer.from(expectedRefOutput)),
  })) errors.push("tag observation must remain an externally reviewed point-in-time snapshot, not offline tag proof");

  const sourceObjects = upstream?.artifacts;
  const exactSourceBlobs = {
    rootLicense: ROOT_APACHE_BLOB,
    coreManifest: UPSTREAM_CORE_MANIFEST_BLOB,
    coreLicense: INHERITED_MIT_BLOB,
    coreChangelog: "78fd93088bce6adf5a76326a673065c6efa35319",
    otlpManifest: UPSTREAM_OTLP_MANIFEST_BLOB,
    otlpLicense: INHERITED_MIT_BLOB,
  };
  for (const [key, id] of Object.entries(exactSourceBlobs)) {
    equalValue(errors, `upstream ${key} blob`, sourceObjects?.[key]?.object?.id, id);
    if (!sourceObjects?.[key]?.url?.includes(SOURCE_COMMIT)) errors.push(`upstream ${key} URL must be commit-pinned`);
  }
  const sourceArtifactPaths = {
    rootLicense: "LICENSE",
    coreManifest: "packages/core/package.json",
    coreLicense: "packages/core/LICENSE",
    coreChangelog: "packages/core/CHANGELOG.md",
    otlpManifest: "internal-packages/otlp-importer/package.json",
    otlpLicense: "internal-packages/otlp-importer/LICENSE",
  };
  for (const [key, path] of Object.entries(sourceArtifactPaths)) {
    equalValue(errors, `upstream ${key} path`, sourceObjects?.[key]?.path, path);
    equalValue(errors, `upstream ${key} URL`, sourceObjects?.[key]?.url, `${SOURCE_REPOSITORY}/blob/${SOURCE_COMMIT}/${path}`);
  }
  const expectedCoreFields = { name: "@trigger.dev/core", version: "4.4.4", private: false, license: "MIT", publishAccess: "public" };
  const expectedOtlpFields = { name: "@trigger.dev/otlp-importer", version: "3.0.0", private: true, license: "MIT", publishAccess: null };
  if (JSON.stringify(sourceObjects?.coreManifest?.fields) !== JSON.stringify(expectedCoreFields)) errors.push("upstream core manifest fields must remain exact");
  if (JSON.stringify(sourceObjects?.otlpManifest?.fields) !== JSON.stringify(expectedOtlpFields)) errors.push("upstream OTLP manifest fields must remain exact");
  if (JSON.stringify(sourceObjects?.rootLicense?.fields) !== JSON.stringify({ spdx: "Apache-2.0" })) errors.push("upstream root licence fields must remain exact");
  for (const key of ["coreLicense", "otlpLicense"]) {
    if (JSON.stringify(sourceObjects?.[key]?.fields) !== JSON.stringify({ spdx: "MIT" })) errors.push(`upstream ${key} fields must remain exact`);
  }

  for (const [tree, builder, label] of [
    [upstream?.rootTree, (value) => gitObjectIdentity("tree", Buffer.from(value.contentBase64, "base64")), "upstream root tree"],
    [upstream?.coreTree, (value) => treeIdentityFromFiles(value.files), "upstream core tree"],
    [upstream?.otlpTree, (value) => treeIdentityFromFiles(value.files), "upstream OTLP tree"],
  ]) {
    if (tree && JSON.stringify(tree.object) !== JSON.stringify(builder(tree))) errors.push(`${label} object must be reproducible from its offline tree manifest`);
    if (tree?.fileCount !== undefined && tree.fileCount !== tree.files.length) errors.push(`${label} fileCount must match files`);
  }

  const imported = receipt.initialImport;
  equalValue(errors, "initial import commit", imported?.commit, IMPORT_COMMIT);
  const importTreePaths = { rootTree: "", coreTree: "packages/core", otlpTree: "internal-packages/otlp-importer" };
  for (const [key, path] of Object.entries(importTreePaths)) {
    equalValue(errors, `initial import ${key} path`, imported?.[key]?.path, path);
    const actual = gitObjectAt(path ? `${IMPORT_COMMIT}:${path}` : `${IMPORT_COMMIT}^{tree}`, "tree");
    if (JSON.stringify(imported?.[key]?.object) !== JSON.stringify(actual)) errors.push(`initial import ${key} must match local Git history`);
  }
  const importArtifactPaths = {
    rootLicense: "LICENSE",
    coreManifest: "packages/core/package.json",
    coreLicense: "packages/core/LICENSE",
    coreChangelog: "packages/core/CHANGELOG.md",
    otlpManifest: "internal-packages/otlp-importer/package.json",
    otlpLicense: "internal-packages/otlp-importer/LICENSE",
  };
  for (const [key, path] of Object.entries(importArtifactPaths)) {
    equalValue(errors, `initial import ${key} path`, imported?.artifacts?.[key]?.path, path);
    compareGitArtifact(errors, `initial import ${key}`, imported?.artifacts?.[key], IMPORT_COMMIT, path);
  }
  if (JSON.stringify(imported?.artifacts?.coreManifest?.fields) !== JSON.stringify(gitManifestFields(IMPORT_COMMIT, importArtifactPaths.coreManifest))) errors.push("initial import core manifest fields must match local Git history");
  if (JSON.stringify(imported?.artifacts?.otlpManifest?.fields) !== JSON.stringify(gitManifestFields(IMPORT_COMMIT, importArtifactPaths.otlpManifest))) errors.push("initial import OTLP manifest fields must match local Git history");

  const expectedEquality = {
    rootLicenseBlobEqual: imported?.artifacts?.rootLicense?.object?.id === sourceObjects?.rootLicense?.object?.id,
    coreLicenseBlobEqual: imported?.artifacts?.coreLicense?.object?.id === sourceObjects?.coreLicense?.object?.id,
    coreChangelogBlobEqual: imported?.artifacts?.coreChangelog?.object?.id === sourceObjects?.coreChangelog?.object?.id,
    otlpLicenseBlobEqual: imported?.artifacts?.otlpLicense?.object?.id === sourceObjects?.otlpLicense?.object?.id,
  };
  if (JSON.stringify(imported?.equality) !== JSON.stringify(expectedEquality) || Object.values(expectedEquality).includes(false)) errors.push("initial import equality claims must remain true and object-derived");

  const importCoreFiles = gitFilesAt(IMPORT_COMMIT, "packages/core");
  const expectedComparison = coreComparison(upstream?.coreTree?.files ?? [], importCoreFiles);
  if (JSON.stringify(imported?.coreComparison) !== JSON.stringify(expectedComparison)) errors.push("250/258 core comparison must be independently recomputed from Git import and upstream manifest");
  if (JSON.stringify(expectedComparison.differingCommonPaths.map((entry) => entry.path)) !== JSON.stringify(EXPECTED_DIFFERING_PATHS)) errors.push("the exact eight differing paths must remain fixed");
  equalValue(errors, "upstream core file count", expectedComparison.upstreamFileCount, 259);
  equalValue(errors, "import core file count", expectedComparison.importFileCount, 258);
  equalValue(errors, "common core path count", expectedComparison.commonPathCount, 258);
  equalValue(errors, "identical core blob/mode count", expectedComparison.identicalBlobAndModeCount, 250);
  if (JSON.stringify(expectedComparison.upstreamOnly.map((entry) => entry.path)) !== JSON.stringify(["CLAUDE.md"])) errors.push("CLAUDE.md must remain the sole upstream-only core path");
  equalValue(errors, "preserved merge base", imported?.limitation?.mergeBasePreserved, false);
  equalValue(errors, "later shared core tree observation", imported?.limitation?.laterSourceCommitsShareRelevantCoreTree, true);
  equalValue(errors, "physical checkout proof", imported?.limitation?.canonicalAnchorIsPhysicalCheckoutProof, false);
  equalValue(errors, "anchor limitation statement", imported?.limitation?.statement, "Later source commits share the relevant core tree, no merge base is preserved, and the physical checkout used for the import is unproven.");

  const importedRootLicense = gitOutput(["show", `${IMPORT_COMMIT}:LICENSE`], "buffer");
  const importedCoreLicense = gitOutput(["show", `${IMPORT_COMMIT}:packages/core/LICENSE`], "buffer");
  const importedChangelog = gitOutput(["show", `${IMPORT_COMMIT}:packages/core/CHANGELOG.md`], "buffer");
  const importedOtlpLicense = gitOutput(["show", `${IMPORT_COMMIT}:internal-packages/otlp-importer/LICENSE`], "buffer");
  for (const [label, recorded, bytes] of [
    ["upstream root licence", sourceObjects?.rootLicense, importedRootLicense],
    ["upstream core licence", sourceObjects?.coreLicense, importedCoreLicense],
    ["upstream core changelog", sourceObjects?.coreChangelog, importedChangelog],
    ["upstream OTLP licence", sourceObjects?.otlpLicense, importedOtlpLicense],
  ]) compareLocalArtifact(errors, label, recorded, bytes);
  const importedOtlpManifest = gitOutput(["show", `${IMPORT_COMMIT}:internal-packages/otlp-importer/package.json`], "buffer");
  const reconstructedUpstreamOtlp = Buffer.from(importedOtlpManifest.toString("utf8").replace("@platos/otlp-importer", "@trigger.dev/otlp-importer"));
  compareLocalArtifact(errors, "upstream OTLP manifest", sourceObjects?.otlpManifest, reconstructedUpstreamOtlp);

  const sourceAvailable = spawnSync("git", ["cat-file", "-e", `${SOURCE_COMMIT}^{commit}`], { cwd: repositoryRoot }).status === 0;
  if (sourceAvailable) {
    const actualRootTree = gitOutput(["cat-file", "tree", upstream.rootTree.object.id], "buffer");
    const actualCoreFiles = gitFilesAt(SOURCE_COMMIT, "packages/core");
    const actualOtlpFiles = gitFilesAt(SOURCE_COMMIT, "internal-packages/otlp-importer");
    if (!Buffer.from(upstream?.rootTree?.contentBase64 ?? "", "base64").equals(actualRootTree)) errors.push("upstream root tree bytes must match the locally available source object");
    if (JSON.stringify(upstream?.coreTree?.files) !== JSON.stringify(actualCoreFiles)) errors.push("upstream core tree manifest must match the locally available source object");
    if (JSON.stringify(upstream?.otlpTree?.files) !== JSON.stringify(actualOtlpFiles)) errors.push("upstream OTLP tree manifest must match the locally available source object");
    for (const [key, path] of Object.entries(importArtifactPaths)) compareGitArtifact(errors, `upstream ${key}`, sourceObjects?.[key], SOURCE_COMMIT, path);
    const mergeBase = spawnSync("git", ["merge-base", SOURCE_COMMIT, IMPORT_COMMIT], { cwd: repositoryRoot, encoding: "utf8" });
    if (mergeBase.status === 0 || mergeBase.stdout.trim()) errors.push("source and import must retain the recorded no-merge-base limitation");
  }

  const npm = receipt.sources?.npm;
  const metadataSnapshotBytes = localBytes(NPM_METADATA_PATH, overrides);
  const metadataSnapshotReference = {
    classification: "EXTERNALLY_REVIEWED_POINT_IN_TIME_FACT",
    snapshotAuthenticityOfflineVerified: false,
    path: NPM_METADATA_PATH,
    sha256: sha256(metadataSnapshotBytes),
    size: metadataSnapshotBytes.length,
    schema: "platos.external-registry-version-snapshot/v1",
  };
  const expectedRegistryMetadata = {
    $schema: "platos.external-registry-version-snapshot/v1",
    classification: "EXTERNALLY_REVIEWED_POINT_IN_TIME_FACT",
    reviewedAt: "2026-08-31",
    sourceUrl: "https://registry.npmjs.org/@trigger.dev%2fcore/4.4.4",
    snapshotAuthenticityOfflineVerified: false,
    metadata: {
      name: "@trigger.dev/core",
      version: "4.4.4",
      license: "MIT",
      repository: {
        url: "git+https://github.com/triggerdotdev/trigger.dev.git",
        type: "git",
        directory: "packages/core",
      },
      dist: {
        shasum: "9544b5ded8dd8deb2371081389961792bccfde4e",
        integrity: "sha512-m748W6tF/eIGzEaFjuvlicCqxop5GFxnt/eSb7kg0g9ZC2VW0iBa/rOx4aCQlkHd4MKn3B+t2LQLhn/eI9kHDw==",
        tarball: "https://registry.npmjs.org/@trigger.dev/core/-/core-4.4.4.tgz",
        fileCount: 1440,
        unpackedSize: 10406874,
      },
    },
  };
  const registryMetadata = JSON.parse(metadataSnapshotBytes.toString("utf8"));
  exactKeys(errors, "registry metadata snapshot", registryMetadata, ["$schema", "classification", "reviewedAt", "sourceUrl", "snapshotAuthenticityOfflineVerified", "metadata"]);
  if (JSON.stringify(registryMetadata) !== JSON.stringify(expectedRegistryMetadata)) errors.push("bounded registry metadata snapshot must remain exact and externally classified");

  const tarballBytes = localBytes(NPM_TARBALL_PATH, overrides);
  const tarballSha512Base64 = digest("sha512", tarballBytes, "base64");
  const tarballFacts = {
    url: "https://registry.npmjs.org/@trigger.dev/core/-/core-4.4.4.tgz",
    shasum: digest("sha1", tarballBytes),
    integrity: `sha512-${tarballSha512Base64}`,
    sha256: sha256(tarballBytes),
    size: tarballBytes.length,
    fileCount: tarOutput(["-tzf", NPM_TARBALL_PATH]).toString("utf8").trimEnd().split("\n").length,
    unpackedSize: 10406874,
    localPath: NPM_TARBALL_PATH,
    sha512Hex: digest("sha512", tarballBytes),
  };
  const extractedManifestBytes = tarOutput(["-xOzf", NPM_TARBALL_PATH, "package/package.json"]);
  const extractedLicenseBytes = tarOutput(["-xOzf", NPM_TARBALL_PATH, "package/LICENSE"]);
  const extractedManifest = JSON.parse(extractedManifestBytes.toString("utf8"));
  if (JSON.stringify({
    name: extractedManifest.name,
    version: extractedManifest.version,
    license: extractedManifest.license,
    repository: extractedManifest.repository,
  }) !== JSON.stringify({
    name: "@trigger.dev/core",
    version: "4.4.4",
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/triggerdotdev/trigger.dev",
      directory: "packages/core",
    },
  })) errors.push("vendored npm manifest name/version/licence/repository must be extracted and exact");
  if (!extractedLicenseBytes.equals(importedCoreLicense) || gitObjectIdentity("blob", extractedLicenseBytes).id !== INHERITED_MIT_BLOB) errors.push("vendored npm package/LICENSE must equal the exact inherited MIT bytes");

  const expectedNpm = {
    package: "@trigger.dev/core",
    version: "4.4.4",
    packageVersionUrl: "https://www.npmjs.com/package/@trigger.dev/core/v/4.4.4",
    registryMetadataUrl: "https://registry.npmjs.org/@trigger.dev%2fcore/4.4.4",
    metadataSnapshot: metadataSnapshotReference,
    manifestFields: { name: "@trigger.dev/core", version: "4.4.4", license: "MIT" },
    tarball: tarballFacts,
    extracted: {
      manifest: {
        path: "package/package.json",
        gitBlob: "56b200edb9dd877a0c96a9627c8bd0392e6d5287",
        sha256: "3f3bb585b1d01e4914961abab7ff4ab9f67e2bf295798e62a234a943e03ae7eb",
        size: 18856,
        fields: expectedCoreFields,
      },
      license: {
        path: "package/LICENSE",
        gitBlob: INHERITED_MIT_BLOB,
        sha256: "08ba90c393a607a7dc83a3dbf6db16a31617925f27b378cd6f959640c3bfa59f",
        size: 1068,
        spdx: "MIT",
      },
    },
  };
  if (JSON.stringify(npm) !== JSON.stringify(expectedNpm)) errors.push("npm @trigger.dev/core@4.4.4 metadata, tarball, and extracted evidence must remain exact");
  equalValue(errors, "vendored npm tarball size", tarballFacts.size, 873352);
  equalValue(errors, "vendored npm tarball SHA-1", tarballFacts.shasum, "9544b5ded8dd8deb2371081389961792bccfde4e");
  equalValue(errors, "vendored npm tarball SHA-512", tarballFacts.sha512Hex, NPM_TARBALL_SHA512);
  equalValue(errors, "vendored npm tarball integrity", tarballFacts.integrity, "sha512-m748W6tF/eIGzEaFjuvlicCqxop5GFxnt/eSb7kg0g9ZC2VW0iBa/rOx4aCQlkHd4MKn3B+t2LQLhn/eI9kHDw==");
  equalValue(errors, "vendored npm tarball file count", tarballFacts.fileCount, 1440);
  const extractedManifestObject = gitObjectIdentity("blob", extractedManifestBytes);
  if (npm?.extracted?.manifest?.gitBlob !== extractedManifestObject.id || npm?.extracted?.manifest?.sha256 !== extractedManifestObject.sha256 || npm?.extracted?.manifest?.size !== extractedManifestObject.size) errors.push("npm extracted manifest hashes must be recomputed from the vendored tarball");
  const npmLicenseObject = gitObjectIdentity("blob", importedCoreLicense);
  if (npm?.extracted?.license?.gitBlob !== npmLicenseObject.id || npm?.extracted?.license?.sha256 !== npmLicenseObject.sha256 || npm?.extracted?.license?.size !== npmLicenseObject.size) errors.push("npm extracted MIT licence must match independently available inherited bytes");

  const current = receipt.currentState;
  equalValue(errors, "current baseline", current?.baselineCommit, BASELINE_COMMIT);
  const currentArtifacts = [
    ["current core manifest", current?.core?.manifest, "packages/core/package.json"],
    ["current core licence", current?.core?.license, "packages/core/LICENSE"],
    ["current OTLP manifest", current?.otlpImporter?.manifest, "internal-packages/otlp-importer/package.json"],
    ["current OTLP licence", current?.otlpImporter?.license, "internal-packages/otlp-importer/LICENSE"],
  ];
  for (const [label, artifact, path] of currentArtifacts) {
    equalValue(errors, `${label} path`, artifact?.path, path);
    compareLocalArtifact(errors, label, artifact, localBytes(path, overrides));
  }
  const currentCoreFields = manifestFields(JSON.parse(localText("packages/core/package.json", overrides)));
  const currentOtlpFields = manifestFields(JSON.parse(localText("internal-packages/otlp-importer/package.json", overrides)));
  if (JSON.stringify(current?.core?.manifest?.fields) !== JSON.stringify(currentCoreFields) || JSON.stringify(currentCoreFields) !== JSON.stringify({ name: "@platos/core", version: "4.4.4", private: false, license: "Apache-2.0", publishAccess: "public" })) errors.push("current public core package state must remain exact");
  if (JSON.stringify(current?.otlpImporter?.manifest?.fields) !== JSON.stringify(currentOtlpFields) || JSON.stringify(currentOtlpFields) !== JSON.stringify({ name: "@platos/otlp-importer", version: "3.0.0", private: true, license: "MIT", publishAccess: null })) errors.push("current private OTLP package state must remain exact");
  equalValue(errors, "current core licence blob", current?.core?.license?.object?.id, ROOT_APACHE_BLOB);
  equalValue(errors, "current core licence SPDX", current?.core?.license?.spdx, "Apache-2.0");

  // Retained-attribution invariant (2026-09-01 owner decision). The upstream MIT
  // notice must remain present, verbatim, in packages/core/NOTICE -- the
  // Apache-2.0 s4(d) mechanism -- and NOT in LICENSE, which must stay byte-equal
  // to the repository Apache-2.0 text (enforced by license-distribution). This
  // replaces the previous "keep the legal item open" guard with a stronger one:
  // the obligation itself is now mechanically protected against silent removal.
  const coreNoticeText = localText("packages/core/NOTICE", overrides);
  for (const required of [
    "UPSTREAM ATTRIBUTION",
    "MIT License",
    "Copyright (c) 2023 Trigger.dev",
    "The above copyright notice and this permission notice shall be included in all",
    "does not alter the Apache-2.0 grant",
  ]) {
    if (!coreNoticeText.includes(required)) {
      errors.push(`packages/core/NOTICE must retain the upstream attribution: ${required}`);
    }
  }
  // The notice is worthless if it is not published with the package.
  const coreManifest = JSON.parse(localText("packages/core/package.json", overrides));
  if (!(coreManifest.files ?? []).includes("NOTICE")) {
    errors.push("packages/core/package.json must ship NOTICE in the published tarball");
  }
  equalValue(errors, "current OTLP manifest blob", current?.otlpImporter?.manifest?.object?.id, IMPORT_OTLP_MANIFEST_BLOB);
  equalValue(errors, "current OTLP licence blob", current?.otlpImporter?.license?.object?.id, INHERITED_MIT_BLOB);
  equalValue(errors, "current OTLP licence SPDX", current?.otlpImporter?.license?.spdx, "MIT");
  equalValue(errors, "current OTLP inherited metadata", current?.otlpImporter?.inheritedMetadata, true);
  equalValue(errors, "current OTLP private state", current?.otlpImporter?.private, true);

  const expectedShipping = SHIPPING_EVIDENCE_PATHS.map((path) => {
    const bytes = localBytes(path, overrides);
    return { path, sha256: sha256(bytes), size: bytes.length, packageName: "@platos/otlp-importer", absent: !bytes.includes(Buffer.from("otlp-importer")) };
  });
  if (JSON.stringify(current?.shippingSbomAbsence) !== JSON.stringify(expectedShipping) || expectedShipping.some((entry) => !entry.absent)) errors.push("shipping-SBOM absence must be independently recomputed from exact current evidence");

  const notice = localText("NOTICE", overrides);
  const summary = localText(PROVENANCE_SUMMARY_PATH, overrides);
  const closure = localText(CLOSURE_PATH, overrides);
  for (const [label, source] of [["NOTICE", notice], ["provenance summary", summary], ["closure contract", closure]]) {
    if (!source.includes("licence-resolution.json")) errors.push(`${label} must link the canonical provenance receipt`);
  }
  for (const path of [TAG_OBSERVATION_PATH, NPM_METADATA_PATH, NPM_TARBALL_PATH]) {
    const relative = `./${path.replace("docs/audits/sbom/", "")}`;
    if (!summary.includes(relative)) errors.push(`provenance summary must link vendored artifact ${relative}`);
  }
  if (/@platos\/\*/u.test(notice)) errors.push("NOTICE must not apply an Apache wildcard to inherited @platos package metadata");
  for (const required of [
    "Platos-authored additions",
    "Current package-level\nmetadata and package-license state",
    "Those statements explicitly exclude inherited package metadata.",
    "they do not classify the private @platos/otlp-importer's inherited MIT manifest",
    "follows the\nresolved human/legal decision recorded above",
  ]) {
    if (!notice.includes(required)) errors.push(`NOTICE is missing scoped legal boundary: ${required}`);
  }
  if (!closure.includes("HUMAN/LEGAL DECISION RESOLVED") || !closure.includes("**LEGAL GATE**") || !closure.includes("non-shipping closure fact")) errors.push("closure contract must retain the concise resolved gate and non-shipping OTLP summary");
  if (!summary.includes("DECIDED BY OWNER — 2026-09-01")) errors.push("human summary must retain the exact decided legal status");
  for (const source of [notice, summary, closure]) {
    if (!/externally\s+reviewed point-in-time fact/u.test(source)) errors.push("NOTICE and provenance docs must classify the tag mapping as an externally reviewed point-in-time fact");
  }
  const receiptSource = JSON.stringify(receipt);
  for (const source of [notice, summary, closure, receiptSource]) {
    if (/(@platos\/core|imported core).{0,100}\belections?\b|\belections?\b.{0,100}(@platos\/core|imported core)/isu.test(source)) {
      errors.push("imported/current core state must not be described as a legal election");
    }
  }
  for (const unsupported of ["candidateCommitCount", "28 source commits", "28-candidate"]) {
    if ([receiptSource, summary, closure, notice].some((source) => source.includes(unsupported))) errors.push(`unsupported source-candidate claim remains: ${unsupported}`);
  }
  for (const claim of [/tag mapping is offline verified/iu, /offline verification proves the tag/iu, /independently verifies the live tag mapping offline/iu]) {
    if ([receiptSource, summary, closure, notice].some((source) => claim.test(source))) errors.push(`false offline tag verification claim remains: ${claim.source}`);
  }

  const falseClaims = [
    "that was an error and Apache-2.0 governs",
    "simply factually wrong",
    "No human legal call is required",
    "per-package `MIT` residue",
    "rename residue that contradicts the Apache-2.0 repo licence",
  ];
  for (const source of [notice, summary, closure]) {
    for (const claim of falseClaims) if (source.includes(claim)) errors.push(`false legal assertion remains: ${claim}`);
  }

  const packageDocument = JSON.parse(localText("package.json", overrides));
  if (packageDocument.scripts?.["test:licenses"] !== "node --test scripts/audit-licenses.test.mjs") errors.push("test:licenses must retain its existing consolidated command");
  if (!localText(".github/workflows/ci.yml", overrides).includes("pnpm test:licenses")) errors.push("external CI must continue invoking test:licenses");
  if (existsSync(join(repositoryRoot, "scripts/audit-licenses.provenance.test.mjs"))) errors.push("the standalone provenance test must remain removed");
  return errors;
}

function mutateReceipt(receipt, mutation) {
  const copy = structuredClone(receipt);
  const before = JSON.stringify(copy);
  mutation(copy);
  assert.notEqual(JSON.stringify(copy), before, "mutation control must not be a no-op");
  return copy;
}

test("WIN-252 receipt strictly validates offline Git, import, npm, current package, and shipping evidence", () => {
  const receipt = JSON.parse(localText(PROVENANCE_PATH));
  assert.deepEqual(provenanceErrors(receipt), []);
});

test("WIN-252 receipt and legal-boundary mutations fail closed and mutation no-ops are rejected", () => {
  const receipt = JSON.parse(localText(PROVENANCE_PATH));
  const mutations = [
    (value) => { value.schemaVersion = 3; },
    (value) => { value.unexpected = true; },
    (value) => { value.legalDecision.status = "CLOSED"; },
    (value) => { value.legalDecision.scope = "The imported core Apache-2.0 election is final."; },
    (value) => { value.sources.upstreamGit.commit = "0".repeat(40); },
    (value) => { value.sources.upstreamGit.tagMapping.offlineVerified = true; },
    (value) => { value.sources.upstreamGit.rootTree.contentBase64 = `${value.sources.upstreamGit.rootTree.contentBase64.startsWith("A") ? "B" : "A"}${value.sources.upstreamGit.rootTree.contentBase64.slice(1)}`; },
    (value) => { value.sources.upstreamGit.coreTree.files[0].blob = "0".repeat(40); },
    (value) => { value.sources.upstreamGit.artifacts.coreManifest.object.id = "0".repeat(40); },
    (value) => { value.sources.npm.metadataSnapshot.snapshotAuthenticityOfflineVerified = true; },
    (value) => { value.sources.npm.tarball.integrity = "sha512-mutated"; },
    (value) => { value.initialImport.coreComparison.identicalBlobAndModeCount = 251; },
    (value) => { value.initialImport.limitation.candidateCommitCountSharingRelevantCoreTree = 28; },
    (value) => { value.currentState.core.manifest.fields.license = "MIT"; },
    (value) => { value.currentState.shippingSbomAbsence[0].absent = false; },
  ];
  for (const mutation of mutations) {
    const changed = mutateReceipt(receipt, mutation);
    assert.notDeepEqual(provenanceErrors(changed), [], "receipt mutation must fail closed");
  }
  assert.throws(() => mutateReceipt(receipt, () => {}), /must not be a no-op/);

  const fileMutations = [
    ["packages/core/package.json", (source) => source.replace('"license": "Apache-2.0"', '"license": "MIT"'), "current public core"],
    ["internal-packages/otlp-importer/package.json", (source) => source.replace('"private": true', '"private": false'), "current private OTLP"],
    ["internal-packages/otlp-importer/LICENSE", (source) => `${source}\nmutated\n`, "current OTLP licence"],
    ["NOTICE", (source) => `${source}\nPlatos additions (the @platos/* packages) are distributed under Apache-2.0.\n`, "Apache wildcard"],
    ["NOTICE", (source) => `${source}\nThe imported core Apache-2.0 election is final.\n`, "legal election"],
    ["NOTICE", (source) => `${source}\nthat was an error and Apache-2.0 governs.\n`, "false legal assertion"],
    [PROVENANCE_SUMMARY_PATH, (source) => source.replaceAll("licence-resolution.json", "missing-receipt.json"), "must link"],
    [PROVENANCE_SUMMARY_PATH, (source) => `${source}\nThe tag mapping is offline verified.\n`, "offline tag verification"],
    [PROVENANCE_SUMMARY_PATH, (source) => `${source}\n28 source commits share the tree.\n`, "source-candidate"],
    [TAG_OBSERVATION_PATH, (source) => source.replace("EXTERNALLY_REVIEWED_POINT_IN_TIME_FACT", "OFFLINE_VERIFIED"), "tag observation"],
    [NPM_METADATA_PATH, (source) => source.replace("EXTERNALLY_REVIEWED_POINT_IN_TIME_FACT", "OFFLINE_VERIFIED"), "registry metadata"],
    [CLOSURE_PATH, (source) => `${source}\nNo human legal call is required.\n`, "false legal assertion"],
    [SHIPPING_EVIDENCE_PATHS[0], (source) => `${source}\notlp-importer\n`, "shipping-SBOM absence"],
  ];
  for (const [path, mutate, expected] of fileMutations) {
    const source = localText(path);
    const changed = mutate(source);
    assert.notEqual(changed, source, `${path} mutation control must not be a no-op`);
    const errors = provenanceErrors(receipt, new Map([[path, changed]]));
    assert.ok(errors.some((error) => error.includes(expected)), `${path} mutation must fail with ${expected}: ${errors.join("; ")}`);
  }

  const corruptedTarball = Buffer.from(localBytes(NPM_TARBALL_PATH));
  corruptedTarball[corruptedTarball.length - 1] ^= 1;
  const tarballErrors = provenanceErrors(receipt, new Map([[NPM_TARBALL_PATH, corruptedTarball]]));
  assert.ok(tarballErrors.some((error) => error.includes("npm @trigger.dev/core@4.4.4")), "vendored tarball byte mutation must fail exact digest evidence");
});
