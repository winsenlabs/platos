// The six rows, as they come back, and the aggregates they become.
//
// EVERY MAPPER RETURNS `Result`. A stored value the domain has no name for is a
// refusal here rather than a plausible substitute above: ADR M0.3's acceptance
// is explicit that a contract the database proves unhonourable must be reported,
// not invented, and a store that mapped an unknown `status` onto `PENDING` would
// silently re-queue a row an operator had discarded.
//
// THE SCOPE IS RESOLVED, NOT ASSUMED. `ChannelConnection` and `ChannelApp` carry
// an `EnvironmentScope` — three ids — and the tables hold ONE of them. The other
// two are in the tree, so each read joins the environment to its project and the
// project to its organization, and a row whose environment does not join up is
// refused rather than given a scope built from the caller's own claim. A scope
// echoed back from the request is not evidence of anything: it would make
// `findConnectionById`, whose whole purpose is to ESTABLISH a scope for the
// inbound path, answer with the scope it was never given.
//
// `credentialRevision` IS A PROJECTION AND NOT A COLUMN, and the domain says so:
// "a READ-TIME PROJECTION and not a column of this table — the repository joins
// the credential and reads its revision". `secrets` counts `secretRevision` up
// on `CredentialSecretVersion` when it rotates material in place, and that is
// the axis the refresh fence needs, because a rotation moves neither the
// credential's id nor this context's `tokenGeneration`. Zero when there is no
// credential: no credential has revision zero, so the placeholder cannot be
// mistaken for a real one.

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
  ChannelRoutingRule,
  ChannelThreadId,
  ChannelThreadKey,
  ChannelThreadLink,
  CredentialId,
  ExternalInstallationId,
  LeaseOwner,
  ProviderEventId,
  RefreshClaimId,
  Result,
  ThreadId,
  ThreadLinkOwner,
  TurnId,
} from "@platos/context-channels/application/ports/index.js";
import {
  asIdentifier,
  CHANNEL_EVENT_STATUSES,
  environmentScope,
  err,
  INSTALLATION_STATUSES,
  ok,
  REFRESH_STATES,
  repositoryUnavailable,
} from "@platos/context-channels/application/ports/index.js";

/** The stored `agentRouting` is not a JSON array. */
export const UNREADABLE_ROUTING = "unreadable_routing";

/** `ChannelInstallation.tokenRefreshState` holds a state this binary has no name for. */
export const UNREADABLE_REFRESH_STATE = "unreadable_refresh_state";

/** `ChannelInstallation.status` holds a status this binary has no name for. */
export const UNREADABLE_INSTALLATION_STATUS = "unreadable_installation_status";

/** `ChannelEventInbox.status` holds a status this binary has no name for. */
export const UNREADABLE_EVENT_STATUS = "unreadable_event_status";

/** The row's environment does not join through a project to an organization. */
export const UNRESOLVED_SCOPE_ANCESTRY = "unresolved_scope_ancestry";

function unreadable<Value>(code: string, detail: string): Result<Value> {
  return err(repositoryUnavailable(`${code}:${detail}`));
}

/**
 * The stored routing table, read TOTALLY.
 *
 * Lenient by design, and `domain/routing.ts` carries the argument: `resolveAgent`
 * runs on the inbound path against a column an older binary may have written,
 * and "dropping a customer's message over an unreadable rule is worse than
 * ignoring the rule". It re-checks every field of every rule at runtime, so this
 * hands the array over as it stands and does not re-validate it. Only the ROOT
 * is checked, because a non-array is not a table of rules a resolver can loop
 * over at all — and because that is the one shape the `_json_root` CHECK behind
 * the column also refuses.
 */
function readRouting(value: unknown, where: string): Result<readonly ChannelRoutingRule[]> {
  if (!Array.isArray(value)) return unreadable(UNREADABLE_ROUTING, where);
  return ok(value as readonly ChannelRoutingRule[]);
}

/** The ancestry a scoped row is read with: its environment's two parents. */
export interface RowAncestry {
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly organizationId: string | null;
}

function readScope(ancestry: RowAncestry, where: string) {
  if (ancestry.projectId === null || ancestry.organizationId === null) {
    return unreadable<ReturnType<typeof environmentScope>>(UNRESOLVED_SCOPE_ANCESTRY, where);
  }
  return ok(
    environmentScope(
      asIdentifier(ancestry.organizationId),
      asIdentifier(ancestry.projectId),
      asIdentifier(ancestry.environmentId),
    ),
  );
}

/** `ChannelConnection`, joined to the two parents of its environment. */
export interface ConnectionRow extends RowAncestry {
  readonly id: string;
  readonly entityId: string | null;
  readonly provider: string;
  readonly displayName: string | null;
  readonly defaultAgentId: string | null;
  readonly agentRouting: unknown;
  readonly enabled: boolean;
  readonly credentialId: string | null;
  readonly createdAt: Date;
}

export function readConnectionRow(row: ConnectionRow): Result<ChannelConnection> {
  const scope = readScope(row, `ChannelConnection/${row.id}`);
  if (!scope.ok) return err(scope.error);
  const routing = readRouting(row.agentRouting, `ChannelConnection/${row.id}`);
  if (!routing.ok) return err(routing.error);
  return ok({
    connectionId: asIdentifier<ChannelConnectionId>(row.id),
    scope: scope.value,
    entityId: row.entityId,
    // The column is plain TEXT with no CHECK, so an out-of-vocabulary provider
    // is reachable — and it is carried rather than refused, because the value
    // is the provider a live connection was created with and refusing the read
    // would take a working connection offline to punish a naming mistake. The
    // WRITE guard is where the vocabulary is enforced.
    provider: row.provider as ChannelConnection["provider"],
    displayName: row.displayName,
    defaultAgentId: row.defaultAgentId === null ? null : asIdentifier<AgentId>(row.defaultAgentId),
    agentRouting: routing.value,
    enabled: row.enabled,
    credentialId: row.credentialId === null ? null : asIdentifier<CredentialId>(row.credentialId),
    createdAt: row.createdAt,
  });
}

/** `ChannelApp`, joined the same way. */
export interface AppRow extends RowAncestry {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string | null;
  readonly clientId: string;
  readonly credentialId: string | null;
  readonly scopes: readonly string[] | null;
  readonly distribution: string;
  readonly defaultAgentId: string | null;
  readonly agentRouting: unknown;
  readonly createdAt: Date;
}

export function readAppRow(row: AppRow): Result<ChannelApp> {
  const scope = readScope(row, `ChannelApp/${row.id}`);
  if (!scope.ok) return err(scope.error);
  const routing = readRouting(row.agentRouting, `ChannelApp/${row.id}`);
  if (!routing.ok) return err(routing.error);
  return ok({
    appId: asIdentifier<ChannelAppId>(row.id),
    scope: scope.value,
    provider: row.provider as ChannelApp["provider"],
    displayName: row.displayName,
    clientId: row.clientId,
    credentialId: row.credentialId === null ? null : asIdentifier<CredentialId>(row.credentialId),
    // `scopes` is `TEXT[]` with a DEFAULT and NO `NOT NULL`, which the schema
    // does not say and the migration does. A row written by anything other than
    // this client can hold SQL NULL there, and the domain's field is a list.
    scopes: row.scopes ?? [],
    distribution: row.distribution as ChannelApp["distribution"],
    defaultAgentId: row.defaultAgentId === null ? null : asIdentifier<AgentId>(row.defaultAgentId),
    agentRouting: routing.value,
    createdAt: row.createdAt,
  });
}

/** `ChannelInstallation`, as the delegate selects it. */
export interface InstallationRow {
  readonly id: string;
  readonly appId: string;
  readonly externalInstallationId: string;
  readonly displayName: string | null;
  readonly credentialId: string | null;
  readonly grantedScopes: readonly string[] | null;
  readonly defaultAgentId: string | null;
  readonly agentRouting: unknown;
  readonly status: string;
  readonly revokedAt: Date | null;
  readonly lastEventAt: Date | null;
  readonly tokenRefreshState: string;
  readonly tokenRefreshClaimId: string | null;
  readonly tokenRefreshStartedAt: Date | null;
  readonly tokenRefreshRepairCode: string | null;
  readonly tokenGeneration: number;
  readonly createdAt: Date;
}

export function readInstallationRow(
  row: InstallationRow,
  credentialRevision: number,
): Result<ChannelInstallation> {
  const where = `ChannelInstallation/${row.id}`;
  if (!(INSTALLATION_STATUSES as readonly string[]).includes(row.status)) {
    return unreadable(UNREADABLE_INSTALLATION_STATUS, `${where}:${row.status}`);
  }
  if (!(REFRESH_STATES as readonly string[]).includes(row.tokenRefreshState)) {
    return unreadable(UNREADABLE_REFRESH_STATE, `${where}:${row.tokenRefreshState}`);
  }
  const routing = readRouting(row.agentRouting, where);
  if (!routing.ok) return err(routing.error);
  return ok({
    installationId: asIdentifier<ChannelInstallationId>(row.id),
    appId: asIdentifier<ChannelAppId>(row.appId),
    externalInstallationId: asIdentifier<ExternalInstallationId>(row.externalInstallationId),
    displayName: row.displayName,
    credentialId: row.credentialId === null ? null : asIdentifier<CredentialId>(row.credentialId),
    credentialRevision,
    grantedScopes: row.grantedScopes ?? [],
    defaultAgentId: row.defaultAgentId === null ? null : asIdentifier<AgentId>(row.defaultAgentId),
    agentRouting: routing.value,
    status: row.status as ChannelInstallation["status"],
    revokedAt: row.revokedAt,
    lastEventAt: row.lastEventAt,
    refreshState: row.tokenRefreshState as ChannelInstallation["refreshState"],
    refreshClaimId:
      row.tokenRefreshClaimId === null ? null : asIdentifier<RefreshClaimId>(row.tokenRefreshClaimId),
    refreshStartedAt: row.tokenRefreshStartedAt,
    refreshRepairCode: row.tokenRefreshRepairCode,
    tokenGeneration: row.tokenGeneration,
    createdAt: row.createdAt,
  });
}

/** `ChannelEventInbox`, as the delegate selects it. */
export interface EventRow {
  readonly id: string;
  readonly appId: string;
  readonly eventId: string;
  readonly payloadFormatVersion: number;
  readonly payloadKeyVersion: number;
  readonly encryptedPayload: string;
  readonly status: string;
  readonly retryCount: number;
  readonly availableAt: Date;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseGeneration: number;
  readonly turnId: string | null;
  readonly deliveryCompletedAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export function readEventRow(row: EventRow): Result<ChannelEvent> {
  if (!(CHANNEL_EVENT_STATUSES as readonly string[]).includes(row.status)) {
    return unreadable(UNREADABLE_EVENT_STATUS, `ChannelEventInbox/${row.id}:${row.status}`);
  }
  return ok({
    inboxId: asIdentifier<ChannelEventInboxId>(row.id),
    appId: asIdentifier<ChannelAppId>(row.appId),
    eventId: asIdentifier<ProviderEventId>(row.eventId),
    payload: {
      formatVersion: row.payloadFormatVersion,
      keyVersion: row.payloadKeyVersion,
      ciphertext: row.encryptedPayload,
    },
    status: row.status as ChannelEvent["status"],
    retryCount: row.retryCount,
    availableAt: row.availableAt,
    leaseOwner: row.leaseOwner === null ? null : asIdentifier<LeaseOwner>(row.leaseOwner),
    leaseExpiresAt: row.leaseExpiresAt,
    leaseGeneration: row.leaseGeneration,
    turnId: row.turnId === null ? null : asIdentifier<TurnId>(row.turnId),
    deliveryCompletedAt: row.deliveryCompletedAt,
    lastErrorCode: row.lastErrorCode,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  });
}

/** Either link table's row. The owner column is the only difference. */
export interface LinkRow {
  readonly id: string;
  readonly ownerId: string;
  readonly threadId: string;
  readonly channelThreadKey: string;
  readonly createdAt: Date;
}

/**
 * One link, in whichever of the two tables it lives.
 *
 * TWO TABLES, ONE VALUE, and `domain/thread-link.ts` chose the union over two
 * nullable columns so that "which kind of link is this?" is a compile-time
 * question. The owner KIND is therefore a parameter of the read rather than a
 * column: it is which table the row came out of, and no row can be ambiguous.
 */
export function readLinkRow(row: LinkRow, kind: ThreadLinkOwner["kind"]): ChannelThreadLink {
  const owner: ThreadLinkOwner =
    kind === "connection"
      ? { kind: "connection", connectionId: asIdentifier<ChannelConnectionId>(row.ownerId) }
      : { kind: "installation", installationId: asIdentifier<ChannelInstallationId>(row.ownerId) };
  return {
    linkId: asIdentifier<ChannelThreadId | ChannelAppThreadId>(row.id),
    owner,
    channelThreadKey: asIdentifier<ChannelThreadKey>(row.channelThreadKey),
    threadId: asIdentifier<ThreadId>(row.threadId),
    createdAt: row.createdAt,
  };
}
