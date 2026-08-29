#!/usr/bin/env node
// WIN-293 clause 4 — operator helper: mint an Ed25519 workload-identity keypair
// and print the env wiring for a rollout or a rotation.
//
// PRIVATE KEY HANDLING: the private key is printed ONCE to stdout for the
// operator to place in the signer's secret store. It is never written to a file
// in the repo, never committed, and never logged by the running services.
//
// Usage:
//   node scripts/workload-identity-keygen.mjs webapp wa_2026_09
//   node scripts/workload-identity-keygen.mjs worker wk_2026_09
//   node scripts/workload-identity-keygen.mjs webapp wa_2026_10 --merge '<existing keyset json>'
//
// Rotation (zero-downtime):
//   1. Generate a NEW kid and --merge it into the agent's PLATOS_WORKLOAD_KEYSET
//      so BOTH the old and new kid verify. Deploy the agent first.
//   2. Switch the signer to the new private key + kid. Deploy the signer.
//   3. After the overlap window (> max token TTL), drop the old kid from the
//      keyset and redeploy the agent. The old key is now revoked.
import { generateKeyPairSync } from "node:crypto";

const IDENTITIES = {
  webapp: { iss: "platos-webapp", sub: "spiffe://platos/webapp" },
  worker: { iss: "platos-worker", sub: "spiffe://platos/worker" },
};

const [, , workload, kid, ...rest] = process.argv;

if (!workload || !kid || !IDENTITIES[workload]) {
  console.error("usage: node scripts/workload-identity-keygen.mjs <webapp|worker> <kid> [--merge '<keyset json>']");
  process.exit(2);
}
if (!/^[A-Za-z0-9_.-]{3,64}$/.test(kid)) {
  console.error("kid must be 3-64 chars of [A-Za-z0-9_.-]");
  process.exit(2);
}

const mergeIdx = rest.indexOf("--merge");
let keyset = {};
if (mergeIdx !== -1) {
  const raw = rest[mergeIdx + 1];
  if (!raw) {
    console.error("--merge requires the existing keyset JSON");
    process.exit(2);
  }
  try {
    keyset = JSON.parse(raw);
  } catch {
    console.error("--merge value is not valid JSON");
    process.exit(2);
  }
  if (keyset[kid]) {
    console.error(`refusing to overwrite existing kid "${kid}" — choose a new kid for rotation`);
    process.exit(2);
  }
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const identity = IDENTITIES[workload];

keyset[kid] = { pub: publicKeyPem, iss: identity.iss, sub: identity.sub };

console.log(`# Workload identity: ${workload} (${identity.sub}), kid=${kid}`);
console.log("#");
console.log("# 1) SIGNER env (webapp server env / Trigger Cloud env) — SECRET, never commit:");
console.log(`PLATOS_WORKLOAD_KEY_ID=${kid}`);
console.log(`PLATOS_WORKLOAD_PRIVATE_KEY='${privateKeyPem.trim()}'`);
console.log("#");
console.log("# 2) VERIFIER env (agent) — public material, safe to store in config:");
console.log(`PLATOS_WORKLOAD_KEYSET='${JSON.stringify(keyset)}'`);
console.log("#");
console.log("# 3) Deploy the VERIFIER first (keyset accepts old + new), then the SIGNER.");
console.log("#    Once every caller is signing, set PLATOS_WORKLOAD_IDENTITY_MODE=workload-only");
console.log("#    to retire PLATOS_INTERNAL_AUTH_TOKEN. Watch telemetry: the reason code");
console.log("#    ACCEPT_LEGACY_SHARED_SECRET must reach zero BEFORE flipping the mode.");
