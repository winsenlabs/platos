import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MEMORY_ARCHIVE_STATES,
  MEMORY_KINDS,
  MEMORY_SOURCES,
  MEMORY_VISIBILITIES,
  isMemoryVisibility,
  normalizeMemoryProfileKey,
} from "./memory-contract";

describe("canonical Memory contract", () => {
  it("keeps persisted kinds, sources, archive states, and visibility exact", () => {
    expect(MEMORY_KINDS).toEqual(["fact", "preference", "event", "relationship", "profile"]);
    expect(MEMORY_VISIBILITIES).toEqual(["agent_visible", "hidden", "private"]);
    expect(MEMORY_SOURCES).toEqual(["manual", "extracted", "imported", "rag"]);
    expect(MEMORY_ARCHIVE_STATES).toEqual(["active", "archived", "all"]);
    expect(isMemoryVisibility("agent_visible")).toBe(true);
    expect(isMemoryVisibility("cluster")).toBe(false);
    expect(isMemoryVisibility("agent")).toBe(false);
  });

  it("normalizes profile identity deterministically", () => {
    expect(normalizeMemoryProfileKey("  Preferred Name  ")).toBe("preferred name");
  });

  it("keeps the applied initial migration immutable for Memory evolution", () => {
    const initialSql = readFileSync(
      resolve(process.cwd(), "prisma/migrations/00000000000000_initial/migration.sql"),
      "utf8",
    );

    expect(initialSql).toContain('CREATE TABLE "public"."Memory"');
    expect(initialSql).not.toContain('"profileKey" TEXT');
    expect(initialSql).not.toContain('CONSTRAINT "Memory_source_check"');
    expect(initialSql).not.toContain('CREATE UNIQUE INDEX "Memory_profile_standalone_key"');
    expect(initialSql).not.toContain('CREATE UNIQUE INDEX "Memory_profile_cluster_key"');
  });

  it("evolves deployed Memory schemas through the additive migration", () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260824111500_memory_profile_key_and_source_contract/migration.sql",
      ),
      "utf8",
    );

    expect(sql).toContain('ADD COLUMN "profileKey" TEXT');
    expect(sql).toContain('ADD COLUMN "originalSource" TEXT');
    expect(sql).toContain('ADD COLUMN "originalSourceThreadId" TEXT');
    expect(sql).toContain('ADD COLUMN "originalSourceTurnIds" TEXT[]');
    expect(sql).toContain('CONSTRAINT "Memory_source_check"');
    expect(sql).toContain("CHECK (\"source\" IN ('manual', 'extracted', 'imported', 'rag')) NOT VALID");
    expect(sql).toContain('VALIDATE CONSTRAINT "Memory_source_check"');
    expect(sql).not.toContain('CREATE UNIQUE INDEX "Memory_profile_standalone_key"');
    expect(sql).not.toContain('CREATE UNIQUE INDEX "Memory_profile_cluster_key"');
    expect(sql).toContain('CONSTRAINT "Memory_visibility_check"');
    expect(sql).toContain("lower(btrim(\"visibility\")) = 'subject'");
    expect(sql).toContain("WHEN \"agentVisible\" = TRUE THEN 'agent_visible'");
    expect(sql).toContain("WHEN lower(btrim(\"visibility\")) IN ('private', 'subject') THEN 'private'");
    expect(sql).toContain("'legacy_extracted'");
    expect(sql).toContain("('turn', 'agent_turn', 'extractor', 'extraction')");
    expect(sql).toContain("ELSE 'manual'");
    expect(sql).not.toContain('"metadata" ->> \'profileKey\'');
    expect(sql).toContain('MemoryProfileBackfillService');

    const inventoryOffset = sql.indexOf("Memory compatibility inventory before normalization");
    const normalizationOffset = sql.indexOf('UPDATE "public"."Memory"\nSET "source"');
    const sourceConstraintOffset = sql.indexOf('ADD CONSTRAINT "Memory_source_check"');
    const originalProvenanceOffset = sql.indexOf('"originalSource" = "source"');
    expect(originalProvenanceOffset).toBeGreaterThanOrEqual(0);
    expect(inventoryOffset).toBeGreaterThanOrEqual(0);
    expect(inventoryOffset).toBeGreaterThan(originalProvenanceOffset);
    expect(normalizationOffset).toBeGreaterThan(inventoryOffset);
    expect(sourceConstraintOffset).toBeGreaterThan(normalizationOffset);
  });
});
