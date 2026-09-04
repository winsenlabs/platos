// In-memory stand-ins for the two peer contexts this one depends on.
//
// THEY ARE NOT STUBS THAT SAY YES.
//
//   Tenancy's grant CANNOT be real, and that asymmetry is not an oversight.
//   `tenancy` deliberately publishes no mint — its authorization is an RBAC
//   DECISION, produced by loading a tenant tree and evaluating four gates, not a
//   value a caller constructs. So this double issues a marked object and
//   recognises it, which exercises the one thing this context is responsible
//   for: asking, and refusing when the answer is no. `authorization.test.ts`
//   separately pins that the REAL published check rejects a hand-written
//   literal, so the production wiring cannot be sound in this file and unsound
//   at the seam.
//
//   Agents enforces the part of its contract this context relies on: an agent is
//   visible only in the environment it was seeded in, it carries the model its
//   live version runs, and its version page carries version numbers. The
//   no-self-evaluation invariant is decided against THAT model, so an agents
//   double that answered a plausible constant would make the invariant
//   untestable. It also counts its calls, so "the rating path asks agents once"
//   is a tested claim.

import { err, ok, asIdentifier, type EnvironmentScope, type Result } from "@platos/kernel";
import type { AgentPageView, AgentVersionPageView, AgentView, AgentsContract } from "@platos/context-agents";
import type {
  EnvironmentAccess,
  EnvironmentOperatorAuthorization as TenancyGrant,
  TenancyContract,
} from "@platos/context-tenancy";

import { ledgerUnavailable } from "../../domain/index.js";

const ISSUED = new WeakSet<object>();

/**
 * An in-memory `tenancy`, offering only what this context asks of it.
 *
 * `verifyAuthorization` is the one method `governance` calls, and it answers
 * from a private register of the grants THIS double issued — the same
 * identity-not-shape rule the real one uses, so a hand-written literal is
 * refused here too.
 */
export class InMemoryTenancy implements Pick<TenancyContract, "name" | "verifyAuthorization"> {
  readonly name = "tenancy" as const;

  constructor(private readonly scope: EnvironmentScope) {}

  /** Issue a grant this double will subsequently recognise. */
  grant(access: EnvironmentAccess = "metadata", scope: EnvironmentScope = this.scope): TenancyGrant {
    const issued = Object.freeze({
      principalType: "operator",
      tier: "OPERATOR",
      access,
      scope,
      actorUserId: asIdentifier("operator-1"),
      effectiveUserId: asIdentifier("operator-1"),
      organizationRole: "ADMIN",
      projectRole: null,
    }) as unknown as TenancyGrant;
    ISSUED.add(issued);
    return issued;
  }

  verifyAuthorization(value: unknown): Result<TenancyGrant> {
    if (typeof value === "object" && value !== null && ISSUED.has(value)) {
      return ok(value as TenancyGrant);
    }
    return err(ledgerUnavailable("authorization_not_issued"));
  }
}

export interface SeededAgent {
  readonly agentId: string;
  readonly name: string;
  /** The model the LIVE version runs. The self-evaluation guard reads this. */
  readonly model: string;
  readonly currentVersionId: string;
  readonly currentVersionNumber: number;
  /** Extra versions the version page should carry, oldest first. */
  readonly priorVersions?: readonly { readonly versionId: string; readonly versionNumber: number }[];
}

/**
 * An in-memory `agents`, offering the three methods this context calls.
 *
 * Every other method refuses. A use case that reached for one would fail loudly
 * here rather than quietly acquiring an edge the ADR M0.3 §1 DAG permits but
 * this context has no business taking.
 */
export class InMemoryAgents
  implements Pick<AgentsContract, "name" | "describeAgent" | "pageAgents" | "pageVersions">
{
  readonly name = "agents" as const;

  private readonly agents = new Map<string, SeededAgent>();
  /** Every agent id this double was asked to describe, in order. */
  readonly describeCalls: string[] = [];
  private failing = false;

  constructor(private readonly scope: EnvironmentScope, private readonly now: () => Date) {}

  seed(agent: SeededAgent): SeededAgent {
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  /** Make every subsequent answer a failure — an unbound agent, a store down. */
  failEverything(failing = true): void {
    this.failing = failing;
  }

  async describeAgent(query: {
    readonly authorization: unknown;
    readonly agentId: string;
  }): Promise<Result<AgentView>> {
    this.describeCalls.push(query.agentId);
    if (this.failing) return err(ledgerUnavailable("agents_double_failing"));
    if (!this.sameEnvironment(query.authorization)) return err(ledgerUnavailable("agent_other_environment"));
    const held = this.agents.get(query.agentId);
    if (held === undefined) return err(ledgerUnavailable("agent_not_seeded"));
    return ok(this.view(held));
  }

  async pageAgents(query: {
    readonly authorization: unknown;
    readonly limit?: number | null;
    readonly offset?: number | null;
  }): Promise<Result<AgentPageView>> {
    if (this.failing) return err(ledgerUnavailable("agents_double_failing"));
    if (!this.sameEnvironment(query.authorization)) return ok({ items: [], total: 0, offset: 0, limit: 0 });
    // The window is APPLIED, not ignored. `risk-report.ts` names one agent page
    // for every agent on the board; a double that answered every seeded agent
    // whatever the caller asked for would make that ceiling unfalsifiable.
    const all = [...this.agents.values()].map((agent) => this.view(agent));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? all.length;
    return ok({ items: all.slice(offset, offset + limit), total: all.length, offset, limit });
  }

  async pageVersions(query: {
    readonly authorization: unknown;
    readonly agentId: string;
  }): Promise<Result<AgentVersionPageView>> {
    if (this.failing) return err(ledgerUnavailable("agents_double_failing"));
    if (!this.sameEnvironment(query.authorization)) return err(ledgerUnavailable("agent_other_environment"));
    const held = this.agents.get(query.agentId);
    if (held === undefined) return err(ledgerUnavailable("agent_not_seeded"));
    const items = [
      ...(held.priorVersions ?? []).map((prior) =>
        this.versionView(held, prior.versionId, prior.versionNumber, false),
      ),
      this.versionView(held, held.currentVersionId, held.currentVersionNumber, true),
    ];
    return ok({ items, total: items.length, nextCursor: null, offset: 0, limit: items.length });
  }

  /**
   * Is the grant this call carries for the environment these agents live in?
   *
   * The real `agents` reads its rows under the grant's own scope, so an agent
   * bound to one environment is not visible through another environment's
   * grant. A double that answered from its map regardless would let a
   * cross-environment read pass here and fail in production, so it reads the
   * scope off the grant this package's tenancy double issues and compares it.
   */
  private sameEnvironment(authorization: unknown): boolean {
    if (typeof authorization !== "object" || authorization === null) return false;
    const scope = (authorization as { readonly scope?: { readonly environmentId?: unknown } }).scope;
    return scope?.environmentId === this.scope.environmentId;
  }

  private view(agent: SeededAgent): AgentView {
    const at = this.now();
    return {
      agentId: agent.agentId,
      projectId: this.scope.projectId,
      environmentId: this.scope.environmentId,
      name: agent.name,
      slug: agent.name.toLowerCase(),
      description: null,
      isActive: true,
      clusterId: null,
      currentVersionId: agent.currentVersionId,
      currentVersionNumber: agent.currentVersionNumber,
      canaryVersionId: null,
      canaryVersionNumber: null,
      canaryPercent: 0,
      configuration: configurationWith(agent.model),
      createdAt: at,
      updatedAt: at,
    };
  }

  private versionView(
    agent: SeededAgent,
    versionId: string,
    versionNumber: number,
    isCurrent: boolean,
  ): AgentVersionPageView["items"][number] {
    return {
      agentVersionId: versionId,
      agentId: agent.agentId,
      versionNumber,
      toolDefaultPolicy: "ALL",
      note: null,
      createdBy: "operator-1",
      createdAt: this.now(),
      configuration: configurationWith(agent.model),
      isCurrent,
      isCanary: false,
    };
  }
}

/** The one field this context reads, and defaults for everything else. */
function configurationWith(model: string): AgentView["configuration"] {
  return {
    model,
    modelRoutes: null,
    systemPrompt: null,
    promptBlocks: null,
    dynamicBlocks: null,
    maxSteps: 20,
    contextLimit: 20,
    historyMode: "rolling",
    compactThreshold: 40,
    enableUserProfiling: false,
    toolMode: "direct",
    executionMode: "direct",
    toolsBlockConfig: null,
    subAgentConfig: null,
    memoryConfig: null,
    metaTools: null,
    featureFlags: null,
    outputSchema: null,
    extractionPolicy: null,
    enableThreading: false,
    threadingConfig: null,
    contextMapping: null,
    providerKeyId: null,
    visibility: null,
    maxJobsPerTurn: null,
    agentRetryConfig: null,
  };
}
