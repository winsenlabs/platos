#!/usr/bin/env bash
set -euo pipefail

docker compose exec -T agent node <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.join(process.cwd(), "node_modules/@internal/workload-identity");
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.main, "./dist/index.js");
assert.equal(manifest.types, "./dist/index.d.ts");
assert.deepEqual(manifest.files, ["dist"]);
assert.equal(manifest.exports["."].require, "./dist/index.js");
assert.equal(manifest.exports["."].default, "./dist/index.js");
assert.equal(fs.existsSync(path.join(packageRoot, "src/index.ts")), false);

const entry = require.resolve("@internal/workload-identity");
assert.match(entry, /\/node_modules\/@internal\/workload-identity\/dist\/index\.js$/);
const workloadIdentity = require("@internal/workload-identity");
assert.equal(workloadIdentity.WORKLOAD_AUDIENCE, "platos-agent");
console.log(`workload identity runtime entry: ${entry}`);
NODE

node tests/persisted-state-gate/agent-runtime-health.mjs
