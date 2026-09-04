// The ADR-vs-tree disagreement on ADR M0.3 §1 row 17, pinned.
//
// These are not decorative assertions. `OWNED_CANONICAL_MODELS` is what
// `eventing-erasure-target.ts` builds its plan from, so a future edit that
// "restores" the two legacy rows to this context would change the erasure plan,
// and it would be caught here and in `eventing-erasure-target.test.ts` rather
// than discovered when an erasure receipt claims to have destroyed rows in a
// schema this context may not touch.

import { describe, expect, it } from "vitest";

import {
  CANONICAL_SCHEMA_PATH,
  isUnmodelledAdrRow,
  LEGACY_SCHEMA_OWNER,
  LEGACY_SCHEMA_PATH,
  NOTIFICATION_RULE_MODEL,
  OWNED_CANONICAL_MODELS,
  UNMODELLED_ADR_ROWS,
} from "./legacy-rows.js";

describe("ADR M0.3 §1 row 17 ownership", () => {
  it("claims exactly ONE canonical row, not the three the ADR lists", () => {
    expect(OWNED_CANONICAL_MODELS).toEqual(["NotificationRule"]);
    expect(NOTIFICATION_RULE_MODEL).toBe("NotificationRule");
  });

  it("names the two rows it does NOT model, with a reason for each", () => {
    expect(Object.keys(UNMODELLED_ADR_ROWS).sort()).toEqual([
      "PlatformNotification",
      "PlatformNotificationInteraction",
    ]);
    for (const reason of Object.values(UNMODELLED_ADR_ROWS)) {
      expect(reason).toContain("legacy schema only");
    }
  });

  it("does not claim and disclaim the same row", () => {
    for (const model of OWNED_CANONICAL_MODELS) {
      expect(isUnmodelledAdrRow(model)).toBe(false);
    }
  });

  // The substantive reason the two rows are not modelled: ADR §1 row 11 and §7
  // decision 10 give the legacy schema WHOLESALE to the durable-runtime adapter,
  // so claiming rows in it would put two owners on one table.
  it("records that the legacy schema is owned wholesale by another package", () => {
    expect(LEGACY_SCHEMA_PATH).toBe("internal-packages/database/prisma/schema.prisma");
    expect(LEGACY_SCHEMA_OWNER).toBe("packages/adapters/durable-runtime");
    expect(CANONICAL_SCHEMA_PATH).not.toBe(LEGACY_SCHEMA_PATH);
  });

  it("recognises the disclaimed names and nothing else", () => {
    expect(isUnmodelledAdrRow("PlatformNotification")).toBe(true);
    expect(isUnmodelledAdrRow("PlatformNotificationInteraction")).toBe(true);
    expect(isUnmodelledAdrRow("NotificationRule")).toBe(false);
    expect(isUnmodelledAdrRow("Environment")).toBe(false);
    expect(isUnmodelledAdrRow("toString")).toBe(false);
  });
});
