// Aggregate -> published view.
//
// The mapping is explicit and one-directional. A caller outside this context
// sees a view; it never sees an aggregate, and there is no function here that
// turns a view back into one. That asymmetry is the point: a view is a snapshot
// for reading, and letting one round-trip into a domain object would let a
// transport reconstruct an aggregate that skipped every rule that mints one.
//
// WHAT IS DELIBERATELY NOT ON A VIEW:
//
//   `credentialId`     a pointer into `secrets`. Nothing outside needs it, and
//                      publishing it invites a caller to try to resolve it.
//   `payload`          the sealed inbox body. It is encrypted for a reason.
//   `leaseOwner`       operational detail of a worker, not of the event.
//   `refreshClaimId`   the fence's private token; publishing it would let a
//                      caller forge a claim.
//
// `agentRouting` IS published, unredacted. It is configuration, not secret —
// the management surface returns it as written so an operator can read back
// exactly what they saved.

import type {
  ChannelApp,
  ChannelConnection,
  ChannelEvent,
  ChannelInstallation,
  ChannelRoutingRule,
  ChannelThreadLink,
} from "../domain/index.js";

export interface ChannelConnectionView {
  readonly connectionId: string;
  readonly environmentId: string;
  readonly entityId: string | null;
  readonly provider: string;
  readonly displayName: string | null;
  readonly defaultAgentId: string | null;
  readonly agentRouting: readonly ChannelRoutingRule[];
  readonly enabled: boolean;
  /** Whether a credential is attached — never WHICH one. */
  readonly connected: boolean;
  readonly createdAt: Date;
}

export interface ChannelAppView {
  readonly appId: string;
  readonly environmentId: string;
  readonly provider: string;
  readonly displayName: string | null;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly distribution: string;
  readonly defaultAgentId: string | null;
  readonly agentRouting: readonly ChannelRoutingRule[];
  readonly createdAt: Date;
}

export interface ChannelInstallationView {
  readonly installationId: string;
  readonly appId: string;
  readonly externalInstallationId: string;
  readonly displayName: string | null;
  readonly grantedScopes: readonly string[];
  readonly defaultAgentId: string | null;
  readonly agentRouting: readonly ChannelRoutingRule[];
  readonly status: string;
  readonly revokedAt: Date | null;
  readonly lastEventAt: Date | null;
  /**
   * The refresh STATE is published but the claim id is not. An operator must be
   * able to see that an installation needs re-authorization; nobody outside
   * needs the token that would let them settle someone else's refresh.
   */
  readonly refreshState: string;
  readonly refreshRepairCode: string | null;
  readonly tokenGeneration: number;
  readonly createdAt: Date;
}

export interface ChannelThreadLinkView {
  readonly linkId: string;
  readonly owner: string;
  readonly channelThreadKey: string;
  readonly threadId: string;
  readonly createdAt: Date;
}

export interface ChannelEventView {
  readonly inboxId: string;
  readonly appId: string;
  readonly eventId: string;
  readonly status: string;
  readonly retryCount: number;
  readonly availableAt: Date;
  readonly turnId: string | null;
  readonly lastErrorCode: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export function toConnectionView(connection: ChannelConnection): ChannelConnectionView {
  return {
    connectionId: connection.connectionId,
    environmentId: connection.scope.environmentId,
    entityId: connection.entityId,
    provider: connection.provider,
    displayName: connection.displayName,
    defaultAgentId: connection.defaultAgentId,
    agentRouting: connection.agentRouting,
    enabled: connection.enabled,
    connected: connection.credentialId !== null,
    createdAt: connection.createdAt,
  };
}

export function toAppView(app: ChannelApp): ChannelAppView {
  return {
    appId: app.appId,
    environmentId: app.scope.environmentId,
    provider: app.provider,
    displayName: app.displayName,
    clientId: app.clientId,
    scopes: app.scopes,
    distribution: app.distribution,
    defaultAgentId: app.defaultAgentId,
    agentRouting: app.agentRouting,
    createdAt: app.createdAt,
  };
}

export function toInstallationView(installation: ChannelInstallation): ChannelInstallationView {
  return {
    installationId: installation.installationId,
    appId: installation.appId,
    externalInstallationId: installation.externalInstallationId,
    displayName: installation.displayName,
    grantedScopes: installation.grantedScopes,
    defaultAgentId: installation.defaultAgentId,
    agentRouting: installation.agentRouting,
    status: installation.status,
    revokedAt: installation.revokedAt,
    lastEventAt: installation.lastEventAt,
    refreshState: installation.refreshState,
    refreshRepairCode: installation.refreshRepairCode,
    tokenGeneration: installation.tokenGeneration,
    createdAt: installation.createdAt,
  };
}

export function toThreadLinkView(link: ChannelThreadLink): ChannelThreadLinkView {
  return {
    linkId: link.linkId,
    owner: link.owner.kind === "connection" ? link.owner.connectionId : link.owner.installationId,
    channelThreadKey: link.channelThreadKey,
    threadId: link.threadId,
    createdAt: link.createdAt,
  };
}

export function toEventView(event: ChannelEvent): ChannelEventView {
  return {
    inboxId: event.inboxId,
    appId: event.appId,
    eventId: event.eventId,
    status: event.status,
    retryCount: event.retryCount,
    availableAt: event.availableAt,
    turnId: event.turnId,
    lastErrorCode: event.lastErrorCode,
    completedAt: event.completedAt,
    createdAt: event.createdAt,
  };
}
