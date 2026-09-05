// `EnvironmentEntityTool` — the dispatch matrix, read four ways and written two.
//
// THE FOLD IS DONE ONCE PER CALL AND NOT ONCE PER ROW. Every exposure carries
// `allowedAgentIds`, which is a fold over the ENVIRONMENT's whole binding set.
// Reading the bindings inside the row loop would be an N+1 that no assertion on
// a returned value can see — every value would be right — so the bindings are
// read once, before the rows, and `allowedAgentIds` (the domain rule, not a copy
// of it) is applied to the set that is already in hand.
//
// THE ORDER IS APPLIED TWICE, AND THAT IS DELIBERATE. `pageExposures` must order
// in SQL, because a page taken with `skip`/`take` over an unordered set drops and
// repeats rows; every listing then has `byExposureOrder` applied to the rows it
// got back, because PostgreSQL orders text by the database's collation and
// JavaScript orders it by UTF-16 code unit, and the shared conformance
// transcript compares the two stores' orders literally. For the ASCII tool names
// the registry admits the two agree; where they would not, the second sort is
// what makes this store answer the same question as the double. It is recorded
// here rather than assumed: a page BOUNDARY is still decided by the collation,
// so a fixture whose names differ only in case or punctuation could still page
// differently, and that is a limit of this implementation and not of the port.
//
// `replaceExposures` IS ONE TRANSACTION OR NONE. It deletes what the entity no
// longer declares and writes what it does, and the port's own words are "One
// transaction, or none." `tools-transaction.integration.test.ts` makes the
// second write fail against a real database and then looks for the first
// through a connection that is not the writer's.

import type {
  AgentPolicyBinding,
  EntityId,
  EnvironmentScope,
  ExposureId,
  ExposurePage,
  ExposurePageQuery,
  ExposureReplacement,
  Result,
  ToolExposure,
  ToolId,
} from "@platos/context-tools/application/ports/index.js";
import {
  allowedAgentIds,
  asToolsIdentifier,
  byExposureOrder,
  err,
  exposureNotFound,
  ok,
} from "@platos/context-tools/application/ports/index.js";

import type { TenancyReader } from "./client.js";
import type { ToolsCatalogue } from "./tools-catalogue.js";
import type { ExposureRow } from "./tools-rows.js";
import { toExposure } from "./tools-rows.js";
import { inScope } from "./tools-scope.js";
import type { TenancyTransactions } from "./transaction.js";

export interface ToolsExposures {
  listExposures(scope: EnvironmentScope): Promise<Result<readonly ToolExposure[]>>;
  listEntityExposures(
    scope: EnvironmentScope,
    entityId: EntityId,
  ): Promise<Result<readonly ToolExposure[]>>;
  pageExposures(scope: EnvironmentScope, query: ExposurePageQuery): Promise<Result<ExposurePage>>;
  replaceExposures(replacement: ExposureReplacement): Promise<Result<readonly ToolExposure[]>>;
  setExposureEnabled(
    scope: EnvironmentScope,
    exposureId: ExposureId,
    enabled: boolean,
  ): Promise<Result<ToolExposure>>;
}

/** Everything a resolved exposure needs, in one selection. */
const EXPOSURE_SELECT = {
  id: true,
  environmentId: true,
  entityId: true,
  enabled: true,
  callbackUrl: true,
  tool: {
    select: {
      id: true,
      name: true,
      description: true,
      kind: true,
      paramSchema: true,
      category: true,
      schemaHash: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  entity: {
    select: {
      externalId: true,
      connectionKind: true,
      // EXISTENCE, not content. `dispatchabilityOf` asks whether there is a
      // client row at all, so selecting the key is the whole question.
      mcpClient: { select: { entityId: true } },
      mcpConfig: { select: { injectMcpContext: true } },
    },
  },
} as const;

/** Tool name, then the entity that offers it, then the version. Total. */
const EXPOSURE_ORDER = [
  { tool: { name: "asc" } },
  { entity: { externalId: "asc" } },
  { toolId: "asc" },
] as const;

function resolve(
  rows: readonly ExposureRow[],
  bindings: readonly AgentPolicyBinding[],
): ToolExposure[] {
  return rows.map((row) =>
    toExposure(row, allowedAgentIds(bindings, asToolsIdentifier<ToolId>(row.tool.id))),
  );
}

export function createToolsExposures(
  transactions: TenancyTransactions,
  catalogue: ToolsCatalogue,
): ToolsExposures {
  /** The bindings, or an empty fold when the scope has none. */
  async function foldBindings(scope: EnvironmentScope): Promise<readonly AgentPolicyBinding[]> {
    const bindings = await catalogue.listAgentPolicyBindings(scope);
    return bindings.ok ? bindings.value : [];
  }

  async function readExposures(
    reader: TenancyReader,
    where: Readonly<Record<string, unknown>>,
    page?: { readonly skip: number; readonly take: number },
  ): Promise<readonly ExposureRow[]> {
    return reader.environmentEntityTool.findMany({
      where,
      select: EXPOSURE_SELECT,
      orderBy: [...EXPOSURE_ORDER],
      ...(page ?? {}),
    }) as unknown as Promise<readonly ExposureRow[]>;
  }

  return {
    async listExposures(scope) {
      return inScope(transactions, scope, "listExposures", async () => {
        const bindings = await foldBindings(scope);
        const rows = await readExposures(transactions.reader(), {
          environmentId: scope.environmentId,
        });
        return ok(resolve(rows, bindings).sort(byExposureOrder));
      });
    },

    async listEntityExposures(scope, entityId) {
      return inScope(transactions, scope, "listEntityExposures", async () => {
        const bindings = await foldBindings(scope);
        const rows = await readExposures(transactions.reader(), {
          environmentId: scope.environmentId,
          entityId,
        });
        return ok(resolve(rows, bindings).sort(byExposureOrder));
      });
    },

    async pageExposures(scope, query) {
      return inScope(transactions, scope, "pageExposures", async () => {
        const where = {
          environmentId: scope.environmentId,
          ...(query.entityId === null || query.entityId === undefined
            ? {}
            : { entityId: query.entityId }),
          ...(query.search === null || query.search === undefined
            ? {}
            : { tool: { name: { contains: query.search, mode: "insensitive" as const } } }),
        };
        const reader = transactions.reader();
        // THE TOTAL IS THE SET THE PAGE WAS DRAWN FROM, so it is counted under
        // the same `where` and never under the page's own window.
        const total = await reader.environmentEntityTool.count({ where });
        const rows = await readExposures(reader, where, {
          skip: query.offset,
          take: query.limit,
        });
        const bindings = await foldBindings(scope);
        return ok({ items: resolve(rows, bindings).sort(byExposureOrder), total });
      });
    },

    async replaceExposures(replacement) {
      const scope = replacement.scope;
      return inScope(transactions, scope, "replaceExposures", async () => {
        const wanted = [...replacement.toolIds];
        await transactions.atomic(async (client) => {
          // ANYTHING ABSENT IS DELETED, which the port calls "the point". The
          // delete runs FIRST so a re-registration that drops a tool and adds
          // another cannot transiently hold both.
          await client.environmentEntityTool.deleteMany({
            where: {
              environmentId: scope.environmentId,
              entityId: replacement.entityId,
              toolId: { notIn: wanted },
            },
          });
          if (wanted.length === 0) return;
          // TWO SET STATEMENTS RATHER THAN ONE UPSERT PER TOOL. A loop would be
          // linear in the size of the declaration, and a backend announcing five
          // hundred tools would pay five hundred round trips inside one
          // transaction — an N+1 in WRITES, which no assertion on a returned
          // value can see because every value would still be right.
          //
          // `enabled` IS NOT WRITTEN by either. It is an operator's switch, and
          // a backend re-announcing its catalogue is not an operator. The
          // column's `@default(true)` still decides a brand-new row.
          await client.environmentEntityTool.updateMany({
            where: {
              environmentId: scope.environmentId,
              entityId: replacement.entityId,
              toolId: { in: wanted },
            },
            data: { callbackUrl: replacement.callbackUrl },
          });
          await client.environmentEntityTool.createMany({
            data: wanted.map((toolId) => ({
              environmentId: scope.environmentId,
              entityId: replacement.entityId,
              toolId,
              callbackUrl: replacement.callbackUrl,
            })),
            // The unique key is what makes the update-then-create pair safe: a
            // row the update already touched is skipped rather than duplicated.
            skipDuplicates: true,
          });
        });
        const bindings = await foldBindings(scope);
        const rows = await readExposures(transactions.reader(), {
          environmentId: scope.environmentId,
          entityId: replacement.entityId,
        });
        return ok(resolve(rows, bindings).sort(byExposureOrder));
      });
    },

    async setExposureEnabled(scope, exposureId, enabled) {
      return inScope(transactions, scope, "setExposureEnabled", async () => {
        // `updateMany` RATHER THAN `update`, because the tenant clause has to be
        // part of the statement: `update` addresses the primary key alone, and
        // an exposure id from another environment would then be switched off by
        // whoever guessed it.
        const changed = await transactions.atomic((client) =>
          client.environmentEntityTool.updateMany({
            where: { id: exposureId, environmentId: scope.environmentId },
            data: { enabled },
          }),
        );
        if (changed.count === 0) return err(exposureNotFound(exposureId));
        const bindings = await foldBindings(scope);
        const rows = await readExposures(transactions.reader(), {
          id: exposureId,
          environmentId: scope.environmentId,
        });
        const [written] = resolve(rows, bindings);
        if (written === undefined) return err(exposureNotFound(exposureId));
        return ok(written);
      });
    },
  };
}
