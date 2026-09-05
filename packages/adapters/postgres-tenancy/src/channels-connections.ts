// `ChannelConnection` and `ChannelApp` — the two halves of the same capability,
// stored side by side and never merged.
//
// THE READS ARE ONE STATEMENT EACH, AND THEY ARE RAW FOR A REASON. Both
// aggregates carry an `EnvironmentScope`, which is three ids, and both tables
// hold one. The obvious spelling — `channelConnection.findUnique` selecting
// `environment: { projectId, project: { organizationId } }` — is THREE round
// trips, because the client loads each relation level as its own query. That is
// two extra round trips on every read of a port the inbound path calls before it
// can do anything at all. The SQL is a static tagged template with one
// interpolated VALUE, so it stays attributable to `scripts/arch/sole-writer.mjs`
// and names no table it does not read.
//
// THE SCOPED READ AND THE UNSCOPED ONE ARE SEPARATE METHODS, NOT ONE WITH AN
// OPTIONAL PARAMETER, and the port says why: "the two have different security
// properties and blurring them is how a scoped read silently becomes an unscoped
// one". They share this file and share nothing else — in particular the scoped
// form answers `null` for a row in another environment (reporting it as
// found-but-denied would confirm its existence to another tenant) while the
// unscoped form answers with the row AND the scope it resolved, which is the
// whole point of its existence on the inbound path.
//
// THE THIRD ANSWER IS THE ONE THE DOUBLE CANNOT HAVE. A scope whose environment
// matches but whose project or organization does not is not a miss and not a
// hit: it is a caller claiming an ancestry the tree does not agree with. The
// in-memory double compares one field and cannot see it; here it is
// `scope_ancestry_forged`, distinct from `unknown_environment`, so an operator
// can tell a re-parented environment from a fabricated claim without reading a
// message.
//
// THE WRITES RE-ASSERT THE ANCESTRY BEFORE THEY RUN. `saveConnection` takes no
// scope of its own — the scope is ON the value — so the ancestry check is what
// stops a caller persisting a row under an organization that does not own it.
// It is a second statement and it is worth it: the database's own
// `enforce_domain_ancestry` rule checks the environment, the entity, the agent
// and the credential, and checks NONE of the two parents this value claims.

import type {
  ChannelApp,
  ChannelAppId,
  ChannelConnection,
  ChannelConnectionId,
  EnvironmentScope,
  Result,
  TransactionScope,
} from "@platos/context-channels/application/ports/index.js";
import { err, ok, repositoryUnavailable } from "@platos/context-channels/application/ports/index.js";

import { jsonList } from "./client.js";
import type { AppRow, ConnectionRow } from "./channels-rows.js";
import { readAppRow, readConnectionRow } from "./channels-rows.js";
import {
  firstRefusal,
  guarded,
  requireAppProvider,
  requireConnectionProvider,
  requireDistribution,
  requireOptionalUuid,
  requireRoutingTable,
  requireTextList,
  requireUuid,
} from "./channels-guards.js";
import type { TenancyTransactions } from "./transaction.js";

/** The scope names an environment that does not exist at all. */
export const CHANNELS_SCOPE_UNKNOWN = "unknown_environment";

/** The scope names an environment that is not under the parents it claims. */
export const CHANNELS_SCOPE_FORGED = "scope_ancestry_forged";

export interface ChannelConnectionStore {
  findConnection(
    scope: EnvironmentScope,
    connectionId: ChannelConnectionId,
  ): Promise<Result<ChannelConnection | null>>;
  findConnectionById(connectionId: ChannelConnectionId): Promise<Result<ChannelConnection | null>>;
  saveConnection(
    connection: ChannelConnection,
    transaction: TransactionScope,
  ): Promise<Result<ChannelConnection>>;
  findApp(scope: EnvironmentScope, appId: ChannelAppId): Promise<Result<ChannelApp | null>>;
  findAppById(appId: ChannelAppId): Promise<Result<ChannelApp | null>>;
  saveApp(app: ChannelApp, transaction: TransactionScope): Promise<Result<ChannelApp>>;
}

export function createChannelConnectionStore(
  transactions: TenancyTransactions,
): ChannelConnectionStore {
  /** The ancestry of one environment, or a refusal naming which way it failed. */
  async function requireAncestry(
    operation: string,
    scope: EnvironmentScope,
  ): Promise<Result<true>> {
    const rows = await transactions.reader().$queryRaw<
      readonly { readonly projectId: string; readonly organizationId: string }[]
    >`
      SELECT environment."projectId" AS "projectId", project."organizationId" AS "organizationId"
      FROM "public"."Environment" environment
      JOIN "public"."Project" project ON project."id" = environment."projectId"
      WHERE environment."id" = ${scope.environmentId}::uuid`;
    const resolved = rows[0];
    if (resolved === undefined) {
      return err(repositoryUnavailable(`${operation}:${CHANNELS_SCOPE_UNKNOWN}`));
    }
    if (resolved.projectId !== scope.projectId || resolved.organizationId !== scope.organizationId) {
      return err(repositoryUnavailable(`${operation}:${CHANNELS_SCOPE_FORGED}`));
    }
    return ok(true);
  }

  /** The scoped half of a read, applied to a row already resolved from the tree. */
  function inRequestedScope<Value extends { readonly scope: EnvironmentScope }>(
    operation: string,
    scope: EnvironmentScope,
    value: Value,
  ): Result<Value | null> {
    if (value.scope.environmentId !== scope.environmentId) return ok(null);
    if (
      value.scope.projectId !== scope.projectId ||
      value.scope.organizationId !== scope.organizationId
    ) {
      return err(repositoryUnavailable(`${operation}:${CHANNELS_SCOPE_FORGED}`));
    }
    return ok(value);
  }

  async function loadConnection(
    operation: string,
    connectionId: ChannelConnectionId,
  ): Promise<Result<ChannelConnection | null>> {
    const malformed = requireUuid<ChannelConnection | null>(operation, "connectionId", connectionId);
    if (malformed !== null) return malformed;
    return guarded(operation, async () => {
      const rows = await transactions.reader().$queryRaw<readonly ConnectionRow[]>`
        SELECT connection."id", connection."environmentId", environment."projectId",
               project."organizationId", connection."entityId", connection."provider",
               connection."displayName", connection."defaultAgentId",
               connection."agentRouting", connection."enabled", connection."credentialId",
               connection."createdAt"
        FROM "public"."ChannelConnection" connection
        JOIN "public"."Environment" environment ON environment."id" = connection."environmentId"
        JOIN "public"."Project" project ON project."id" = environment."projectId"
        WHERE connection."id" = ${connectionId}::uuid`;
      const row = rows[0];
      if (row === undefined) return ok(null);
      const read = readConnectionRow(row);
      return read.ok ? ok(read.value) : err(read.error);
    });
  }

  async function loadApp(
    operation: string,
    appId: ChannelAppId,
  ): Promise<Result<ChannelApp | null>> {
    const malformed = requireUuid<ChannelApp | null>(operation, "appId", appId);
    if (malformed !== null) return malformed;
    return guarded(operation, async () => {
      const rows = await transactions.reader().$queryRaw<readonly AppRow[]>`
        SELECT app."id", app."environmentId", environment."projectId",
               project."organizationId", app."provider", app."displayName", app."clientId",
               app."credentialId", app."scopes", app."distribution", app."defaultAgentId",
               app."agentRouting", app."createdAt"
        FROM "public"."ChannelApp" app
        JOIN "public"."Environment" environment ON environment."id" = app."environmentId"
        JOIN "public"."Project" project ON project."id" = environment."projectId"
        WHERE app."id" = ${appId}::uuid`;
      const row = rows[0];
      if (row === undefined) return ok(null);
      const read = readAppRow(row);
      return read.ok ? ok(read.value) : err(read.error);
    });
  }

  return {
    async findConnection(scope, connectionId) {
      const found = await loadConnection("findConnection", connectionId);
      if (!found.ok || found.value === null) return found;
      return inRequestedScope("findConnection", scope, found.value);
    },

    findConnectionById(connectionId) {
      return loadConnection("findConnectionById", connectionId);
    },

    async saveConnection(connection, transaction) {
      const operation = "saveConnection";
      const checked = firstRefusal(connection, [
        requireUuid<ChannelConnection>(operation, "connectionId", connection.connectionId),
        requireUuid<ChannelConnection>(operation, "environmentId", connection.scope.environmentId),
        requireOptionalUuid<ChannelConnection>(operation, "entityId", connection.entityId),
        requireOptionalUuid<ChannelConnection>(operation, "defaultAgentId", connection.defaultAgentId),
        requireOptionalUuid<ChannelConnection>(operation, "credentialId", connection.credentialId),
        requireConnectionProvider<ChannelConnection>(operation, connection.provider),
        requireRoutingTable<ChannelConnection>(operation, connection.agentRouting),
      ]);
      if (!checked.ok) return checked;

      const ancestry = await requireAncestry(operation, connection.scope);
      if (!ancestry.ok) return err(ancestry.error);

      return guarded(operation, async () => {
        const written = await transactions.writer(transaction).channelConnection.upsert({
          where: { id: connection.connectionId },
          create: {
            id: connection.connectionId,
            environmentId: connection.scope.environmentId,
            entityId: connection.entityId,
            provider: connection.provider,
            displayName: connection.displayName,
            defaultAgentId: connection.defaultAgentId,
            agentRouting: jsonList(connection.agentRouting),
            enabled: connection.enabled,
            credentialId: connection.credentialId,
            createdAt: connection.createdAt,
          },
          update: {
            // `environmentId` IS in the update branch, and it is the one column
            // here that cannot change. The database's own owner rule refuses a
            // move with SQLSTATE 23514, so writing it is what turns a re-parent
            // into a refusal the caller sees. Omitting it would make the move
            // silently a no-op — the caller would be told the row now lives
            // somewhere it does not.
            environmentId: connection.scope.environmentId,
            entityId: connection.entityId,
            provider: connection.provider,
            displayName: connection.displayName,
            defaultAgentId: connection.defaultAgentId,
            agentRouting: jsonList(connection.agentRouting),
            enabled: connection.enabled,
            credentialId: connection.credentialId,
          },
          select: { id: true },
        });
        return ok({ ...connection, connectionId: written.id as ChannelConnectionId });
      });
    },

    async findApp(scope, appId) {
      const found = await loadApp("findApp", appId);
      if (!found.ok || found.value === null) return found;
      return inRequestedScope("findApp", scope, found.value);
    },

    findAppById(appId) {
      return loadApp("findAppById", appId);
    },

    async saveApp(app, transaction) {
      const operation = "saveApp";
      const checked = firstRefusal(app, [
        requireUuid<ChannelApp>(operation, "appId", app.appId),
        requireUuid<ChannelApp>(operation, "environmentId", app.scope.environmentId),
        requireOptionalUuid<ChannelApp>(operation, "credentialId", app.credentialId),
        requireOptionalUuid<ChannelApp>(operation, "defaultAgentId", app.defaultAgentId),
        requireAppProvider<ChannelApp>(operation, app.provider),
        requireDistribution<ChannelApp>(operation, app.distribution),
        requireTextList<ChannelApp>(operation, "scopes", app.scopes),
        requireRoutingTable<ChannelApp>(operation, app.agentRouting),
      ]);
      if (!checked.ok) return checked;

      const ancestry = await requireAncestry(operation, app.scope);
      if (!ancestry.ok) return err(ancestry.error);

      return guarded(operation, async () => {
        const written = await transactions.writer(transaction).channelApp.upsert({
          where: { id: app.appId },
          create: {
            id: app.appId,
            environmentId: app.scope.environmentId,
            provider: app.provider,
            displayName: app.displayName,
            clientId: app.clientId,
            credentialId: app.credentialId,
            scopes: [...app.scopes],
            distribution: app.distribution,
            defaultAgentId: app.defaultAgentId,
            agentRouting: jsonList(app.agentRouting),
            createdAt: app.createdAt,
          },
          update: {
            environmentId: app.scope.environmentId,
            provider: app.provider,
            displayName: app.displayName,
            clientId: app.clientId,
            credentialId: app.credentialId,
            scopes: [...app.scopes],
            distribution: app.distribution,
            defaultAgentId: app.defaultAgentId,
            agentRouting: jsonList(app.agentRouting),
          },
          select: { id: true },
        });
        return ok({ ...app, appId: written.id as ChannelAppId });
      });
    },
  };
}
