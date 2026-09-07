// The database rules NO port method restates, and the two projections that are
// facts about the tree rather than about this context.
//
// WHAT MAKES A CASE BELONG HERE. The constraints suite pairs a guard with the
// constraint behind it. These are the other direction: properties the store
// depends on and does not implement — an owner column the database refuses to
// move, an ancestry rule that fires on UPDATE as well as INSERT, a payload the
// database will not let an UPDATE touch, a unique nobody wrote a guard for — plus
// the one number this port carries that no column of its own holds.
//
// EVERY ONE OF THEM LIVES ONLY IN THE MIGRATIONS. `schema.prisma` declares the
// six models and none of these rules; a reader who took the schema file as the
// specification would have written a store that fails on its first lease renewal
// and silently re-parents a connection on its first edit.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentId,
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
  LeaseOwner,
  ProviderEventId,
  ThreadId,
  TurnId,
} from "@platos/context-channels/application/ports/index.js";
import { asIdentifier, connectionOwner, environmentScope } from "@platos/context-channels/application/ports/index.js";
import { runResult } from "@platos/context-channels/application/ports/index.js";

import { CONFORMANCE_AT } from "./channels-conformance.js";
import type { ChannelsHarness, SeededThread } from "./channels-harness.js";
import { startChannelsHarness } from "./channels-harness.js";

let harness: ChannelsHarness;
let scope: EnvironmentScope;
let otherScope: EnvironmentScope;
let agentId: string;
let otherAgentId: string;
let thread: SeededThread;
let otherThread: SeededThread;
let turnId: string;
let secondTurnId: string;
let appId: ChannelAppId;

beforeAll(async () => {
  harness = await startChannelsHarness();
  scope = await harness.freshScope();
  otherScope = await harness.freshScope();
  agentId = await harness.seedAgent(scope);
  otherAgentId = await harness.seedAgent(otherScope);
  thread = await harness.seedThread(scope);
  otherThread = await harness.seedThread(otherScope);
  turnId = await harness.seedTurn(thread);
  secondTurnId = await harness.seedTurn(thread);
  appId = asIdentifier<ChannelAppId>(harness.base.freshId("0401"));
  await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.repository.saveApp(
      {
        appId,
        scope,
        provider: "slack",
        displayName: null,
        clientId: "client-rules",
        credentialId: null,
        scopes: [],
        distribution: "private",
        defaultAgentId: null,
        agentRouting: [],
        createdAt: CONFORMANCE_AT,
      } satisfies ChannelApp,
      transaction,
    ),
  );
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

function reasonOf(result: { readonly ok: boolean; readonly error?: unknown }): string | null {
  if (result.ok) return null;
  const error = result.error as { readonly details?: { readonly reason?: string } };
  return error.details?.reason ?? "";
}

function write<Value>(work: (transaction: never) => Promise<Value>): Promise<Value> {
  return harness.base.adapter.unitOfWork.run(work as never);
}

function connectionIn(
  where: EnvironmentScope,
  id: ChannelConnectionId,
  overrides: Partial<ChannelConnection> = {},
): ChannelConnection {
  return {
    connectionId: id,
    scope: where,
    entityId: null,
    provider: "slack",
    displayName: null,
    defaultAgentId: null,
    agentRouting: [],
    enabled: true,
    credentialId: null,
    createdAt: CONFORMANCE_AT,
    ...overrides,
  };
}

function eventFor(
  id: ChannelEventInboxId,
  eventId: string,
  overrides: Partial<ChannelEvent> = {},
): ChannelEvent {
  return {
    inboxId: id,
    appId,
    eventId: asIdentifier<ProviderEventId>(eventId),
    payload: { formatVersion: 1, keyVersion: 1, ciphertext: "admitted" },
    status: "PENDING",
    retryCount: 0,
    availableAt: CONFORMANCE_AT,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseGeneration: 0,
    turnId: null,
    deliveryCompletedAt: null,
    lastErrorCode: null,
    completedAt: null,
    createdAt: CONFORMANCE_AT,
    ...overrides,
  };
}

describe("the inbox row whose identity and payload SQL will not move", () => {
  test("an UPDATE that touches the ciphertext is refused by the database itself", async () => {
    const inboxId = asIdentifier<ChannelEventInboxId>(harness.base.freshId("0402"));
    await write((transaction) =>
      harness.repository.insertEvent(eventFor(inboxId, "Ev-immutable"), transaction),
    );
    let refusal = "";
    try {
      harness.applyPeerRows(
        `UPDATE "ChannelEventInbox" SET "encryptedPayload" = 'tampered' WHERE "id" = '${inboxId}';`,
      );
    } catch (error) {
      const shown = error as { readonly stdout?: unknown; readonly stderr?: unknown };
      refusal = `${String(shown.stdout ?? "")}${String(shown.stderr ?? "")}`;
    }
    expect(refusal).toContain("ChannelEventInbox identity and payload are immutable");
  });

  test("saveEvent advances the row and leaves the admitted ciphertext in place", async () => {
    // THE STORE'S OWN OMISSION, measured. The update branch of `saveEvent`
    // carries no identity and no payload, because the database refuses to move
    // either — a store that wrote them would take SQLSTATE 23514 on the FIRST
    // lease renewal of every event, not on some exotic path.
    const inboxId = asIdentifier<ChannelEventInboxId>(harness.base.freshId("0403"));
    await write((transaction) =>
      harness.repository.insertEvent(eventFor(inboxId, "Ev-payload"), transaction),
    );
    const saved = await write((transaction) =>
      harness.repository.saveEvent(
        eventFor(inboxId, "Ev-payload", {
          status: "PROCESSING",
          retryCount: 1,
          leaseOwner: asIdentifier<LeaseOwner>("worker-rules"),
          leaseExpiresAt: new Date(CONFORMANCE_AT.getTime() + 60_000),
          leaseGeneration: 1,
          payload: { formatVersion: 9, keyVersion: 9, ciphertext: "rewritten" },
        }),
        transaction,
      ),
    );
    expect(saved.ok).toBe(true);
    const read = await harness.repository.findEvent(inboxId);
    expect(read.ok && read.value?.status).toBe("PROCESSING");
    expect(read.ok && read.value?.payload).toEqual({
      formatVersion: 1,
      keyVersion: 1,
      ciphertext: "admitted",
    });
  });

  test("the turn a row points at is unique across the WHOLE table", async () => {
    // The double has no such index and takes the second row silently, which is
    // why this refusal has its own code rather than sharing the duplicate one.
    const first = asIdentifier<ChannelEventInboxId>(harness.base.freshId("0404"));
    const second = asIdentifier<ChannelEventInboxId>(harness.base.freshId("0405"));
    await write((transaction) =>
      harness.repository.insertEvent(
        eventFor(first, "Ev-turn-1", { turnId: asIdentifier<TurnId>(turnId) }),
        transaction,
      ),
    );
    const collided = await write((transaction) =>
      harness.repository.insertEvent(
        eventFor(second, "Ev-turn-2", { turnId: asIdentifier<TurnId>(turnId) }),
        transaction,
      ),
    );
    expect(reasonOf(collided)).toContain("turn_already_linked");
    const other = await write((transaction) =>
      harness.repository.insertEvent(
        eventFor(second, "Ev-turn-2", { turnId: asIdentifier<TurnId>(secondTurnId) }),
        transaction,
      ),
    );
    expect(other.ok).toBe(true);
  });
});

describe("the ownership and ancestry rules that fire on UPDATE", () => {
  test("a connection cannot be moved to another environment, and does not move", async () => {
    const id = asIdentifier<ChannelConnectionId>(harness.base.freshId("0406"));
    await write((transaction) =>
      harness.repository.saveConnection(connectionIn(scope, id), transaction),
    );
    const moved = await write((transaction) =>
      harness.repository.saveConnection(connectionIn(otherScope, id), transaction),
    );
    expect(moved.ok).toBe(false);
    const still = await harness.repository.findConnection(scope, id);
    expect(still.ok && still.value?.scope.environmentId).toBe(scope.environmentId);
  });

  test("the ancestry rule refuses an agent from another project on an UPDATE", async () => {
    // FIRES ON UPDATE, not only on INSERT. A store that checked its foreign keys
    // once at creation would let an edit point a live connection at an agent no
    // caller in this environment can reach.
    const id = asIdentifier<ChannelConnectionId>(harness.base.freshId("0407"));
    await write((transaction) =>
      harness.repository.saveConnection(
        connectionIn(scope, id, { defaultAgentId: asIdentifier<AgentId>(agentId) }),
        transaction,
      ),
    );
    const crossed = await write((transaction) =>
      harness.repository.saveConnection(
        connectionIn(scope, id, { defaultAgentId: asIdentifier<AgentId>(otherAgentId) }),
        transaction,
      ),
    );
    expect(crossed.ok).toBe(false);
    const still = await harness.repository.findConnection(scope, id);
    expect(still.ok && still.value?.defaultAgentId).toBe(agentId);
  });

  test("a link may not point at a thread outside its connection's environment", async () => {
    const id = asIdentifier<ChannelConnectionId>(harness.base.freshId("0408"));
    await write((transaction) =>
      harness.repository.saveConnection(connectionIn(scope, id), transaction),
    );
    const crossed = await write((transaction) =>
      harness.repository.insertThreadLink(
        {
          linkId: asIdentifier<ChannelThreadId>(harness.base.freshId("0409")),
          owner: connectionOwner(id),
          channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C0X:1.0"),
          threadId: asIdentifier<ThreadId>(otherThread.threadId),
          createdAt: CONFORMANCE_AT,
        },
        transaction,
      ),
    );
    expect(crossed.ok).toBe(false);
    const absent = await harness.repository.findThreadLink(
      connectionOwner(id),
      asIdentifier<ChannelThreadKey>("channel:C0X:1.0"),
    );
    expect(absent.ok && absent.value).toBeNull();
  });
});

describe("the scope answers the in-memory double cannot give", () => {
  test("an environment that does not exist is a different refusal from one that is not yours", async () => {
    const unknown = environmentScope(
      scope.organizationId,
      scope.projectId,
      asIdentifier(harness.base.freshId("040a")),
    );
    const refusedUnknown = await write((transaction) =>
      harness.repository.saveConnection(
        connectionIn(unknown, asIdentifier<ChannelConnectionId>(harness.base.freshId("040b"))),
        transaction,
      ),
    );
    expect(reasonOf(refusedUnknown)).toContain("unknown_environment");

    const forged = environmentScope(
      otherScope.organizationId,
      otherScope.projectId,
      scope.environmentId,
    );
    const refusedForged = await write((transaction) =>
      harness.repository.saveConnection(
        connectionIn(forged, asIdentifier<ChannelConnectionId>(harness.base.freshId("040c"))),
        transaction,
      ),
    );
    expect(reasonOf(refusedForged)).toContain("scope_ancestry_forged");
  });

  test("a read whose scope claims the wrong parents is refused, not answered null", async () => {
    // A ROW IN ANOTHER ENVIRONMENT IS INVISIBLE; a scope that names THIS
    // environment under someone else's project is a forgery, and answering null
    // would tell a caller its claim was merely empty.
    const id = asIdentifier<ChannelConnectionId>(harness.base.freshId("040d"));
    await write((transaction) =>
      harness.repository.saveConnection(connectionIn(scope, id), transaction),
    );
    const forged = environmentScope(
      otherScope.organizationId,
      otherScope.projectId,
      scope.environmentId,
    );
    const refused = await harness.repository.findConnection(forged, id);
    expect(reasonOf(refused)).toContain("scope_ancestry_forged");
    const invisible = await harness.repository.findConnection(otherScope, id);
    expect(invisible.ok && invisible.value).toBeNull();
  });
});

describe("the revision this port carries and this table has no column for", () => {
  test("the projection answers with the credential's number, not the caller's", async () => {
    const credentialId = await harness.seedCredential(scope, { secretRevision: 9 });
    const installationId = asIdentifier<ChannelInstallationId>(harness.base.freshId("040e"));
    const base: ChannelInstallation = {
      installationId,
      appId,
      externalInstallationId: asIdentifier<ExternalInstallationId>("T-REV"),
      displayName: null,
      credentialId: asIdentifier<CredentialId>(credentialId),
      // THE LIE, stated by the caller. There is nowhere to put it.
      credentialRevision: 2,
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
    const saved = await write((transaction) =>
      harness.repository.saveInstallation(base, transaction),
    );
    expect(saved.ok && saved.value.credentialRevision).toBe(9);
    const read = await harness.repository.findInstallation(installationId);
    expect(read.ok && read.value?.credentialRevision).toBe(9);
  });

  test("a credential with no active material projects zero, and so does no credential", async () => {
    const bare = await harness.seedCredential(scope, { withoutSecretVersion: true });
    const withMaterial = asIdentifier<ChannelInstallationId>(harness.base.freshId("040f"));
    const withoutAny = asIdentifier<ChannelInstallationId>(harness.base.freshId("0410"));
    const shape = (
      id: ChannelInstallationId,
      credentialId: string | null,
      external: string,
    ): ChannelInstallation => ({
      installationId: id,
      appId,
      externalInstallationId: asIdentifier<ExternalInstallationId>(external),
      displayName: null,
      credentialId: credentialId === null ? null : asIdentifier<CredentialId>(credentialId),
      credentialRevision: 5,
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
    });
    await write((transaction) =>
      harness.repository.saveInstallation(shape(withMaterial, bare, "T-BARE"), transaction),
    );
    await write((transaction) =>
      harness.repository.saveInstallation(shape(withoutAny, null, "T-NONE"), transaction),
    );
    const bareRead = await harness.repository.findInstallation(withMaterial);
    const noneRead = await harness.repository.findInstallation(withoutAny);
    // Zero is right in both cases and for the same reason: there is nothing
    // whose replacement a refresh claim could be holding.
    expect(bareRead.ok && bareRead.value?.credentialRevision).toBe(0);
    expect(noneRead.ok && noneRead.value?.credentialRevision).toBe(0);
  });
});
