import { describe, expect, test } from "vitest";
import { compareApplicationCatalogs, type CatalogSnapshot } from "./cutover-catalog";
import { deterministicChunks } from "./cutover-backfill";
import { parseCutoverArguments } from "./cutover-cli";
import {
  assertCutoverPhaseLedgerIsExhaustive,
  cutoverDomainPhases,
  incompleteCutoverPhaseIds,
} from "./cutover-phases";
import { serializeCutoverReport } from "./cutover-report";

describe("cutover command safety contracts", () => {
  test("defaults to dry-run and requires mandatory rollback for core rehearsal", () => {
    expect(parseCutoverArguments([]).mode).toBe("DRY_RUN");
    expect(() => parseCutoverArguments(["--execute", "--core-rehearsal"]))
      .toThrow("requires --force-rollback-before-commit");
    expect(() => parseCutoverArguments(["--core-rehearsal", "--force-rollback-before-commit"]))
      .toThrow("requires the explicit --execute flag");
    expect(
      parseCutoverArguments([
        "--execute",
        "--core-rehearsal",
        "--force-rollback-before-commit",
      ]).mode
    ).toBe("CORE_REHEARSAL_ROLLBACK");
  });

  test("keeps all unimplemented domain phases machine-readable and exhaustive", () => {
    expect(() => assertCutoverPhaseLedgerIsExhaustive()).not.toThrow();
    expect(cutoverDomainPhases.filter((phase) => phase.implementation === "IMPLEMENTED"))
      .toHaveLength(1);
    expect(incompleteCutoverPhaseIds).toEqual([
      "remaining-retained-backfill",
      "unsupported-trigger-export",
      "ephemeral-session-recovery-disposition",
      "clean-trigger-defer-install",
      "cryptographic-read-probes",
      "external-analytics-object-rekey",
    ]);
  });

  test("compares normalized application catalogs exactly", () => {
    const left: CatalogSnapshot = {
      entries: [{ kind: "column", name: "User.1", definition: "id|uuid" }],
      digest: "one",
    };
    expect(compareApplicationCatalogs(left, left)).toMatchObject({ equal: true, missing: [], unexpected: [] });
    const right: CatalogSnapshot = { entries: [], digest: "two" };
    expect(compareApplicationCatalogs(left, right)).toMatchObject({
      equal: false,
      missing: [],
      unexpected: ["column:User.1:id|uuid"],
    });
  });

  test("uses stable bounded chunks and rejects ambiguous chunk sizes", () => {
    expect(deterministicChunks(["a", "b", "c", "d", "e"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(() => deterministicChunks([], 0)).toThrow("positive integer");
  });

  test("emits a checksummed structured report without database URLs", () => {
    const output = serializeCutoverReport({
      reportVersion: 1,
      runId: "03125bd3-8e2e-5500-8942-574db43e9203",
      mappingVersion: 1,
      mappingNamespace: "75803f94-05d5-5eb3-b37d-65774e2aaa6c",
      mode: "DRY_RUN",
      state: "INCOMPLETE_IMPLEMENTATION",
      startedAt: "2026-08-17T00:00:00.000Z",
      finishedAt: "2026-08-17T00:00:01.000Z",
      checks: [],
      phases: [],
      sourceDigests: [],
      incompletePhaseIds: incompleteCutoverPhaseIds,
    });
    expect(JSON.parse(output)).toMatchObject({
      state: "INCOMPLETE_IMPLEMENTATION",
      reportSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(output).not.toContain("postgresql://");
  });
});
