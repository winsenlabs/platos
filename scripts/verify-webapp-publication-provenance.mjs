#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEBAPP_INVENTORY_EVIDENCE_SCHEMA,
  WEBAPP_TARGET_PLATFORM,
  assertDistinctStageImageIds,
  buildInputReceipts,
  buildInputsSha256,
} from "./lib/webapp-inventory-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requireEqual(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(`${description} is invalid`);
  }
}

const candidateIdentitiesPath = flag("--candidate-identities");
const inventoryRoot = flag("--inventory-root");
if (!candidateIdentitiesPath || !inventoryRoot) {
  console.error(
    "usage: node scripts/verify-webapp-publication-provenance.mjs " +
      "--candidate-identities <candidate-images.json> --inventory-root <directory>",
  );
  process.exit(1);
}

const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const hexSha256Pattern = /^[a-f0-9]{64}$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;
const candidateSha = requiredEnvironment("PLATOS_CANDIDATE_SHA", /^[a-f0-9]{40}$/u);
const agentImage = requiredEnvironment("WIN235_AGENT_IMAGE", /@sha256:[a-f0-9]{64}$/u);
const webappImage = requiredEnvironment("WIN235_WEBAPP_IMAGE", /@sha256:[a-f0-9]{64}$/u);
const migrationsImage = requiredEnvironment("WIN235_MIGRATIONS_IMAGE", /@sha256:[a-f0-9]{64}$/u);
const archiveSha256 = requiredEnvironment("WIN235_WEBAPP_ARCHIVE_SHA256", hexSha256Pattern);
const sourceRunId = requiredEnvironment("SOURCE_RUN_ID", positiveIntegerPattern);
const sourceRunAttempt = requiredEnvironment("SOURCE_RUN_ATTEMPT", positiveIntegerPattern);

const tested = readJson(path.resolve(candidateIdentitiesPath));
const expectedIdentities = {
  commitSha: candidateSha,
  agent: agentImage,
  webapp: webappImage,
  migrations: migrationsImage,
};
requireEqual(
  JSON.stringify(tested),
  JSON.stringify(expectedIdentities),
  "publication source-run candidate identities",
);

const manifestDigest = webappImage.slice(webappImage.lastIndexOf("@") + 1);
if (!sha256Pattern.test(manifestDigest)) {
  throw new Error("WIN235_WEBAPP_IMAGE manifest digest is invalid");
}
const digestKey = manifestDigest.slice("sha256:".length);
const evidenceRoot = path.resolve(inventoryRoot, digestKey);
const production = readJson(path.join(evidenceRoot, "production-deps.json"));
const final = readJson(path.join(evidenceRoot, "final.json"));
const currentBuildInputsSha256 = buildInputsSha256(buildInputReceipts(ROOT));

for (const [stage, evidence] of [["production-deps", production], ["final", final]]) {
  requireEqual(evidence.$schema, WEBAPP_INVENTORY_EVIDENCE_SCHEMA, `${stage} evidence schema`);
  requireEqual(evidence.stage, stage, `${stage} evidence stage`);
  requireEqual(evidence.sourceRunId, sourceRunId, `${stage} evidence source run ID`);
  requireEqual(evidence.sourceRunAttempt, sourceRunAttempt, `${stage} evidence source run attempt`);
  requireEqual(evidence.candidateManifestDigest, manifestDigest, `${stage} candidate manifest digest`);
  requireEqual(evidence.candidateArchiveSha256, archiveSha256, `${stage} candidate archive checksum`);
  requireEqual(evidence.platform, WEBAPP_TARGET_PLATFORM, `${stage} target platform`);
  requireEqual(evidence.gitHead, candidateSha, `${stage} Git revision`);
  requireEqual(evidence.imageRevisionLabel, candidateSha, `${stage} image revision label`);
  requireEqual(evidence.imageBuildInputsLabel, currentBuildInputsSha256, `${stage} image build-input label`);
  requireEqual(evidence.buildInputsSha256, currentBuildInputsSha256, `${stage} evidence build-input hash`);
  requireEqual(evidence.inventoryByteMatch, true, `${stage} inventory byte comparison`);
  requireEqual(
    evidence.generatedInventorySha256,
    evidence.committedInventorySha256,
    `${stage} inventory hashes`,
  );
}
assertDistinctStageImageIds(production, final);

console.log(
  `verified webapp publication provenance for ${manifestDigest} from source run ` +
    `${sourceRunId}/${sourceRunAttempt}`,
);
