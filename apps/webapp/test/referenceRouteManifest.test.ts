import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { referenceRouteManifest } from "../app/components/platos/referenceRouteManifest";

describe("WIN-233 route-to-reference classification", () => {
  it("classifies every one of the 47 governing references exactly once", () => {
    const references = readdirSync(join(process.cwd(), "../../design/platos-ui-refactor"))
      .filter((name) => name.endsWith(".dc.html"))
      .sort();
    const classified = referenceRouteManifest.map((entry) => entry.reference).sort();
    expect(references).toHaveLength(47);
    expect(classified).toEqual(references);
    expect(new Set(classified).size).toBe(47);
  });

  it("keeps exclusions explicit, capability-scoped, and endpoint-honest", () => {
    const exclusions = referenceRouteManifest.filter((entry) => entry.classification === "approved-exclusion");
    expect(exclusions.map((entry) => entry.reference).sort()).toEqual([
      "07-billing.dc.html",
      "43-docs.dc.html",
      "45-admin.dc.html",
    ]);
    for (const exclusion of exclusions) {
      expect(exclusion.target).toBe("unavailable");
      expect(exclusion.rationale?.length).toBeGreaterThan(30);
    }
  });

  it("assigns every production reference a concrete route or component caller", () => {
    for (const entry of referenceRouteManifest.filter((item) => item.classification === "production")) {
      expect(entry.target).not.toBe("unavailable");
      expect(entry.target.length).toBeGreaterThan(0);
    }
  });
});
