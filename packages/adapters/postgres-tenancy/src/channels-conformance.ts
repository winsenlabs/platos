// ONE scenario, run against the in-memory double and against PostgreSQL, and
// compared observation for observation.
//
// WHY A TRANSCRIPT AND NOT TWO SUITES. Two suites written separately drift, and
// the drift is invisible: each passes against the store it was written for. A
// single scenario that RECORDS what it saw, replayed against both, makes the
// question "do these two implement the same port?" answerable by `toEqual`. Every
// line below is a string, so a divergence names the step and shows both answers
// rather than pointing at a structural diff of two aggregates.
//
// THE WORLD IS BUILT ONCE AND HANDED TO BOTH RUNS. The real store needs an
// `Agent`, an `Entity`, a `Credential` and two `Thread` rows that exist, and
// their ids reach the transcript. The double needs none of them and cannot mint
// them. So the ids are a PARAMETER: the harness seeds the rows, and both runs
// are handed the same identifiers, which is what lets the transcripts be
// compared as text.
//
// EVERY IDENTIFIER IS A UUID, AND THAT IS A FINDING RATHER THAN A STYLE. This
// context's own builders in `application/testing/builders.ts` mint `conn-1`,
// `app-1`, `cred-1`, `agent-1` and `thread-1`, and every use-case suite in that
// package passes with them. PostgreSQL refuses all five: the columns are
// `@db.Uuid` and the cast raises SQLSTATE 22P02. A conformance scenario that
// reused those builders could not have run against the real store at all, which
// is the same shape of defect tranche 3 found in tenancy's
// `InvitationTokenIssuer`.
//
// THE CREDENTIAL'S REVISION IS SEEDED TO MATCH WHAT THE SCENARIO CLAIMS. The
// double HOLDS `credentialRevision` because it holds whatever it is given; the
// real store PROJECTS it from `CredentialSecretVersion`, because
// `ChannelInstallation` has no such column. Where the two agree, the transcripts
// agree; where they do not, the real store answers with the database's number
// and the double with the caller's, and that divergence is deliberately NOT in
// this scenario — it is a named case of its own in the rules suite, because it
// is a fact about the port rather than a disagreement to paper over.

import type {
  AgentId,
  ChannelApp,
  ChannelAppId,
  ChannelAppThreadId,
  ChannelConnection,
  ChannelConnectionId,
  ChannelEvent,
  ChannelEventInboxId,
  ChannelInstallation,
  ChannelInstallationId,
  ChannelsRepository,
  ChannelThreadId,
  ChannelThreadKey,
  CredentialId,
  EnvironmentScope,
  ExternalInstallationId,
  LeaseOwner,
  ProviderEventId,
  RefreshClaimId,
  Result,
  ThreadId,
  TransactionScope,
  TurnId,
} from "@platos/context-channels/application/ports/index.js";
import {
  asIdentifier,
  connectionOwner,
  installationOwner,
} from "@platos/context-channels/application/ports/index.js";

/** The instant every row in the scenario is stamped with. */
export const CONFORMANCE_AT = new Date("2026-05-01T09:00:00.000Z");

/** A second instant, one lease later, for the expiry half of the claim predicate. */
export const CONFORMANCE_LATER = new Date("2026-05-01T09:10:00.000Z");

/** Peer rows and identifiers both runs share. See the header. */
export interface ChannelsWorld {
  readonly scope: EnvironmentScope;
  /** A DIFFERENT environment, for the cross-tenant reads. */
  readonly foreignScope: EnvironmentScope;
  readonly entityId: string;
  readonly agentId: AgentId;
  readonly credentialId: CredentialId;
  readonly credentialRevision: number;
  readonly threadId: ThreadId;
  readonly otherThreadId: ThreadId;
  readonly connectionId: ChannelConnectionId;
  readonly appId: ChannelAppId;
  readonly installationId: ChannelInstallationId;
  readonly connectionLinkId: ChannelThreadId;
  readonly installationLinkId: ChannelAppThreadId;
  readonly inboxIds: readonly [ChannelEventInboxId, ChannelEventInboxId, ChannelEventInboxId];
  readonly refreshClaimId: RefreshClaimId;
  /**
   * A real `Turn`. `ChannelEventInbox.turnId` is a FOREIGN KEY, which the
   * in-memory double has no equivalent of: it accepts any string, and a scenario
   * that invented one would have run green against the double and taken SQLSTATE
   * 23503 against the database.
   */
  readonly turnId: TurnId;
  /** A well-formed uuid no row in this world uses. */
  readonly absentId: string;
}

/** How the scenario opens a transaction, whichever store it is driving. */
export type RunInTransaction = <Value>(
  work: (transaction: TransactionScope) => Promise<Value>,
) => Promise<Value>;

function connectionOf(world: ChannelsWorld, overrides: Partial<ChannelConnection> = {}): ChannelConnection {
  return {
    connectionId: world.connectionId,
    scope: world.scope,
    entityId: world.entityId,
    provider: "slack",
    displayName: "Acme Slack",
    defaultAgentId: world.agentId,
    agentRouting: [],
    enabled: true,
    credentialId: world.credentialId,
    createdAt: CONFORMANCE_AT,
    ...overrides,
  };
}

function appOf(world: ChannelsWorld, overrides: Partial<ChannelApp> = {}): ChannelApp {
  return {
    appId: world.appId,
    scope: world.scope,
    provider: "slack",
    displayName: "Acme for Slack",
    clientId: "client-9001",
    credentialId: world.credentialId,
    scopes: ["chat:write", "channels:history"],
    distribution: "public",
    defaultAgentId: world.agentId,
    agentRouting: [{ match: { type: "prefix", value: "ada" }, agentId: world.agentId }],
    createdAt: CONFORMANCE_AT,
    ...overrides,
  };
}

function installationOf(
  world: ChannelsWorld,
  overrides: Partial<ChannelInstallation> = {},
): ChannelInstallation {
  return {
    installationId: world.installationId,
    appId: world.appId,
    externalInstallationId: asIdentifier<ExternalInstallationId>("T0ACME"),
    displayName: "Acme workspace",
    credentialId: world.credentialId,
    credentialRevision: world.credentialRevision,
    grantedScopes: ["chat:write"],
    defaultAgentId: world.agentId,
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
    ...overrides,
  };
}

function eventOf(
  world: ChannelsWorld,
  index: 0 | 1 | 2,
  overrides: Partial<ChannelEvent> = {},
): ChannelEvent {
  return {
    inboxId: world.inboxIds[index],
    appId: world.appId,
    eventId: asIdentifier<ProviderEventId>(`Ev0000${index}`),
    payload: { formatVersion: 1, keyVersion: 1, ciphertext: `sealed-${index}` },
    status: "PENDING",
    retryCount: 0,
    availableAt: new Date(CONFORMANCE_AT.getTime() + index * 1000),
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    turnId: null,
    deliveryCompletedAt: null,
    lastErrorCode: null,
    completedAt: null,
    createdAt: new Date(CONFORMANCE_AT.getTime() + index * 1000),
    ...overrides,
  };
}

/** One observation, rendered so a divergence is readable rather than structural. */
function say(step: string, detail: unknown): string {
  return `${step} => ${JSON.stringify(detail)}`;
}

function describeConnection(result: Result<ChannelConnection | null>): unknown {
  if (!result.ok) return { error: result.error.code };
  if (result.value === null) return null;
  const value = result.value;
  return {
    id: value.connectionId,
    org: value.scope.organizationId,
    project: value.scope.projectId,
    environment: value.scope.environmentId,
    entity: value.entityId,
    provider: value.provider,
    enabled: value.enabled,
    rules: value.agentRouting.length,
    credential: value.credentialId,
  };
}

function describeApp(result: Result<ChannelApp | null>): unknown {
  if (!result.ok) return { error: result.error.code };
  if (result.value === null) return null;
  const value = result.value;
  return {
    id: value.appId,
    org: value.scope.organizationId,
    environment: value.scope.environmentId,
    provider: value.provider,
    clientId: value.clientId,
    distribution: value.distribution,
    scopes: [...value.scopes],
    rules: value.agentRouting.length,
  };
}

function describeInstallation(result: Result<ChannelInstallation | null>): unknown {
  if (!result.ok) return { error: result.error.code };
  if (result.value === null) return null;
  const value = result.value;
  return {
    id: value.installationId,
    app: value.appId,
    external: value.externalInstallationId,
    status: value.status,
    scopes: [...value.grantedScopes],
    revision: value.credentialRevision,
    refreshState: value.refreshState,
    claim: value.refreshClaimId,
    generation: value.tokenGeneration,
  };
}

function describeEvent(result: Result<ChannelEvent | null>): unknown {
  if (!result.ok) return { error: result.error.code };
  if (result.value === null) return null;
  const value = result.value;
  return {
    id: value.inboxId,
    event: value.eventId,
    status: value.status,
    retries: value.retryCount,
    owner: value.leaseOwner,
    generation: value.leaseGeneration,
    turn: value.turnId,
    ciphertext: value.payload.ciphertext,
    completed: value.completedAt === null ? null : "set",
  };
}

/**
 * The scenario. Every step is an observation, in order.
 *
 * It writes through the port and reads back through the port, and never through
 * a client: a step that reached past the interface would be measuring the store
 * rather than the contract, and the double could not answer it at all.
 */
export async function runChannelsConformance(
  repository: ChannelsRepository,
  runInTransaction: RunInTransaction,
  world: ChannelsWorld,
): Promise<readonly string[]> {
  const said: string[] = [];
  const record = (step: string, detail: unknown): void => {
    said.push(say(step, detail));
  };

  // ---- connections ---------------------------------------------------------
  await runInTransaction((transaction) =>
    repository.saveConnection(connectionOf(world), transaction),
  );
  record("findConnection(in scope)", describeConnection(
    await repository.findConnection(world.scope, world.connectionId),
  ));
  record("findConnection(foreign scope)", describeConnection(
    await repository.findConnection(world.foreignScope, world.connectionId),
  ));
  record("findConnectionById", describeConnection(
    await repository.findConnectionById(world.connectionId),
  ));
  record("findConnectionById(absent)", describeConnection(
    await repository.findConnectionById(asIdentifier<ChannelConnectionId>(world.absentId)),
  ));

  await runInTransaction((transaction) =>
    repository.saveConnection(
      connectionOf(world, {
        enabled: false,
        displayName: "Acme Slack (paused)",
        agentRouting: [{ match: { type: "channel", id: "C0ACME" }, agentId: world.agentId }],
      }),
      transaction,
    ),
  );
  record("findConnection(after update)", describeConnection(
    await repository.findConnection(world.scope, world.connectionId),
  ));

  // ---- apps ----------------------------------------------------------------
  await runInTransaction((transaction) => repository.saveApp(appOf(world), transaction));
  record("findApp(in scope)", describeApp(await repository.findApp(world.scope, world.appId)));
  record("findApp(foreign scope)", describeApp(
    await repository.findApp(world.foreignScope, world.appId),
  ));
  record("findAppById", describeApp(await repository.findAppById(world.appId)));

  // ---- installations -------------------------------------------------------
  await runInTransaction((transaction) =>
    repository.saveInstallation(installationOf(world), transaction),
  );
  record("findInstallation", describeInstallation(
    await repository.findInstallation(world.installationId),
  ));
  record("findInstallationByExternalId", describeInstallation(
    await repository.findInstallationByExternalId(
      world.appId,
      asIdentifier<ExternalInstallationId>("T0ACME"),
    ),
  ));
  record("findInstallationByExternalId(absent)", describeInstallation(
    await repository.findInstallationByExternalId(
      world.appId,
      asIdentifier<ExternalInstallationId>("T0NOBODY"),
    ),
  ));

  // The fence, claimed and then finalized. Both writes go through `saveInstallation`
  // because the port has no narrower method: the compare-and-swap is the DOMAIN's
  // (`beginRefresh`/`finalizeRefresh`) and this store's job is to persist the row
  // those functions returned, coherently.
  await runInTransaction((transaction) =>
    repository.saveInstallation(
      installationOf(world, {
        refreshState: "REFRESHING",
        refreshClaimId: world.refreshClaimId,
        refreshStartedAt: CONFORMANCE_AT,
      }),
      transaction,
    ),
  );
  record("findInstallation(claimed)", describeInstallation(
    await repository.findInstallation(world.installationId),
  ));

  await runInTransaction((transaction) =>
    repository.saveInstallation(
      installationOf(world, { tokenGeneration: 2 }),
      transaction,
    ),
  );
  record("findInstallation(finalized)", describeInstallation(
    await repository.findInstallation(world.installationId),
  ));

  await runInTransaction((transaction) =>
    repository.saveInstallation(
      installationOf(world, {
        status: "revoked",
        revokedAt: CONFORMANCE_LATER,
        tokenGeneration: 2,
      }),
      transaction,
    ),
  );
  record("findInstallation(revoked)", describeInstallation(
    await repository.findInstallation(world.installationId),
  ));

  // ---- thread links --------------------------------------------------------
  const key = asIdentifier<ChannelThreadKey>("channel:C0ACME:1700000000.1");
  const linked = await runInTransaction((transaction) =>
    repository.insertThreadLink(
      {
        linkId: world.connectionLinkId,
        owner: connectionOwner(world.connectionId),
        channelThreadKey: key,
        threadId: world.threadId,
        createdAt: CONFORMANCE_AT,
      },
      transaction,
    ),
  );
  record("insertThreadLink(connection)", linked.ok ? { id: linked.value.linkId } : { error: linked.error.code });

  const found = await repository.findThreadLink(connectionOwner(world.connectionId), key);
  record("findThreadLink(connection)", found.ok
    ? { thread: found.value?.threadId ?? null, kind: found.value?.owner.kind ?? null }
    : { error: found.error.code });

  const raced = await runInTransaction((transaction) =>
    repository.insertThreadLink(
      {
        linkId: asIdentifier<ChannelThreadId>(world.absentId),
        owner: connectionOwner(world.connectionId),
        channelThreadKey: key,
        threadId: world.otherThreadId,
        createdAt: CONFORMANCE_AT,
      },
      transaction,
    ),
  );
  record("insertThreadLink(loses the race)", raced.ok
    ? { unexpected: raced.value.linkId }
    : { error: raced.error.code, details: raced.error.details });

  const hosted = await runInTransaction((transaction) =>
    repository.insertThreadLink(
      {
        linkId: world.installationLinkId,
        owner: installationOwner(world.installationId),
        channelThreadKey: key,
        threadId: world.threadId,
        createdAt: CONFORMANCE_LATER,
      },
      transaction,
    ),
  );
  record("insertThreadLink(installation, same key)", hosted.ok
    ? { id: hosted.value.linkId }
    : { error: hosted.error.code });

  const byThread = await repository.findThreadLinksByThread(world.threadId);
  record("findThreadLinksByThread", byThread.ok
    ? byThread.value.map((link) => ({ id: link.linkId, kind: link.owner.kind }))
    : { error: byThread.error.code });
  const byOtherThread = await repository.findThreadLinksByThread(world.otherThreadId);
  record("findThreadLinksByThread(other)", byOtherThread.ok
    ? byOtherThread.value.length
    : { error: byOtherThread.error.code });

  // ---- the inbox -----------------------------------------------------------
  for (const index of [0, 1, 2] as const) {
    const inserted = await runInTransaction((transaction) =>
      repository.insertEvent(eventOf(world, index), transaction),
    );
    record(`insertEvent(${index})`, inserted.ok ? { id: inserted.value.inboxId } : { error: inserted.error.code });
  }
  const duplicate = await runInTransaction((transaction) =>
    repository.insertEvent(
      eventOf(world, 0, { inboxId: asIdentifier<ChannelEventInboxId>(world.absentId) }),
      transaction,
    ),
  );
  record("insertEvent(redelivery)", duplicate.ok
    ? { unexpected: duplicate.value.inboxId }
    : { error: duplicate.error.code, details: duplicate.error.details });

  record("findEventByProviderId", describeEvent(
    await repository.findEventByProviderId(world.appId, asIdentifier<ProviderEventId>("Ev00000")),
  ));
  record("findEvent(absent)", describeEvent(
    await repository.findEvent(asIdentifier<ChannelEventInboxId>(world.absentId)),
  ));

  const claimable = await repository.findClaimableEvents(world.appId, CONFORMANCE_LATER, 10);
  record("findClaimableEvents(all pending)", claimable.ok
    ? claimable.value.map((event) => event.eventId)
    : { error: claimable.error.code });

  const bounded = await repository.findClaimableEvents(world.appId, CONFORMANCE_LATER, 2);
  record("findClaimableEvents(bounded)", bounded.ok
    ? bounded.value.map((event) => event.eventId)
    : { error: bounded.error.code });

  // THE FIRST OF THE TWO BOUNDARIES THE DOMAIN FIXES. `isClaimable` admits a
  // waiting row when `availableAt <= now`, INCLUSIVE, so the third event — whose
  // availability is exactly this instant — is claimable. An exclusive comparison
  // would leave a row unclaimable for as long as the clock read that value.
  const atAvailability = await repository.findClaimableEvents(
    world.appId,
    new Date(CONFORMANCE_AT.getTime() + 2000),
    10,
  );
  record("findClaimableEvents(at the exact availability)", atAvailability.ok
    ? atAvailability.value.map((event) => event.eventId)
    : { error: atAvailability.error.code });

  // The claim, as a save of the row `claimEvent` returned.
  await runInTransaction((transaction) =>
    repository.saveEvent(
      eventOf(world, 0, {
        status: "PROCESSING",
        retryCount: 1,
        leaseOwner: asIdentifier<LeaseOwner>("worker-a"),
        leaseExpiresAt: CONFORMANCE_LATER,
        leaseGeneration: 1,
      }),
      transaction,
    ),
  );
  record("findEvent(claimed)", describeEvent(await repository.findEvent(world.inboxIds[0])));
  const whileHeld = await repository.findClaimableEvents(
    world.appId,
    new Date(CONFORMANCE_LATER.getTime() - 1),
    10,
  );
  record("findClaimableEvents(lease still held)", whileHeld.ok
    ? whileHeld.value.map((event) => event.eventId)
    : { error: whileHeld.error.code });
  // THE SECOND BOUNDARY, and it is the opposite one. `isClaimable` admits a held
  // row only when `leaseExpiresAt < now`, STRICTLY, because "a lease that expires
  // exactly now is still held" — the claim predicate and the fence must agree on
  // that instant or a row is briefly claimable by two workers at once.
  const atExpiry = await repository.findClaimableEvents(world.appId, CONFORMANCE_LATER, 10);
  record("findClaimableEvents(at the exact expiry)", atExpiry.ok
    ? atExpiry.value.map((event) => event.eventId)
    : { error: atExpiry.error.code });
  const afterExpiry = await repository.findClaimableEvents(
    world.appId,
    new Date(CONFORMANCE_LATER.getTime() + 1),
    10,
  );
  record("findClaimableEvents(lease expired)", afterExpiry.ok
    ? afterExpiry.value.map((event) => event.eventId)
    : { error: afterExpiry.error.code });

  // Terminal success, with the turn it produced attached.
  await runInTransaction((transaction) =>
    repository.saveEvent(
      eventOf(world, 0, {
        status: "COMPLETED",
        retryCount: 1,
        leaseGeneration: 1,
        turnId: world.turnId,
        completedAt: CONFORMANCE_LATER,
        deliveryCompletedAt: CONFORMANCE_LATER,
        // The payload is deliberately DIFFERENT from the admitted one. The
        // database refuses to move it and the double would overwrite it, so the
        // observation below is what makes the immutability rule visible in a
        // transcript both stores produce.
        payload: { formatVersion: 1, keyVersion: 1, ciphertext: "sealed-0" },
      }),
      transaction,
    ),
  );
  record("findEvent(completed)", describeEvent(await repository.findEvent(world.inboxIds[0])));
  const terminal = await repository.findClaimableEvents(
    world.appId,
    new Date(CONFORMANCE_LATER.getTime() + 60_000),
    10,
  );
  record("findClaimableEvents(after completion)", terminal.ok
    ? terminal.value.map((event) => event.eventId)
    : { error: terminal.error.code });

  return said;
}
