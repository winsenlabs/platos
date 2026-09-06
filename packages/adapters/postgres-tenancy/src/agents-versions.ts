// `AgentVersion` and `AgentSkill` — the immutable half of `AgentsRepository`.
//
// THE LOCK IS IN `observedVersionNumbers` AND NOWHERE ELSE, and that placement
// is the whole of this module's concurrency story. Two saves against one agent
// both read the numbers it has used, both compute `last + 1`, and both insert —
// `@@unique([agentId, versionNumber])` refuses the second, which is correct and
// is not enough: the port's own comment says two concurrent saves should
// SERIALISE rather than one of them failing. So the read takes a row lock on the
// PARENT `Agent` row, which is the only row a version write has that both
// callers already share.
//
// IT IS A LEFT JOIN, AND THAT IS NOT A STYLE CHOICE. `FOR UPDATE OF a` locks the
// rows the statement RETURNS. An inner join from `AgentVersion` to `Agent`
// returns nothing for an agent that has no versions yet — which is exactly the
// first save, the one where two callers race hardest — so the lock would have
// been taken on every save except the one that needed it, and every test would
// have passed. Verified on a real container: the LEFT JOIN returns one row with
// a null version number for a bare agent, and the lock is taken.
//
// A LOADOUT IS REPLACED WHOLE, IN TWO STATEMENTS. Delete the version's rows,
// insert the next list, and return what was inserted. Not an upsert per skill:
// a version's loadout is written once and a partial write would leave a live
// version carrying half of two configurations.
//
// THE ROW IDS ARE POSTGRESQL'S. `AgentSkill.id` carries `@default(uuid())` and
// the port hands over assignments with no identity at all, so minting ids here
// would be this adapter inventing a value the schema already produces.

import type {
  AgentDefaultsPolicy,
  AgentId,
  AgentSkill,
  AgentVersion,
  AgentVersionId,
  AgentVersionPage,
  Result,
  SkillAssignment,
  TransactionScope,
} from "@platos/context-agents/application/ports/index.js";
import { err, ok, packVersionRow, versionInvalid } from "@platos/context-agents/application/ports/index.js";

import {
  CROSSES_OWNER_ANCESTRY,
  CHECK_VIOLATION,
  checkRefusal,
  DUPLICATE_ENVIRONMENT_SKILL,
  ENVIRONMENT_SKILL_UNKNOWN,
  FOREIGN_KEY_VIOLATION,
  namesConstraint,
  refusable,
  refused,
  sqlstateOf,
  UNIQUE_VIOLATION,
} from "./agents-guards.js";
import type { AgentSkillRow, AgentVersionRowShape } from "./agents-rows.js";
import { SKILL_COLUMNS, toSkill, toVersion, VERSION_COLUMNS } from "./agents-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** `byVersionOrder`: highest number first, then by id descending. */
const VERSION_ORDER = [{ versionNumber: "desc" }, { id: "desc" }] as const;

/** One row per version number this agent has used, plus the parent row lock. */
interface ObservedRow {
  readonly versionNumber: number | null;
}

function versionWriteRefusal(version: AgentVersion) {
  return (error: unknown) => {
    if (sqlstateOf(error) === UNIQUE_VIOLATION && namesConstraint(error, "agentId,versionNumber")) {
      return versionInvalid("a version with that number already exists for this agent", {
        agentId: version.agentId,
        versionNumber: String(version.versionNumber),
      });
    }
    return null;
  };
}

function loadoutRefusal(error: unknown) {
  const sqlstate = sqlstateOf(error);
  if (sqlstate === UNIQUE_VIOLATION) return refused(DUPLICATE_ENVIRONMENT_SKILL);
  if (sqlstate === FOREIGN_KEY_VIOLATION) return refused(ENVIRONMENT_SKILL_UNKNOWN);
  // An `EnvironmentSkill` that does not exist is refused by the ancestry rule
  // BEFORE the foreign key gets to see it — measured, and the reason both
  // refusals are recognised here rather than only the obvious one.
  if (sqlstate === CHECK_VIOLATION && checkRefusal(error) === CROSSES_OWNER_ANCESTRY) {
    return refused(CROSSES_OWNER_ANCESTRY);
  }
  return null;
}

export function createAgentVersions(
  transactions: TenancyTransactions,
  defaults: AgentDefaultsPolicy,
) {
  const read = (row: AgentVersionRowShape): AgentVersion => toVersion(row, defaults);

  return {
    async findVersion(
      agentId: AgentId,
      versionId: AgentVersionId,
    ): Promise<Result<AgentVersion | null>> {
      // Scoped by BOTH ids. A version id belonging to another agent answers
      // null, which is what stops a canary check passing on a foreign version.
      const row = (await transactions
        .reader()
        .agentVersion.findFirst({
          where: { id: versionId, agentId },
          select: VERSION_COLUMNS,
        })) as AgentVersionRowShape | null;
      return ok(row === null ? null : read(row));
    },

    async listVersions(agentId: AgentId): Promise<Result<readonly AgentVersion[]>> {
      const rows = (await transactions
        .reader()
        .agentVersion.findMany({
          where: { agentId },
          orderBy: [...VERSION_ORDER],
          select: VERSION_COLUMNS,
        })) as AgentVersionRowShape[];
      return ok(rows.map(read));
    },

    async pageVersions(
      agentId: AgentId,
      window: { readonly take: number; readonly offset: number; readonly cursor: string | null },
    ): Promise<Result<AgentVersionPage>> {
      // ONE ROW MORE THAN ASKED FOR, so "is there another page" is a fact about
      // the rows rather than arithmetic over an offset a cursor has made
      // meaningless. The extra row is dropped before the page is returned.
      const [rows, total] = await Promise.all([
        transactions.reader().agentVersion.findMany({
          where: { agentId },
          orderBy: [...VERSION_ORDER],
          select: VERSION_COLUMNS,
          take: window.take + 1,
          ...(window.cursor === null
            ? { skip: window.offset }
            : { cursor: { id: window.cursor }, skip: 1 }),
        }) as Promise<AgentVersionRowShape[]>,
        transactions.reader().agentVersion.count({ where: { agentId } }),
      ]);
      const page = rows.slice(0, window.take).map(read);
      const more = rows.length > window.take;
      return ok({
        items: page,
        total,
        nextCursor: more ? page[page.length - 1]?.agentVersionId ?? null : null,
      });
    },

    async observedVersionNumbers(
      agentId: AgentId,
      transaction: TransactionScope,
    ): Promise<Result<readonly number[]>> {
      const client = transactions.writer(transaction);
      // ORDERED, though the port asks for a set. `nextVersionNumber` takes the
      // maximum and could not care, but the in-memory double answers in
      // `byVersionOrder` and the conformance differential compares the two lists
      // verbatim — so an unordered read here would report a divergence that is
      // about the planner rather than about behaviour.
      const rows = await client.$queryRaw<ObservedRow[]>`
        SELECT version."versionNumber"
          FROM "Agent" agent
          LEFT JOIN "AgentVersion" version ON version."agentId" = agent.id
         WHERE agent.id = ${agentId}::uuid
         ORDER BY version."versionNumber" DESC
        FOR UPDATE OF agent
      `;
      const numbers: number[] = [];
      for (const row of rows) {
        if (row.versionNumber !== null) numbers.push(row.versionNumber);
      }
      return ok(numbers);
    },

    async insertVersion(
      version: AgentVersion,
      transaction: TransactionScope,
    ): Promise<Result<AgentVersion>> {
      const client = transactions.writer(transaction);
      const row = packVersionRow(
        version.snapshot,
        { createdBy: version.createdBy, note: version.note },
        version.versionNumber,
        version.toolDefaultPolicy,
        defaults,
      );
      const written = await refusable(
        client,
        () =>
          client.agentVersion.create({
            data: {
              id: version.agentVersionId,
              agentId: version.agentId,
              versionNumber: row.versionNumber,
              model: row.model,
              systemPrompt: row.systemPrompt,
              maxSteps: row.maxSteps,
              contextLimit: row.contextLimit,
              toolDefaultPolicy: row.toolDefaultPolicy,
              promptBlocks: row.promptBlocks as never,
              dynamicBlocks: row.dynamicBlocks as never,
              toolsBlockConfig: row.toolsBlockConfig as never,
              modelRoutes: row.modelRoutes as never,
              memoryConfig: row.memoryConfig as never,
              ...(row.outputSchema === undefined ? {} : { outputSchema: row.outputSchema as never }),
              note: row.note,
              createdBy: row.createdBy,
              createdAt: version.createdAt,
            },
          }),
        versionWriteRefusal(version),
      );
      return written.ok ? ok(read(written.value as AgentVersionRowShape)) : err(written.error);
    },

    async listLoadout(agentVersionId: AgentVersionId): Promise<Result<readonly AgentSkill[]>> {
      // ORDERED BY THE SKILL, not by `createdAt`. A whole loadout is written in
      // ONE statement, so every row of it carries the same `now()` and the
      // tie-break would be the uuid the database minted — an order that changes
      // between two runs of the same fixture. The port specifies no order at all
      // (`carryForward` treats a loadout as a set), so this is the store picking
      // a TOTAL one rather than inheriting a random one.
      const rows = (await transactions.reader().agentSkill.findMany({
        where: { agentVersionId },
        orderBy: [{ environmentSkillId: "asc" }],
        select: SKILL_COLUMNS,
      })) as AgentSkillRow[];
      return ok(rows.map(toSkill));
    },

    async replaceLoadout(
      agentVersionId: AgentVersionId,
      assignments: readonly SkillAssignment[],
      transaction: TransactionScope,
    ): Promise<Result<readonly AgentSkill[]>> {
      const client = transactions.writer(transaction);
      const written = await refusable(
        client,
        async () => {
          await client.agentSkill.deleteMany({ where: { agentVersionId } });
          if (assignments.length === 0) return [] as AgentSkillRow[];
          return (await client.agentSkill.createManyAndReturn({
            data: assignments.map((assignment) => ({
              agentVersionId,
              environmentSkillId: assignment.environmentSkillId,
              enabled: assignment.enabled,
              config: assignment.config as never,
            })),
          })) as AgentSkillRow[];
        },
        loadoutRefusal,
      );
      return written.ok ? ok(written.value.map(toSkill)) : err(written.error);
    },
  };
}
