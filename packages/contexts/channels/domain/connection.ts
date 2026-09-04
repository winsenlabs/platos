// `ChannelConnection` — one direct, environment-scoped connection to a channel
// provider, and `ChannelApp` — one OAuth-distributed application.
//
// They are modelled side by side because they are the two halves of the same
// capability and share the routing vocabulary, but they are NOT one type with
// nullable halves. A connection has a credential and no installations; an app
// has installations and its credential is the CLIENT's, not a workspace's. The
// fields that would have to become nullable to merge them (`clientId`,
// `distribution`, `entityId`, `enabled`) are exactly the ones every rule
// depends on being present.
//
// BOTH ARE ENVIRONMENT-SCOPED. `environmentId` is the tenancy leaf every row
// here is keyed by, and it is what `scopeOf` returns so a caller can check
// containment with the kernel's `contains` rather than comparing ids by hand.

import { err, ok, type Result, type EnvironmentScope } from "@platos/kernel";

import { connectionDisabled } from "./errors.js";
import type {
  AgentId,
  ChannelAppId,
  ChannelConnectionId,
  CredentialId,
} from "./identifiers.js";
import type { AppDistribution, AppProvider, ConnectionProvider } from "./provider.js";
import type { ChannelRoutingRule } from "./routing.js";

export interface ChannelConnection {
  readonly connectionId: ChannelConnectionId;
  readonly scope: EnvironmentScope;
  /**
   * The tenancy `Entity` this connection belongs to, when it belongs to one.
   * Nullable because a connection may be environment-wide; ADR M0.3 §7 decision
   * 6 fixes `Entity` as tenancy's structural leaf, so this is a REFERENCE and
   * this context never writes that row.
   */
  readonly entityId: string | null;
  readonly provider: ConnectionProvider;
  readonly displayName: string | null;
  readonly defaultAgentId: AgentId | null;
  readonly agentRouting: readonly ChannelRoutingRule[];
  readonly enabled: boolean;
  readonly credentialId: CredentialId | null;
  readonly createdAt: Date;
}

export interface ChannelApp {
  readonly appId: ChannelAppId;
  readonly scope: EnvironmentScope;
  readonly provider: AppProvider;
  readonly displayName: string | null;
  /** The provider's OAuth client id. Unique with environment + provider. */
  readonly clientId: string;
  readonly credentialId: CredentialId | null;
  readonly scopes: readonly string[];
  readonly distribution: AppDistribution;
  readonly defaultAgentId: AgentId | null;
  readonly agentRouting: readonly ChannelRoutingRule[];
  readonly createdAt: Date;
}

/**
 * The gate the inbound path passes through.
 *
 * `enabled` is an operator's kill switch, and it must be checked on the INBOUND
 * path rather than only at send time: a disabled connection that still accepts
 * events would keep spending turns while appearing switched off.
 *
 * ITS CALL SITE IS `application/channels-contract.ts::routingFor`, which is the
 * one place the inbound path loads the connection row. Naming it here is not
 * decoration: this function shipped with ZERO callers, so the sentence above
 * described an intention rather than a behaviour and the whole gate could be
 * deleted with the package green. If the grep for `assertEnabled` ever returns
 * only this file again, the kill switch is off.
 */
export function assertEnabled(connection: ChannelConnection): Result<ChannelConnection> {
  if (!connection.enabled) return err(connectionDisabled(connection.connectionId));
  return ok(connection);
}

export function connectionScope(connection: ChannelConnection): EnvironmentScope {
  return connection.scope;
}

export function appScope(app: ChannelApp): EnvironmentScope {
  return app.scope;
}

/**
 * The `[environmentId, provider, clientId]` unique, expressed in the domain.
 *
 * One environment may hold many apps for one provider — a private app and a
 * public one — but never two rows for the same OAuth client, because an
 * installation callback carries only the client id and could not be attributed.
 */
export function appIdentity(app: ChannelApp): string {
  return `${app.scope.environmentId}/${app.provider}/${app.clientId}`;
}
