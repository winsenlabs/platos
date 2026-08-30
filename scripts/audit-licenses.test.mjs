import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildLicenseIndex,
  fetchLicense,
  licenseIndexText,
} from "./audit-licenses.mjs";

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
