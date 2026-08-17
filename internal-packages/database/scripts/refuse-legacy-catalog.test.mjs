import assert from "node:assert/strict";
import { test } from "vitest";

import {
  LEGACY_MIGRATION_MARKERS,
  LEGACY_TABLE_MARKERS,
  legacyCatalogEvidence,
} from "./refuse-legacy-catalog.mjs";

test("accepts an empty or clean catalog", () => {
  assert.deepEqual(legacyCatalogEvidence({}), { tables: [], migrations: [], isLegacy: false });
  assert.equal(
    legacyCatalogEvidence({ tableNames: ["Environment", "Thread"] }).isLegacy,
    false
  );
});

test("refuses bounded inherited table and migration markers", () => {
  assert.deepEqual(
    legacyCatalogEvidence({
      tableNames: [LEGACY_TABLE_MARKERS[1], "Environment"],
      migrationNames: [LEGACY_MIGRATION_MARKERS[0]],
    }),
    {
      tables: [LEGACY_TABLE_MARKERS[1]],
      migrations: [LEGACY_MIGRATION_MARKERS[0]],
      isLegacy: true,
    }
  );
});
