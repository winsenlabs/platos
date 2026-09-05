// Statement counts, MEASURED — the N+1 control for `channels`.
//
// EVERY PIN IS TAKEN TWICE, over a small environment and one an order of
// magnitude larger, and both must be identical. A read whose cost grows with the
// rows it returns is correct in every case and expensive in exactly one: the
// installation that has been running longest. Two of these reads walk a join —
// a connection and an app each resolve their environment's project and that
// project's organization, because the aggregate carries a three-id scope and the
// table holds one — and one reads two tables, so all three are places a per-row
// query would be invisible until it was slow.
//
// THE PROBE PATTERN IS ANCHORED, and this is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// the statement suites strip to discard the driver's connection probe, so the
// lock was measured at ZERO statements and a mutation that removed it survived.
// The filter below therefore anchors the probe to a statement that is ONLY
// `SELECT 1`, and every measurement records the unfiltered count beside the
// filtered one so a suite can assert what the filter actually removed.
//
// THE ONE READ WHOSE COUNT DEPENDS ON ITS INPUT IS PINNED AT BOTH VALUES.
// `findInstallation` costs TWO statements when the row names a credential and
// ONE when it does not, because `credentialRevision` is a projection with
// nowhere to come from when there is no credential. That is a function of the
// ROW, never of the size of the table, so both are pinned and the pair is what
// says so.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ChannelApp,
  ChannelAppId,
  ChannelConnection,
  ChannelConnectionId,
  ChannelEvent,
  ChannelEventInboxId,
  ChannelInstallation,
  ChannelInstallationId,
  ChannelThreadId,
  ChannelThreadKey,
  CredentialId,
  EnvironmentScope,
  ExternalInstallationId,
  ProviderEventId,
  ThreadId,
} from "@platos/context-channels/application/ports/index.js";
import { asIdentifier, connectionOwner } from "@platos/context-channels/application/ports/index.js";

import { CONFORMANCE_AT } from "./channels-conformance.js";
import type { ChannelsHarness } from "./channels-harness.js";
import { startChannelsHarness } from "./channels-harness.js";

let harness: ChannelsHarness;

interface Fixture {
  readonly scope: EnvironmentScope;
  readonly connectionId: ChannelConnectionId;
  readonly appId: ChannelAppId;
  readonly credentialInstallationId: ChannelInstallationId;
  readonly bareInstallationId: ChannelInstallationId;
  readonly externalId: ExternalInstallationId;
  readonly threadId: ThreadId;
  readonly threadKey: ChannelThreadKey;
  readonly inboxId: ChannelEventInboxId;
  readonly eventId: ProviderEventId;
  readonly linkCount: number;
}

let small: Fixture;
let large: Fixture;

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of. `SELECT 1` is the driver's connection probe and is
 * matched ONLY when the whole statement is that and nothing else, so a read that
 * genuinely projects a constant cannot be discarded by the thing measuring it.
 */
function queries(): readonly string[] {
  return harness.base
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*SELECT\s+1\s*$/iu.test(statement),
    );
}

interface Measurement {
  readonly counted: number;
  readonly total: number;
}

async function measure(work: () => Promise<unknown>): Promise<Measurement> {
  harness.base.resetStatements();
  await work();
  return { counted: queries().length, total: harness.base.statements().length };
}

function connectionOf(fixture: Fixture, id: string): ChannelConnection {
  return {
    connectionId: asIdentifier<ChannelConnectionId>(id),
    scope: fixture.scope,
    entityId: null,
    provider: "slack",
    displayName: null,
    defaultAgentId: null,
    agentRouting: [],
    enabled: true,
    credentialId: null,
    createdAt: CONFORMANCE_AT,
  };
}

function appOf(fixture: Fixture, id: string): ChannelApp {
  return {
    appId: asIdentifier<ChannelAppId>(id),
    scope: fixture.scope,
    provider: "slack",
    displayName: null,
    clientId: `client-${id.slice(-8)}`,
    credentialId: null,
    scopes: [],
    distribution: "private",
    defaultAgentId: null,
    agentRouting: [],
    createdAt: CONFORMANCE_AT,
  };
}

function installationOf(
  fixture: Fixture,
  id: string,
  credentialId: string | null,
  external: string,
): ChannelInstallation {
  return {
    installationId: asIdentifier<ChannelInstallationId>(id),
    appId: fixture.appId,
    externalInstallationId: asIdentifier<ExternalInstallationId>(external),
    displayName: null,
    credentialId: credentialId === null ? null : asIdentifier<CredentialId>(credentialId),
    credentialRevision: 0,
    grantedScopes: [],
    defaultAgentId: null,
    agentRouting: [],
    status: "active",
    revokedAt: null,
    lastEventAt: null,
    refreshState: "IDLE",
    refreshClaimId: null,
    refreshStartedAt: null,
    refreshRepairCode: null,
    tokenGeneration: 1,
    createdAt: CONFORMANCE_AT,
  };
}

function eventOf(fixture: Fixture, id: string, eventId: string, offset: number): ChannelEvent {
  return {
    inboxId: asIdentifier<ChannelEventInboxId>(id),
    appId: fixture.appId,
    eventId: asIdentifier<ProviderEventId>(eventId),
    payload: { formatVersion: 1, keyVersion: 1, ciphertext: "sealed" },
    status: "PENDING",
    retryCount: 0,
    availableAt: new Date(CONFORMANCE_AT.getTime() + offset),
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    turnId: null,
    deliveryCompletedAt: null,
    lastErrorCode: null,
    completedAt: null,
    createdAt: new Date(CONFORMANCE_AT.getTime() + offset),
  };
}

/** `links` links on one thread and `events` rows in one inbox. */
async function seed(links: number, events: number): Promise<Fixture> {
  const scope = await harness.freshScope();
  const thread = await harness.seedThread(scope);
  const credentialId = await harness.seedCredential(scope, { secretRevision: 3 });
  const partial: Fixture = {
    scope,
    connectionId: asIdentifier<ChannelConnectionId>(harness.base.freshId("0601")),
    appId: asIdentifier<ChannelAppId>(harness.base.freshId("0602")),
    credentialInstallationId: asIdentifier<ChannelInstallationId>(harness.base.freshId("0603")),
    bareInstallationId: asIdentifier<ChannelInstallationId>(harness.base.freshId("0604")),
    externalId: asIdentifier<ExternalInstallationId>(`T${harness.base.freshId("0605").slice(-8)}`),
    threadId: asIdentifier<ThreadId>(thread.threadId),
    threadKey: asIdentifier<ChannelThreadKey>("channel:C0PIN:1.0"),
    inboxId: asIdentifier<ChannelEventInboxId>(harness.base.freshId("0606")),
    eventId: asIdentifier<ProviderEventId>(`Ev-${harness.base.freshId("0607").slice(-8)}`),
    linkCount: links,
  };

  await harness.base.adapter.unitOfWork.run(async (transaction) => {
    await harness.repository.saveConnection(
      connectionOf(partial, partial.connectionId),
      transaction,
    );
    await harness.repository.saveApp(appOf(partial, partial.appId), transaction);
    await harness.repository.saveInstallation(
      installationOf(partial, partial.credentialInstallationId, credentialId, partial.externalId),
      transaction,
    );
    await harness.repository.saveInstallation(
      installationOf(partial, partial.bareInstallationId, null, `${partial.externalId}-bare`),
      transaction,
    );
    await harness.repository.insertThreadLink(
      {
        linkId: asIdentifier<ChannelThreadId>(harness.base.freshId("0608")),
        owner: connectionOwner(partial.connectionId),
        channelThreadKey: partial.threadKey,
        threadId: partial.threadId,
        createdAt: CONFORMANCE_AT,
      },
      transaction,
    );
    // The remaining links hang off their own connections, all pointing at the
    // SAME thread — which is what makes `findThreadLinksByThread` a read whose
    // result grows while its statement count must not.
    for (let index = 1; index < links; index += 1) {
      const siblingId = harness.base.freshId("0609");
      await harness.repository.saveConnection(connectionOf(partial, siblingId), transaction);
      await harness.repository.insertThreadLink(
        {
          linkId: asIdentifier<ChannelThreadId>(harness.base.freshId("060a")),
          owner: connectionOwner(asIdentifier<ChannelConnectionId>(siblingId)),
          channelThreadKey: partial.threadKey,
          threadId: partial.threadId,
          createdAt: CONFORMANCE_AT,
        },
        transaction,
      );
    }
    await harness.repository.insertEvent(
      eventOf(partial, partial.inboxId, partial.eventId, 0),
      transaction,
    );
    for (let index = 1; index < events; index += 1) {
      await harness.repository.insertEvent(
        eventOf(
          partial,
          harness.base.freshId("060b"),
          `Ev-${harness.base.freshId("060c").slice(-8)}`,
          index,
        ),
        transaction,
      );
    }
  });
  return partial;
}

beforeAll(async () => {
  harness = await startChannelsHarness();
  small = await seed(2, 3);
  large = await seed(20, 30);
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

/** Every read, measured over both fixtures. The pair must agree. */
const READS: readonly {
  readonly name: string;
  readonly pin: number;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}[] = [
  {
    name: "findConnection",
    pin: 1,
    // ONE statement, and it is why the read is raw: the aggregate carries a
    // three-id scope, and the client would load each relation level separately.
    run: (f) => harness.repository.findConnection(f.scope, f.connectionId),
  },
  { name: "findConnectionById", pin: 1, run: (f) => harness.repository.findConnectionById(f.connectionId) },
  { name: "findApp", pin: 1, run: (f) => harness.repository.findApp(f.scope, f.appId) },
  { name: "findAppById", pin: 1, run: (f) => harness.repository.findAppById(f.appId) },
  {
    name: "findInstallation(with a credential)",
    pin: 2,
    // The row, then the credential's active revision. See the header: a function
    // of the ROW and never of the size of the table.
    run: (f) => harness.repository.findInstallation(f.credentialInstallationId),
  },
  {
    name: "findInstallation(without one)",
    pin: 1,
    run: (f) => harness.repository.findInstallation(f.bareInstallationId),
  },
  {
    name: "findInstallationByExternalId",
    pin: 2,
    run: (f) => harness.repository.findInstallationByExternalId(f.appId, f.externalId),
  },
  {
    name: "findThreadLink",
    pin: 1,
    run: (f) => harness.repository.findThreadLink(connectionOwner(f.connectionId), f.threadKey),
  },
  {
    name: "findThreadLinksByThread",
    pin: 2,
    // TWO tables, TWO statements, whatever the thread carries — not one per link.
    run: (f) => harness.repository.findThreadLinksByThread(f.threadId),
  },
  { name: "findEvent", pin: 1, run: (f) => harness.repository.findEvent(f.inboxId) },
  {
    name: "findEventByProviderId",
    pin: 1,
    run: (f) => harness.repository.findEventByProviderId(f.appId, f.eventId),
  },
  {
    name: "findClaimableEvents",
    pin: 1,
    run: (f) =>
      harness.repository.findClaimableEvents(f.appId, new Date(CONFORMANCE_AT.getTime() + 60_000), 50),
  },
];

async function measureReads(fixture: Fixture): Promise<Record<string, Measurement>> {
  const measured: Record<string, Measurement> = {};
  for (const read of READS) {
    measured[read.name] = await measure(() => read.run(fixture));
  }
  return measured;
}

describe("every read costs the same over a small environment and a large one", () => {
  test("each read's statement count matches its pin, over BOTH sizes", async () => {
    // ONE case over the whole map rather than one per read — the census refuses
    // a `test()` declared in a loop, and the map is the better instrument
    // anyway: a divergence names the read and shows both counts, and a read
    // somebody forgot to measure cannot exist.
    const overSmall = await measureReads(small);
    const overLarge = await measureReads(large);
    const pins = Object.fromEntries(READS.map((read) => [read.name, read.pin]));
    expect(Object.fromEntries(Object.entries(overSmall).map(([n, m]) => [n, m.counted]))).toEqual(
      pins,
    );
    expect(Object.fromEntries(Object.entries(overLarge).map(([n, m]) => [n, m.counted]))).toEqual(
      pins,
    );
  });

  test("nothing the reads sent was discarded by the filter that counts them", async () => {
    // THE ANCHOR. Tranche 3's advisory lock projected `SELECT 1`, which is the
    // shape these suites strip to discard the driver's connection probe, so the
    // lock measured ZERO statements and the mutation that removed it survived.
    // A read outside a transaction sends no frame either, so for every read the
    // filtered and unfiltered counts must be EQUAL — which is what stops the
    // measurement from hiding the thing it measures.
    const overSmall = await measureReads(small);
    const overLarge = await measureReads(large);
    for (const [name, measured] of Object.entries(overSmall)) {
      expect({ name, ...measured }).toEqual({ name, counted: measured.counted, total: measured.counted });
    }
    for (const [name, measured] of Object.entries(overLarge)) {
      expect({ name, ...measured }).toEqual({ name, counted: measured.counted, total: measured.counted });
    }
  });

  test("the large fixture really is larger", async () => {
    // NON-VACUITY. Two empty environments would agree on every count above.
    const links = await harness.repository.findThreadLinksByThread(large.threadId);
    const events = await harness.repository.findClaimableEvents(
      large.appId,
      new Date(CONFORMANCE_AT.getTime() + 60_000),
      50,
    );
    expect(links.ok && links.value.length).toBe(20);
    expect(events.ok && events.value.length).toBe(30);
  });
});

describe("the writes whose statement count is the contract", () => {
  test("a connection is its ancestry check and one upsert", async () => {
    const measured = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.saveConnection(
          connectionOf(small, harness.base.freshId("060d")),
          transaction,
        ),
      ),
    );
    // TWO, and the first one is the reason `saveConnection` takes no scope
    // parameter: the scope is ON the value, so the tree is what says whether the
    // value is telling the truth. The frame IS present here, because this ran
    // inside a transaction.
    expect(measured.counted).toBe(2);
    expect(measured.total).toBeGreaterThan(measured.counted);
  });

  test("an admission is ONE statement and the unique is what makes it idempotent", async () => {
    const measured = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertEvent(
          eventOf(small, harness.base.freshId("060e"), `Ev-${harness.base.freshId("060f").slice(-8)}`, 99),
          transaction,
        ),
      ),
    );
    // ONE. A store that probed first would be two statements on the hot inbound
    // path AND would still need the unique, because the probe is not a lock.
    expect(measured.counted).toBe(1);
  });

  test("a link is its probe and its insert, and a conflict is the probe alone", async () => {
    const fresh = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertThreadLink(
          {
            linkId: asIdentifier<ChannelThreadId>(harness.base.freshId("0610")),
            owner: connectionOwner(small.connectionId),
            channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C0NEW:1.0"),
            threadId: small.threadId,
            createdAt: CONFORMANCE_AT,
          },
          transaction,
        ),
      ),
    );
    expect(fresh.counted).toBe(2);
    const conflicting = await measure(() =>
      harness.base.adapter.unitOfWork.run((transaction) =>
        harness.repository.insertThreadLink(
          {
            linkId: asIdentifier<ChannelThreadId>(harness.base.freshId("0611")),
            owner: connectionOwner(small.connectionId),
            channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C0NEW:1.0"),
            threadId: small.threadId,
            createdAt: CONFORMANCE_AT,
          },
          transaction,
        ),
      ),
    );
    // ONE, and no INSERT — which is exactly why the transaction survives it.
    expect(conflicting.counted).toBe(1);
  });
});
