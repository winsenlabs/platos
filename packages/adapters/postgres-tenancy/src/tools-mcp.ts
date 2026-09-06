// `EntityMcpConfig` and `EntityMcpClient` — Platos hosting a server, and Platos
// being a client of one.
//
// NEITHER ROW HAS AN `environmentId`. Both are keyed on `Entity.id` alone, and
// `Entity` hangs off a PROJECT rather than an environment. So a scope that
// merely resolves proves nothing about these two rows: without a second clause,
// any caller holding a valid scope of its own and somebody else's entity uuid
// could read or overwrite that entity's MCP surface. The tenant clause here is
// therefore `Entity.projectId = scope.projectId`, which is the narrowest true
// statement the schema supports.
//
// THE TWO READS FOLD IT IN AND THE TWO WRITES DO NOT, and the difference is the
// answer each owes. A read of a foreign entity must be indistinguishable from a
// read of an absent one — `null` either way, because telling a caller "that
// entity exists but is not yours" is the existence oracle the clause exists to
// close. A WRITE must refuse loudly, so it resolves the entity first and answers
// `entityNotInScope`, which no absent-entity path can produce.
//
// `credentialName` IS NOT A COLUMN AND IS NOT PERSISTED. `EntityMcpClient` holds
// a `credentialId`; the NAME is `Credential.name`, which `secrets` owns and this
// package only reads. A caller that passes a name is therefore passing something
// this store discards, and the record it gets back carries the name the
// credential actually has. That is not round-tripping and it is not meant to be:
// `resolveTransport` fails closed on a missing name, and a name the store
// believed over the credential's own would be a header built from a stale label.

import type {
  EntityId,
  EntityMcpClient,
  EntityMcpConfig,
  EnvironmentScope,
  Result,
} from "@platos/context-tools/application/ports/index.js";
import { entityNotInScope, err, ok } from "@platos/context-tools/application/ports/index.js";

import {
  toMcpClient,
  toMcpConfig,
  type McpClientRow,
  type McpConfigRow,
} from "./tools-rows.js";
import { inScope } from "./tools-scope.js";
import type { TenancyTransactions } from "./transaction.js";

export interface ToolsMcp {
  findMcpConfig(
    scope: EnvironmentScope,
    entityId: EntityId,
  ): Promise<Result<EntityMcpConfig | null>>;
  saveMcpConfig(scope: EnvironmentScope, config: EntityMcpConfig): Promise<Result<EntityMcpConfig>>;
  findMcpClient(
    scope: EnvironmentScope,
    entityId: EntityId,
  ): Promise<Result<EntityMcpClient | null>>;
  saveMcpClient(scope: EnvironmentScope, client: EntityMcpClient): Promise<Result<EntityMcpClient>>;
}

/**
 * The eleven columns `McpConfigRow` declares.
 *
 * WIN-258 T7. `findMcpConfig` is on the hosted MCP surface's REQUEST path — the
 * comment on `toolAllowlist` below says the column exists because that surface
 * reads it on every request — so an unprojected read there pays for the whole
 * row, `identityProviders` and `branding` deserialised, once per request. The
 * assertion `as McpConfigRow` is now a fact about the SELECT.
 */
const CONFIG_SELECT = {
  entityId: true,
  enabled: true,
  identityMode: true,
  identityProviders: true,
  branding: true,
  toolAllowlist: true,
  redirectUriAllowlist: true,
  rateLimitPerMinute: true,
  injectMcpContext: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The client row plus the credential name the record carries and it lacks. */
const CLIENT_SELECT = {
  entityId: true,
  transport: true,
  url: true,
  credentialId: true,
  headersTemplate: true,
  lastDiscoveryAt: true,
  discoveryError: true,
  createdAt: true,
  updatedAt: true,
  credential: { select: { name: true } },
} as const;

export function createToolsMcp(transactions: TenancyTransactions): ToolsMcp {
  /** The entity, if it is in this scope's project. One statement. */
  async function entityInScope(scope: EnvironmentScope, entityId: EntityId): Promise<boolean> {
    const row = await transactions.reader().entity.findFirst({
      where: { id: entityId, projectId: scope.projectId },
      select: { id: true },
    });
    return row !== null;
  }

  return {
    async findMcpConfig(scope, entityId) {
      return inScope(transactions, scope, "findMcpConfig", async () => {
        const row = (await transactions.reader().entityMcpConfig.findFirst({
          where: { entityId, entity: { projectId: scope.projectId } },
          select: CONFIG_SELECT,
        })) as McpConfigRow | null;
        return ok(row === null ? null : toMcpConfig(row));
      });
    },

    async saveMcpConfig(scope, config) {
      return inScope(transactions, scope, "saveMcpConfig", async () => {
        if (!(await entityInScope(scope, config.entityId))) {
          return err(entityNotInScope(config.entityId));
        }
        const mutable = {
          enabled: config.enabled,
          identityMode: config.identityMode,
          identityProviders: [...config.identityProviders] as never,
          branding: { ...config.branding } as never,
          // DERIVED, and written anyway. `domain/mcp-config.ts` calls this
          // column a projection of `EntityToolPolicy` and never the authority;
          // the column exists because the hosted surface reads it on every
          // request, and a store that refused to write it would leave the
          // projection permanently stale.
          toolAllowlist: [...config.toolAllowlist],
          redirectUriAllowlist: [...config.redirectUriAllowlist],
          rateLimitPerMinute: config.rateLimitPerMinute,
          injectMcpContext: config.injectMcpContext,
        };
        const row = (await transactions.atomic((client) =>
          client.entityMcpConfig.upsert({
            where: { entityId: config.entityId },
            create: { entityId: config.entityId, ...mutable },
            update: mutable,
          }),
        )) as McpConfigRow;
        return ok(toMcpConfig(row));
      });
    },

    async findMcpClient(scope, entityId) {
      return inScope(transactions, scope, "findMcpClient", async () => {
        const row = (await transactions.reader().entityMcpClient.findFirst({
          where: { entityId, entity: { projectId: scope.projectId } },
          select: CLIENT_SELECT,
        })) as McpClientRow | null;
        return ok(row === null ? null : toMcpClient(row));
      });
    },

    async saveMcpClient(scope, client) {
      return inScope(transactions, scope, "saveMcpClient", async () => {
        if (!(await entityInScope(scope, client.entityId))) {
          return err(entityNotInScope(client.entityId));
        }
        const mutable = {
          transport: client.transport,
          url: client.url,
          credentialId: client.credentialId,
          headersTemplate: { ...client.headersTemplate } as never,
          lastDiscoveryAt: client.lastDiscoveryAt,
          discoveryError: client.discoveryError,
        };
        const row = (await transactions.atomic((transaction) =>
          transaction.entityMcpClient.upsert({
            where: { entityId: client.entityId },
            create: { entityId: client.entityId, ...mutable },
            update: mutable,
            select: CLIENT_SELECT,
          }),
        )) as McpClientRow;
        return ok(toMcpClient(row));
      });
    },
  };
}
