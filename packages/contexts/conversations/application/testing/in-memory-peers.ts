// In-memory doubles for the nine peers this context depends on.
//
// EACH IMPLEMENTS THE NARROW PORT, NOT THE NEIGHBOUR'S WHOLE CONTRACT, and that
// is why this file is a few hundred lines rather than a few thousand. A double
// typed as `ProvidersContract` would have to answer twenty-two methods this
// context never calls, and would break the day `providers` grew a
// twenty-third — which is exactly what happened to `memory` when the WIN-256
// prerequisite added `runModelGeneration` and `streamModelGeneration` to a
// contract `memory` uses one method of. With a narrow port a test that reaches
// for a member this context does not depend on FAILS TO COMPILE rather than
// receiving a refusal at run time, which is the stronger of the two guarantees.
//
// THE PRICING DOUBLE CARRIES REAL RATES, AND IT HAS TO. A pricing fixture with
// no `rates` key left an entire money path unexecuted in another package this
// week while every case stayed green: with no rate to apply, every cost came out
// zero, and "priced at zero" and "not priced at all" were indistinguishable.
// `InMemoryProviders` answers four named rates with real `Decimal(24, 12)`
// strings and a cost computed from them, so `requireExplainedRates` has
// something to explain and the exact-value assertions in `turn-steps.test.ts`
// have a number that is not zero.
//
// THE TENANCY DOUBLE CHECKS IDENTITY, NOT SHAPE. `verifyAuthorization` in the
// real contract compares against tenancy's own mint register, so a literal is
// always refused. A double that accepted any object with the right fields would
// make every authorization test vacuous — the guard would pass on data a
// transport could forge. This one keeps its own register.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";
import type { EnvironmentOperatorAuthorization } from "@platos/context-tenancy";

import { repositoryUnavailable } from "../../domain/index.js";
import type {
  AgentsPeer,
  CostMonitoringPeer,
  FilesPeer,
  JobsPeer,
  MemoryPeer,
  ProvidersPeer,
  SkillsPeer,
  TenancyPeer,
  ToolsPeer,
} from "../dependencies.js";

const NOT_OFFERED = () =>
  err(repositoryUnavailable("this in-memory double does not implement that operation"));

const ISSUED = new WeakSet<object>();

export class InMemoryTenancy implements TenancyPeer {
  readonly name = "tenancy" as const;

  constructor(private readonly scope: EnvironmentScope) {}

  /** Mint a grant the way `tenancy` does: by REGISTERING the object identity. */
  grant(scope: EnvironmentScope = this.scope): EnvironmentOperatorAuthorization {
    const issued = Object.freeze({
      principalType: "operator",
      tier: "OPERATOR",
      access: "metadata",
      scope,
      actorUserId: "operator-1",
      effectiveUserId: "operator-1",
      organizationRole: "ADMIN",
      projectRole: null,
    }) as unknown as EnvironmentOperatorAuthorization;
    ISSUED.add(issued);
    return issued;
  }

  verifyAuthorization: TenancyPeer["verifyAuthorization"] = (value: unknown) => {
    if (typeof value === "object" && value !== null && ISSUED.has(value)) {
      return ok(value as EnvironmentOperatorAuthorization);
    }
    return err(repositoryUnavailable("authorization_not_issued"));
  };

  scopeContains: TenancyPeer["scopeContains"] = () => true;
}

export class InMemoryAgents implements AgentsPeer {
  readonly name = "agents" as const;

  versionId = "ver-1";
  bucket: "CURRENT" | "CANARY" = "CURRENT";
  model = "anthropic:claude-test";
  providerKeyId: string | null = "key-1";
  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  describeAgent: AgentsPeer["describeAgent"] = async () => NOT_OFFERED() as never;

  selectVersion: AgentsPeer["selectVersion"] = async (query) => {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    // The DRAW is the caller's; a double that ignored it would make every
    // canary assertion vacuous.
    const bucket = query.draw < 0.5 ? this.bucket : "CURRENT";
    return ok({ versionId: this.versionId, bucket } as never);
  };

  resolveRoute: AgentsPeer["resolveRoute"] = async () => {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok({
      label: null,
      model: this.model,
      provider: "anthropic",
      providerKeyId: this.providerKeyId,
      credentialName: "test",
    });
  };

  describeTemplate: AgentsPeer["describeTemplate"] = async () => NOT_OFFERED() as never;
}

export class InMemorySkills implements SkillsPeer {
  readonly name = "skills" as const;

  systemPrompt = "You are a test agent.";
  tools: { name: string; description: string; inputSchema: Record<string, unknown> | null }[] = [];
  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  composeRuntime: SkillsPeer["composeRuntime"] = async (request) => {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok({
      promptBlock: "",
      systemPrompt: `${request.basePrompt ?? ""}${this.systemPrompt}`,
      tools: this.tools as never,
      admitted: [],
      omitted: [],
      truncated: false,
      skipped: [],
    });
  };
}

export class InMemoryTools implements ToolsPeer {
  readonly name = "tools" as const;

  found: { toolName: string; description: string; paramSchema: Record<string, unknown> }[] = [];
  /** Every dispatch, so a suite can assert an unoffered name never reached here. */
  readonly dispatched: string[] = [];
  result: unknown = { ok: true };
  awaitingApproval = false;
  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  findTools: ToolsPeer["findTools"] = async () => {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok(this.found as never);
  };

  executeTool: ToolsPeer["executeTool"] = async (command) => {
    this.dispatched.push(String(command.toolName));
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    if (this.awaitingApproval) {
      return ok({ kind: "awaiting_approval", tier: 3, reason: "needs a human" } as never);
    }
    return ok({ kind: "completed", result: this.result, latencyMs: 1, auditId: null } as never);
  };
}

export class InMemoryMemory implements MemoryPeer {
  readonly name = "memory" as const;

  memories: string[] = [];
  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  retrieveContext: MemoryPeer["retrieveContext"] = async () => {
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok({
      memories: this.memories.map((content) => ({
        memory: { content } as never,
        score: 1,
        rankingScore: 1,
        signals: [],
      })),
      entities: [],
      relationships: [],
      signals: { dense: 0, graphConnected: 0, fused: 0 },
    });
  };
}

export class InMemoryFiles implements FilesPeer {
  readonly name = "files" as const;
  describeAttachment: FilesPeer["describeAttachment"] = async () => NOT_OFFERED() as never;
}

export class InMemoryCostMonitoring implements CostMonitoringPeer {
  readonly name = "cost-monitoring" as const;

  blocked = false;
  /** Every guard call, so a suite can assert it happened BEFORE any spending. */
  readonly guarded: { tier: string; agentId: string | null }[] = [];
  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  guardSpend: CostMonitoringPeer["guardSpend"] = async (command) => {
    this.guarded.push({ tier: command.intent.tier, agentId: command.intent.agentId });
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    if (!this.blocked) return ok({ allowed: true });
    return ok({
      allowed: false,
      refusal: {
        budget: {} as never,
        label: "monthly cap",
        limitCents: 100,
        current: { microCents: 0n, currency: "USD" } as never,
        projected: { microCents: 0n, currency: "USD" } as never,
      },
    });
  };
}

export class InMemoryJobs implements JobsPeer {
  readonly name = "jobs" as const;

  /** Every dispatched body, so a suite can assert the fan-out LEFT the request. */
  readonly dispatched: unknown[] = [];
  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  execute: JobsPeer["execute"] = async (request) => {
    this.dispatched.push(request.body);
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    return ok({ jobId: "job-1", status: "queued" } as never);
  };

  requestApproval: JobsPeer["requestApproval"] = async () => NOT_OFFERED() as never;
}
