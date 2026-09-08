import { Inject, Injectable } from "@nestjs/common";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";

/**
 * The ONE owner of `agentBinding` reads behind the agent HTTP transports.
 *
 * WIN-258's open clause is "no transport imports Prisma". Before this file the
 * same forged-id guard was written out THREE times — `channels.controller.ts`
 * twice and `channel-apps.controller.ts` once — each a hand-copied four-level
 * `where` walking agentBinding -> agent -> environment -> project. Three copies
 * of a scope guard is three places a scope check can be weakened one at a time,
 * and the transport is the worst possible home for it: a controller is the layer
 * with the least reason to know that "in scope" is a relation walk at all.
 *
 * WHY THIS IS A DIRECTORY IN `apps/agent` AND NOT `AgentsContract`.
 * `agentBinding` is owned by the `agents` context (`ADAPTER_BINDINGS` binds
 * `postgres-tenancy:AgentsRepository` to owner `agents`). Routing here to that
 * contract is NOT possible in this tranche and the reason is structural, not a
 * matter of effort:
 *
 *   1. `packages/contexts/agents/` publishes NO contract factory. It is one of
 *      the six contexts `apps/core-api/src/composition/context-ports.ts` names as
 *      publishing "their use cases one by one and no assembler over them", so
 *      there is nothing to construct.
 *   2. `apps/agent` has no dependency on any `@platos/context-*` package and no
 *      seam through which a composed contract could reach its Nest container.
 *      Its `package.json` depends on `@platos/tenancy-database` directly.
 *   3. Exactly ONE context — `tenancy` — is composable at the composition root
 *      today, and `agents` is not among the near misses.
 *
 * So this is the SEAM, deliberately shaped like the call that will replace it.
 * Every method takes a scope and returns a narrow view that names no Prisma
 * type, so the day `AgentsContract` is composable this class's body changes and
 * nothing above it does. That is the whole point of putting it here rather than
 * leaving the queries in three controllers: the swap becomes one file.
 */

/** The ancestry a scope check is judged against. */
export interface AgentBindingScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/** An agent resolved through its binding — the identity, never the row. */
export interface BoundAgentView {
  readonly id: string;
  readonly name: string | null;
}

/** A public-guest binding, flattened to what a token minter needs. */
export interface PublicGuestBindingView {
  readonly agentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/**
 * The scope predicate, written ONCE.
 *
 * An agent is project-owned and deployed into an environment, so "belongs to
 * this scope" is a walk: the binding's environment, the agent's project, and the
 * environment's project's organization must ALL agree. Naming it here means the
 * three call sites cannot drift, and a reviewer reads the rule once.
 */
function bindingInScope(scope: AgentBindingScope, agentId: string) {
  return {
    agentId,
    environmentId: scope.environmentId,
    agent: { projectId: scope.projectId },
    environment: {
      project: { id: scope.projectId, organizationId: scope.organizationId },
    },
  } as const;
}

/**
 * Is this binding visible to an anonymous guest?
 *
 * EXPORTED AND PURE so it can be falsified without a database. The rule has two
 * spellings in the stored configuration — `memoryConfig.__runtime.visibility` and
 * `toolsBlockConfig.visibility` — and the first wins when both are present. That
 * precedence was previously inlined in `public-guest-token.controller.ts` amid
 * the rate-limit and token-minting code, where the one branch that decides
 * whether a private agent is exposed to the open internet was the least visible
 * thing in the method.
 */
export function isPublicGuestVisible(version: {
  readonly memoryConfig?: unknown;
  readonly toolsBlockConfig?: unknown;
} | null | undefined): boolean {
  const memory = version?.memoryConfig;
  const runtime =
    memory && typeof memory === "object" && !Array.isArray(memory)
      ? (memory as Record<string, unknown>).__runtime
      : null;
  const runtimeVisibility =
    runtime && typeof runtime === "object" && !Array.isArray(runtime)
      ? (runtime as Record<string, unknown>).visibility
      : undefined;
  const tools = version?.toolsBlockConfig;
  const toolsVisibility =
    tools && typeof tools === "object" && !Array.isArray(tools)
      ? (tools as Record<string, unknown>).visibility
      : undefined;
  return (runtimeVisibility ?? toolsVisibility) === "public-guest";
}

@Injectable()
export class AgentBindingDirectory {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  /** Forged-id guard — the agent must be deployed into this exact scope. */
  async isInScope(scope: AgentBindingScope, agentId: string): Promise<boolean> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: bindingInScope(scope, agentId),
      select: { id: true },
    });
    return binding !== null;
  }

  /**
   * The same guard, plus the agent's display name.
   *
   * Separate from `isInScope` rather than a flag on it because a caller that
   * needs the name needs a DIFFERENT projection, and a boolean-or-row return
   * would make every call site re-narrow it. Null means "not in scope", which is
   * the same answer `isInScope` gives as `false`.
   */
  async describeInScope(
    scope: AgentBindingScope,
    agentId: string,
  ): Promise<BoundAgentView | null> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: bindingInScope(scope, agentId),
      select: { agent: { select: { id: true, name: true } } },
    });
    if (!binding?.agent) return null;
    return { id: binding.agent.id, name: binding.agent.name ?? null };
  }

  /**
   * Every ACTIVE, public-guest-visible binding of one agent in one
   * environment.
   *
   * Returns a list rather than "the one" on purpose: the caller's rule is that
   * exactly one must match, and collapsing two matches to the first here would
   * silently pick a binding. Ambiguity is the caller's to refuse, and it
   * refuses it with a 404 so the existence of a private agent never leaks.
   */
  async listPublicGuestBindings(
    agentId: string,
    environmentId: string,
  ): Promise<readonly PublicGuestBindingView[]> {
    const bindings = await this.prisma.agentBinding.findMany({
      where: { agentId, environmentId },
      include: {
        agent: true,
        environment: { include: { project: true } },
        activeAgentVersion: {
          select: { memoryConfig: true, toolsBlockConfig: true },
        },
      },
    });
    return bindings
      .filter(
        (binding) =>
          binding.agent.isActive && isPublicGuestVisible(binding.activeAgentVersion),
      )
      .map((binding) => ({
        agentId: binding.agent.id,
        organizationId: binding.environment.project.organizationId,
        projectId: binding.environment.projectId,
        environmentId: binding.environmentId,
      }));
  }
}
