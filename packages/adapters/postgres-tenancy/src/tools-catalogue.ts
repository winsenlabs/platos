// `Tool`, and the `AgentToolPolicy` bindings that decide who may see one.
//
// TWO SURFACES THAT LOOK UNRELATED AND ARE NOT. The `Tool` row is
// installation-global and content-addressed; the agent bindings are the
// environment's opinion about which agents may call it. They are together
// because `listExposures` needs BOTH and because folding the bindings per
// exposure is the N+1 the statement suite pins against — the fold is over the
// environment's whole binding set, read once.
//
// `upsertTool` IS FIND-THEN-CREATE AND NEVER AN UPDATE. The port says so and the
// reason is the `@updatedAt` column: a Prisma `upsert` with an empty `update`
// still issues the UPDATE, which moves `updatedAt` on a row that by construction
// did not change. A second writer racing the create loses on
// `Tool_name_schemaHash_key` and is answered from the row that won, so the
// find-or-create is idempotent under concurrency rather than merely under
// sequence.
//
// THE `Tool` METHODS TAKE NO SCOPE, and that is the port's decision, not an
// omission: the row has no tenancy column at all, so two organizations declaring
// an identical tool share one row. Nothing here may therefore refuse on scope,
// and pretending otherwise would invent an ancestry the table does not have.

import type {
  AgentPolicyBinding,
  AgentToolPolicy,
  AgentVersionId,
  AgentToolPolicyId,
  EnvironmentScope,
  Result,
  SchemaHash,
  Tool,
  ToolId,
  ToolName,
} from "@platos/context-tools/application/ports/index.js";
import { asToolsIdentifier, ok } from "@platos/context-tools/application/ports/index.js";
import type { ToolUpsert } from "@platos/context-tools/application/ports/index.js";

import { isUniqueViolation } from "./client.js";
import { readDefaultPolicy, readEffect, toTool } from "./tools-rows.js";
import { guarded, inScope } from "./tools-scope.js";
import type { TenancyTransactions } from "./transaction.js";

/** The three `Tool` methods and the two binding reads, as one object. */
export interface ToolsCatalogue {
  findToolByFingerprint(name: ToolName, schemaHash: SchemaHash): Promise<Result<Tool | null>>;
  upsertTool(tool: ToolUpsert): Promise<Result<Tool>>;
  findTools(toolIds: readonly ToolId[]): Promise<Result<readonly Tool[]>>;
  listAgentPolicyBindings(scope: EnvironmentScope): Promise<Result<readonly AgentPolicyBinding[]>>;
  findAgentPolicyBinding(
    scope: EnvironmentScope,
    agentId: string,
  ): Promise<Result<AgentPolicyBinding | null>>;
  /**
   * The binding fold WITHOUT the scope resolve, for a caller that has already
   * done it.
   *
   * NOT part of `ToolsRepository` and never reachable through it: it skips the
   * tenant clause, which is only safe because `./tools-exposures.ts` calls it
   * strictly inside its own `inScope`. It exists because resolving one scope
   * twice per `listExposures` is one wasted round trip on the hot path of every
   * turn, and `tools-statements.integration.test.ts` measured exactly that.
   */
  readBindings(scope: EnvironmentScope): Promise<readonly AgentPolicyBinding[]>;
}

/** The shape a binding is read in. Named once; both reads select it. */
/**
 * The nine columns `ToolRow` declares. `paramSchema` is the JSONB one.
 *
 * WIN-258 T7. `findTools` is handed a list of ids by the turn's own tool
 * resolution, so this is a per-turn read whose row count is the size of an
 * agent's loadout; an unprojected one deserialises a JSON Schema per tool and
 * whatever the table grows next besides.
 */
const TOOL_SELECT = {
  id: true,
  name: true,
  description: true,
  kind: true,
  paramSchema: true,
  category: true,
  schemaHash: true,
  createdAt: true,
  updatedAt: true,
} as const;

const BINDING_SELECT = {
  agentId: true,
  activeAgentVersion: {
    select: {
      id: true,
      toolDefaultPolicy: true,
      toolPolicies: {
        select: { id: true, agentVersionId: true, toolId: true, effect: true, priority: true, createdAt: true },
        orderBy: { toolId: "asc" },
      },
    },
  },
} as const;

interface BindingRow {
  readonly agentId: string;
  readonly activeAgentVersion: {
    readonly id: string;
    readonly toolDefaultPolicy: string;
    readonly toolPolicies: readonly {
      readonly id: string;
      readonly agentVersionId: string;
      readonly toolId: string;
      readonly effect: string;
      readonly priority: number;
      readonly createdAt: Date;
    }[];
  };
}

function toPolicy(row: BindingRow["activeAgentVersion"]["toolPolicies"][number]): AgentToolPolicy {
  return {
    agentToolPolicyId: asToolsIdentifier<AgentToolPolicyId>(row.id),
    agentVersionId: asToolsIdentifier<AgentVersionId>(row.agentVersionId),
    toolId: asToolsIdentifier<ToolId>(row.toolId),
    effect: readEffect("AgentToolPolicy.effect", row.effect),
    priority: row.priority,
    createdAt: row.createdAt,
  };
}

function toBinding(row: BindingRow): AgentPolicyBinding {
  return {
    agentId: asToolsIdentifier(row.agentId),
    // The ACTIVE version, never the canary. A binding's canary is a rollout
    // fraction, and a tool an operator has not yet promoted must not become
    // visible to the fraction of turns that happen to land on it.
    agentVersionId: asToolsIdentifier<AgentVersionId>(row.activeAgentVersion.id),
    defaultPolicy: readDefaultPolicy(row.activeAgentVersion.toolDefaultPolicy),
    policies: row.activeAgentVersion.toolPolicies.map(toPolicy),
  };
}

export function createToolsCatalogue(transactions: TenancyTransactions): ToolsCatalogue {
  // Named through `catalogue` rather than `this`: every store in this package is
  // destructured by `./tools-repository.ts`, and a `this`-bound method would
  // lose its receiver on the way in.
  const catalogue: ToolsCatalogue = {
    async findToolByFingerprint(name, schemaHash) {
      return guarded("findToolByFingerprint", async () => {
        const row = await transactions.reader().tool.findUnique({
          where: { name_schemaHash: { name, schemaHash } },
          select: TOOL_SELECT,
        });
        return ok(row === null ? null : toTool(row));
      });
    },

    async upsertTool(tool) {
      return guarded("upsertTool", async () => {
        const fingerprint = { name: tool.name, schemaHash: tool.schemaHash };
        const held = await transactions.reader().tool.findUnique({
          where: { name_schemaHash: fingerprint },
          select: TOOL_SELECT,
        });
        if (held !== null) return ok(toTool(held));
        try {
          const minted = await transactions.atomic((client) =>
            client.tool.create({
              data: {
                name: tool.name,
                description: tool.description,
                // ENTITY and only ENTITY. Registration mints no other kind, and
                // the column's default says the same thing — written out anyway,
                // because a default is the schema's opinion and this is ours.
                kind: "ENTITY",
                paramSchema: tool.paramSchema as never,
                category: tool.category,
                schemaHash: tool.schemaHash,
              },
            }),
          );
          return ok(toTool(minted));
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // Somebody else minted the same fingerprint between the read and the
          // write. Their row IS this row: the key is the content.
          const won = await transactions.reader().tool.findUniqueOrThrow({
            where: { name_schemaHash: fingerprint },
            select: TOOL_SELECT,
          });
          return ok(toTool(won));
        }
      });
    },

    async findTools(toolIds) {
      return guarded("findTools", async () => {
        if (toolIds.length === 0) return ok([]);
        const rows = await transactions.reader().tool.findMany({
          where: { id: { in: [...toolIds] } },
          orderBy: { id: "asc" },
          select: TOOL_SELECT,
        });
        return ok(rows.map(toTool));
      });
    },

    async readBindings(scope) {
      const rows = await transactions.reader().agentBinding.findMany({
        where: { environmentId: scope.environmentId },
        select: BINDING_SELECT,
        orderBy: { agentId: "asc" },
      });
      return rows.map(toBinding);
    },

    async listAgentPolicyBindings(scope) {
      return inScope(transactions, scope, "listAgentPolicyBindings", async () =>
        ok(await catalogue.readBindings(scope)),
      );
    },

    async findAgentPolicyBinding(scope, agentId) {
      return inScope(transactions, scope, "findAgentPolicyBinding", async () => {
        const row = await transactions.reader().agentBinding.findUnique({
          where: { environmentId_agentId: { environmentId: scope.environmentId, agentId } },
          select: BINDING_SELECT,
        });
        return ok(row === null ? null : toBinding(row));
      });
    },
  };
  return catalogue;
}
