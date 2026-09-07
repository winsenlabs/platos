// The differential: `privacy`'s in-memory double and this adapter, asked the
// SAME questions, with their answers compared VERBATIM.
//
// The fake runs first and the real store second, and the two observation maps
// are compared key by key so a divergence names the step. Nothing is normalised
// on either side — no date coercion, no id masking, no sorting the comparison
// itself — because the scenario is already written to record only what BOTH
// stores can be asked for. See `privacy-conformance.ts` for the three things
// that are deliberately not among them.
//
// THE FAKE IS THE CONTEXT'S OWN, imported from the package that declares the
// port. A double this suite wrote would be a double that agrees with this adapter
// because the same person wrote both, which measures nothing.

import { afterAll, beforeAll, expect, test } from "vitest";

import type { TransactionScope } from "@platos/context-privacy/application/ports/index.js";
import { InMemoryPrivacyRepository } from "@platos/context-privacy/application/testing/index.js";
import { runResult } from "@platos/context-privacy/application/ports/index.js";

import type { PrivacyConformanceIds } from "./privacy-conformance.js";
import { runPrivacyConformance } from "./privacy-conformance.js";
import type { PrivacyHarness } from "./privacy-harness.js";
import { startPrivacyHarness } from "./privacy-harness.js";

let harness: PrivacyHarness;
let ids: PrivacyConformanceIds;

beforeAll(async () => {
  harness = await startPrivacyHarness();
  const tenant = await harness.freshTenant();
  const foreign = await harness.freshTenant();
  ids = {
    organizationId: tenant.organizationId,
    foreignOrganizationId: foreign.organizationId,
    operationIds: [
      harness.base.freshId("0061"),
      harness.base.freshId("0062"),
      harness.base.freshId("0063"),
      harness.base.freshId("0064"),
    ],
    tombstoneIds: [
      harness.base.freshId("0065"),
      harness.base.freshId("0066"),
      harness.base.freshId("0067"),
    ],
    // A uuid of the right SHAPE that names no row, so every miss is a miss
    // rather than a refusal about the id's spelling.
    absentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

test("the in-memory double and the PostgreSQL store answer identically", async () => {
  const fake = new InMemoryPrivacyRepository();
  // The double takes ANY handle: `TransactionScope` is opaque by construction
  // (ADR M0.3 §3), and a double that demanded a real one would be a double that
  // knew what a transaction is.
  const fakeObservations = await runPrivacyConformance(fake, ids, async (work) =>
    work({ transactionId: "txn-fake" } as unknown as TransactionScope),
  );

  // The real store takes one THIS adapter's ambient frame minted. Anything else
  // is refused three distinct ways; see `privacy-transaction.integration.test.ts`.
  const realObservations = await runPrivacyConformance(harness.repository, ids, (work) =>
    harness.run(work),
  );

  // Key by key, so a failure names the step rather than dumping two maps.
  expect(Object.keys(realObservations).sort()).toEqual(Object.keys(fakeObservations).sort());
  for (const key of Object.keys(fakeObservations)) {
    expect({ [key]: realObservations[key] }).toEqual({ [key]: fakeObservations[key] });
  }
});

test("the scenario is not vacuous: it exercises every method of both halves", () => {
  // A conformance run that agreed because it asked nothing would be the most
  // expensive way in this repository to prove nothing. The ten methods of
  // `PrivacyRepository` are named here, so a scenario that quietly stopped
  // calling one fails HERE rather than going on agreeing.
  const source = runPrivacyConformance.toString();
  for (const method of [
    "insertOperation",
    "findByIdempotencyKey",
    "findOperation",
    "updateProgress",
    "claimLease",
    "listDueOperations",
    "listOperationsForSubject",
    "findActiveTombstones",
    "sealTombstones",
    "purgeExpiredTombstones",
  ]) {
    expect(source, `${method} must be exercised by the scenario`).toContain(method);
  }
});
