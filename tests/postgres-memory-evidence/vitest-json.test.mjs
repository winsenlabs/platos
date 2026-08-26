import assert from "node:assert/strict";
import test from "node:test";
import { parseVitestJson } from "./vitest-json.mjs";

const report = '{"numTotalTestSuites":1,"numTotalTests":4,"success":true}';

test("extracts one Vitest JSON report after pnpm warnings", () => {
  assert.deepEqual(parseVitestJson(`apps/webapp | WARN unsupported engine\n${report}\n`, "memory"), {
    numTotalTestSuites: 1,
    numTotalTests: 4,
    success: true,
  });
});

test("rejects missing or duplicate Vitest JSON reports", () => {
  assert.throws(() => parseVitestJson("warning only", "memory"), /emitted 0/);
  assert.throws(() => parseVitestJson(`${report}\n${report}`, "memory"), /emitted 2/);
});
