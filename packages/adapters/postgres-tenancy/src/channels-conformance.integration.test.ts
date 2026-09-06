// The differential: one scenario, two stores, two transcripts, compared verbatim.
//
// THE DOUBLE IS THE CONTEXT'S OWN. `InMemoryChannelsRepository` is what every
// use-case suite in `packages/contexts/channels` runs against, so this is not a
// comparison against a second implementation written to agree — it is the
// question "is the store those suites proved the use cases against the same port
// as the one that ships?" answered by `toEqual`.
//
// NON-VACUITY IS ASSERTED, NOT ASSUMED. Two transcripts of zero observations are
// equal, and so are two transcripts that are entirely refusals. The last two
// cases pin the count and require the happy-path steps to have produced values.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ImmediateUnitOfWork,
  InMemoryChannelsRepository,
} from "@platos/context-channels/application/testing/index.js";
import type {
  ChannelAppId,
  ChannelAppThreadId,
  ChannelConnectionId,
  ChannelEventInboxId,
  ChannelInstallationId,
  ChannelThreadId,
  RefreshClaimId,
} from "@platos/context-channels/application/ports/index.js";
import { asIdentifier } from "@platos/context-channels/application/ports/index.js";

import type { ChannelsWorld } from "./channels-conformance.js";
import { runChannelsConformance } from "./channels-conformance.js";
import type { ChannelsHarness } from "./channels-harness.js";
import { startChannelsHarness } from "./channels-harness.js";

let harness: ChannelsHarness;
let world: ChannelsWorld;

// BOTH TRANSCRIPTS ARE TAKEN ONCE, in `beforeAll`, and every case below reads
// them. The scenario is not idempotent and must not be: `insertEvent` collides
// with the row a previous run admitted, which is the whole point of the unique it
// is testing. A case that re-ran it would compare a first run against a second.
let fake: readonly string[] = [];
let real: readonly string[] = [];

/** The revision the scenario claims, and the one the seeded credential holds. */
const SEEDED_REVISION = 4;

beforeAll(async () => {
  harness = await startChannelsHarness();
  const scope = await harness.freshScope();
  const foreignScope = await harness.freshScope();
  const entityId = await harness.seedEntity(scope);
  const agentId = await harness.seedAgent(scope);
  const credentialId = await harness.seedCredential(scope, { secretRevision: SEEDED_REVISION });
  const thread = await harness.seedThread(scope);
  const otherThread = await harness.seedThread(scope);
  const turnId = await harness.seedTurn(thread);
  world = {
    scope,
    foreignScope,
    entityId,
    agentId: asIdentifier(agentId),
    credentialId: asIdentifier(credentialId),
    credentialRevision: SEEDED_REVISION,
    threadId: asIdentifier(thread.threadId),
    otherThreadId: asIdentifier(otherThread.threadId),
    connectionId: asIdentifier<ChannelConnectionId>(harness.base.freshId("0201")),
    appId: asIdentifier<ChannelAppId>(harness.base.freshId("0202")),
    installationId: asIdentifier<ChannelInstallationId>(harness.base.freshId("0203")),
    connectionLinkId: asIdentifier<ChannelThreadId>(harness.base.freshId("0204")),
    installationLinkId: asIdentifier<ChannelAppThreadId>(harness.base.freshId("0205")),
    inboxIds: [
      asIdentifier<ChannelEventInboxId>(harness.base.freshId("0206")),
      asIdentifier<ChannelEventInboxId>(harness.base.freshId("0207")),
      asIdentifier<ChannelEventInboxId>(harness.base.freshId("0208")),
    ],
    refreshClaimId: asIdentifier<RefreshClaimId>(harness.base.freshId("0209")),
    turnId: asIdentifier(turnId),
    absentId: harness.base.freshId("020a"),
  };
  const fakeUnitOfWork = new ImmediateUnitOfWork();
  fake = await runChannelsConformance(
    new InMemoryChannelsRepository(),
    (work) => fakeUnitOfWork.run(work),
    world,
  );
  real = await runChannelsConformance(
    harness.repository,
    (work) => harness.base.adapter.unitOfWork.run(work),
    world,
  );
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

describe("the PostgreSQL channels store and the in-memory double answer the same port", () => {
  test("their transcripts match, observation for observation", () => {
    expect(real).toEqual(fake);
  });

  test("the transcript is long enough to be evidence", () => {
    // NON-VACUITY. Two empty runs are equal, and so are two runs that refused
    // everything. This pins the shape of the scenario itself.
    expect(real).toHaveLength(36);
    expect(real.filter((line) => line.includes(`"error"`))).toHaveLength(2);
  });

  test("the happy-path reads really returned rows", () => {
    const inScope = real.find((line) => line.startsWith("findConnection(in scope)"));
    const installation = real.find((line) => line.startsWith("findInstallation =>"));
    expect(inScope).toContain(`"provider":"slack"`);
    expect(installation).toContain(`"revision":${SEEDED_REVISION}`);
  });

  test("the scoped read really hid the row from another tenant", () => {
    expect(real).toContain("findConnection(foreign scope) => null");
    expect(real).toContain("findApp(foreign scope) => null");
  });

  test("the store the double was compared against is the one the adapter publishes", () => {
    // The differential is worthless if `harness.repository` is not the shipped
    // adapter. This asserts the identity rather than trusting the cast.
    expect(harness.repository).toBe(harness.base.adapter as unknown);
    expect(harness.base.adapter.adapterName).toBe("postgres-tenancy");
  });
});
