// The ORM seam behind the four-tier MCP permission gateway.
//
// WIN-268 P2. `permission-gateway.service.ts` held the four-tier lattice AND the
// eight `organizationMcpPolicy`/`agentBinding` reads the lattice runs on. The
// lattice is pure — a total order and a max over four opinions — and the reads
// are the only thing in that file that is not. This module takes the reads.
//
// ---------------------------------------------------------------------------
// IT IS SHAPED LIKE THE CONTRACT CALL THAT REPLACES IT
//
// `packages/contexts/tools/contracts/index.ts` publishes `resolvePermission`,
// `listOrganizationPolicies`, `setOrganizationPolicy` and
// `deleteOrganizationPolicy`, and `tools/application/resolve-permission.ts` is a
// faithful re-statement of the very algebra this gateway runs: the same
// short-circuit order, the same "no agent means no opinion, an agent with no
// binding in this scope is a denial", the same tier reporting. The rows are
// `tools`' too — ADR M0.3 §1 row 7 gives it `OrganizationMcpPolicy`, and
// `ADAPTER_BINDINGS` binds `postgres-tenancy:ToolsRepository` to owner `tools`.
//
// SO WHY IS THIS NOT `toolsContract.resolvePermission(...)`? Three measurements,
// each of which independently forbids it, recorded here because the next tranche
// will want to know which one to attack:
//
//   1. `apps/agent` imports NO `@platos/context-*`, NO `@platos/adapter-*` and
//      NO `@platos/kernel` — zero occurrences in the tree, and its
//      `package.json` declares none of them. There is no seam through which a
//      composed contract reaches this Nest container.
//   2. It could not gain one by importing an adapter: ADR M0.3 §5.1 rule (j)
//      `adapters-only-from-core` gives that to `apps/core-api`, and
//      `scripts/arch/composition-root.mjs` narrows it to the single file
//      `apps/core-api/src/composition/adapter-bindings.ts`.
//   3. `tools` is not composed in that root either. Its factory IS importable
//      (`toolsContract`, from the package's own `.` entry point — it is NOT on
//      `UNIMPORTABLE_CONTEXT_FACTORIES`) and its `ToolsRepository` IS bound to
//      `postgres-tenancy`. What is missing is `ToolDispatch`, which has no
//      adapter directory — and tool execution and the external MCP adapters are
//      WIN-269's scope, not this tranche's.
//
// This module is therefore the seam, and it is deliberately the SAME SHAPE as
// the call that will replace it: a scope in, a discriminated union out, no
// Prisma type crossing the boundary in either direction. The swap is a
// constructor argument, not a rewrite.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED BEHIND THE SEAM, AND IT IS NOT A REFACTOR
//
// TIER 2 NOW REFUSES A FORGED SCOPE INSTEAD OF ANSWERING FROM THE WRONG ORG.
// The extraction source read `where: { organizationId: scope.organizationId }`,
// with the organization taken on trust from the `x-platos-organization-id`
// header. See `mcp-scope.ts` for the measurement of why that triple is not
// trustworthy and why the failure mode is silent: the wrong organization is
// usually one with NO policy rows, `findMany` answers `[]`, and an empty list
// reads as "this tier has no objection". A tier that can only tighten became a
// tier that could be made to abstain.
//
// Every scoped method below runs `resolveClaimedScope` first, exactly as
// `tools-scope.ts` does for the context that owns these rows, and returns a
// REFUSAL that is distinguishable from an empty result.

import { Inject, Injectable } from "@nestjs/common";

import { type ControlDatabaseClient, PRISMA_TOKEN } from "../shared/database.provider";
import {
  resolveClaimedScope,
  scopeAllowed,
  type ClaimedScope,
  type Scoped,
} from "./mcp-scope";

/** One tier-2 row, with the ORM's enum already off it. */
export interface OrganizationPolicyRow {
  readonly id: string;
  readonly organizationId: string;
  readonly pattern: string;
  readonly effect: "ALLOW" | "DENY";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The tier-3 opinion source: an agent's active version, as the lattice needs it.
 *
 * `null` for the whole binding means "this agent is not deployed in this scope",
 * which `domain/permission.ts` in the destination context and the extraction
 * source both treat as a DENIAL rather than as an absence of opinion.
 */
export interface AgentPolicyBinding {
  readonly defaultPolicy: string;
  /** The highest-priority explicit effect for the named tool, if any. */
  readonly explicitEffect: "ALLOW" | "DENY" | null;
}

/**
 * The reads and writes the MCP permission gateway runs on.
 *
 * An INTERFACE and not just a class, so `permission-gateway.service.ts` names
 * this shape rather than an implementation and a suite can drive the lattice
 * with no database at all — which is what lets the lattice's own cases stay unit
 * tests while the REFUSALS get proved against a real PostgreSQL.
 */
export interface McpPolicyReader {
  listOrganizationPolicies(scope: ClaimedScope): Promise<Scoped<readonly OrganizationPolicyRow[]>>;
  findAgentPolicyBinding(
    scope: ClaimedScope,
    agentId: string,
    toolName: string,
  ): Promise<Scoped<AgentPolicyBinding | null>>;
  upsertOrganizationPolicy(
    scope: ClaimedScope,
    pattern: string,
    effect: "ALLOW" | "DENY",
  ): Promise<Scoped<OrganizationPolicyRow>>;
  deleteOrganizationPolicy(scope: ClaimedScope, id: string): Promise<Scoped<boolean>>;
}

@Injectable()
export class McpPolicyStore implements McpPolicyReader {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient) {}

  /**
   * Tier 2, scope-checked.
   *
   * THE ORGANIZATION IS THE RESOLVED ONE, NOT THE CLAIMED ONE. `resolveClaimedScope`
   * returns the organization it read THROUGH the environment's project, and that
   * is the value the `where` clause is built from. Passing the claimed id after
   * checking it would work today and would silently stop working the moment
   * somebody widened the check; reading rows for a value the database resolved
   * cannot drift from the check that resolved it.
   */
  async listOrganizationPolicies(
    scope: ClaimedScope,
  ): Promise<Scoped<readonly OrganizationPolicyRow[]>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    const rows = await this.prisma.organizationMcpPolicy.findMany({
      where: { organizationId: resolved.value.organizationId },
      orderBy: [{ pattern: "asc" }],
    });
    return scopeAllowed(rows.map(toOrganizationPolicyRow));
  }

  /**
   * Tier 3, scope-checked, with the tool's explicit effect resolved in the same
   * statement the binding is.
   *
   * THE RELATION FILTERS STAY. The extraction source already re-derived the
   * whole chain here — `environmentId`, `environment.projectId`,
   * `environment.project.organizationId` and `agent.projectId` — and that is
   * KEPT rather than replaced by the scope resolver above, because the two
   * check different things: the resolver says the claimed triple is a real
   * chain, and these say the BINDING sits on it. A scope resolver alone would
   * admit an agent bound in a sibling project of the same organization.
   */
  async findAgentPolicyBinding(
    scope: ClaimedScope,
    agentId: string,
    toolName: string,
  ): Promise<Scoped<AgentPolicyBinding | null>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        agentId,
        environmentId: scope.environmentId,
        environment: {
          projectId: resolved.value.projectId,
          project: { organizationId: resolved.value.organizationId },
        },
        agent: { projectId: resolved.value.projectId },
      },
      select: {
        activeAgentVersion: {
          select: {
            toolDefaultPolicy: true,
            toolPolicies: {
              where: { tool: { name: toolName } },
              orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
              take: 1,
              select: { effect: true },
            },
          },
        },
      },
    });
    if (!binding) return scopeAllowed(null);
    return scopeAllowed({
      defaultPolicy: binding.activeAgentVersion.toolDefaultPolicy,
      explicitEffect: binding.activeAgentVersion.toolPolicies[0]?.effect ?? null,
    });
  }

  async upsertOrganizationPolicy(
    scope: ClaimedScope,
    pattern: string,
    effect: "ALLOW" | "DENY",
  ): Promise<Scoped<OrganizationPolicyRow>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    const organizationId = resolved.value.organizationId;
    // The unique key is composite, so this is find + update/create rather than
    // `upsert`. Unchanged from the extraction source.
    const existing = await this.prisma.organizationMcpPolicy.findFirst({
      where: { organizationId, pattern },
      select: { id: true },
    });
    if (existing) {
      const updated = await this.prisma.organizationMcpPolicy.update({
        where: { id: existing.id },
        data: { effect },
      });
      return scopeAllowed(toOrganizationPolicyRow(updated));
    }
    const created = await this.prisma.organizationMcpPolicy.create({
      data: { organizationId, pattern, effect },
    });
    return scopeAllowed(toOrganizationPolicyRow(created));
  }

  /**
   * Delete one tier-2 row, scope-checked.
   *
   * `false` MEANS "no such row in THIS organization" and is not a refusal: a
   * caller deleting a policy that is already gone has got what it asked for.
   * A forged scope is the other branch, and it is a refusal — which is the
   * distinction the extraction source could not make, because it answered
   * `false` for both.
   */
  async deleteOrganizationPolicy(scope: ClaimedScope, id: string): Promise<Scoped<boolean>> {
    const resolved = await resolveClaimedScope(this.prisma, scope);
    if (!resolved.ok) return resolved;
    const existing = await this.prisma.organizationMcpPolicy.findFirst({
      where: { id, organizationId: resolved.value.organizationId },
      select: { id: true },
    });
    if (!existing) return scopeAllowed(false);
    await this.prisma.organizationMcpPolicy.delete({ where: { id } });
    return scopeAllowed(true);
  }
}

function toOrganizationPolicyRow(row: {
  id: string;
  organizationId: string;
  pattern: string;
  effect: "ALLOW" | "DENY";
  createdAt: Date;
  updatedAt: Date;
}): OrganizationPolicyRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    pattern: row.pattern,
    effect: row.effect,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
