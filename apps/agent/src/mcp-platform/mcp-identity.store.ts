// The ORM seam behind the inbound MCP identity resolver.
//
// WIN-268 P2. `identity-resolver.service.ts` held five statements across three
// contexts' rows and the admission decision that runs on them. This module takes
// the five; the decision stays where it belongs.
//
// ---------------------------------------------------------------------------
// THREE OWNERS, ONE FILE, AND THAT IS THE FINDING RATHER THAN A TIDY-UP
//
// `scripts/arch/table-ownership.mjs` gives the five statements to THREE
// different contexts:
//
//   `EntityMcpConfig`      -> `tools`            (ADR M0.3 §1 row 7)
//   `McpAnonymousSession`  -> `identity-access`  (ADR M0.3 §1 row 1)
//   `Environment`          -> `tenancy`          (ADR M0.3 §1 row 2)
//
// and the three are in three different states with respect to a published use
// case, which is worth recording precisely because "route it to the contract"
// has three different answers here:
//
//   `tools` publishes `describeMcpSurface`, which is exactly the
//   `entityMcpConfig` read below — the use case EXISTS. The context is not
//   composed (no `ToolDispatch` adapter; WIN-269's scope).
//
//   `tenancy` IS composed, and this environment read is a scoped existence
//   check of the shape its contract already answers.
//
//   `identity-access` IS composed and publishes NO use case for this at all,
//   and that is deliberate on its side rather than an oversight on ours. Its
//   contract's own banner says: "WHAT IS DELIBERATELY ABSENT: minting. No other
//   context may issue a session, a magic link, an access key or an OAuth pair."
//   `getOrCreateAnonSession` MINTS `McpAnonymousSession`. So this is a call site
//   where the contract does not merely lack a method — it refuses to have one,
//   and a tranche that added `mintAnonymousMcpSession` to
//   `IdentityAccessContract` would be reversing a decision that context took on
//   purpose. STOPPED HERE, reported, not worked around.
//
// The `apps/agent` process cannot call any of the three regardless — see
// `mcp-policy.store.ts`'s header for the three independent measurements.

import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { type ControlDatabaseClient, PRISMA_TOKEN } from "../shared/database.provider";

/** The `EntityMcpConfig` fields the resolver decides on. */
export interface McpSurfaceState {
  readonly identityMode: string | null;
  readonly enabled: boolean;
}

export interface AnonymousSession {
  readonly id: string;
  readonly mcpUserId: string;
}

export interface AnonymousSessionSeed {
  readonly firstSeenIp: string | null;
  readonly userAgent: string | null;
}

export interface McpIdentityReader {
  /** `tools`' `describeMcpSurface`, in the shape this resolver needs. */
  readMcpSurface(entityId: string): Promise<McpSurfaceState | null>;
  /**
   * `tenancy`: is this environment live, and does it hang off a project that
   * owns this entity?
   *
   * THE ENTITY JOIN IS THE COHERENCE CHECK AND IT WAS ALREADY HERE. Unlike the
   * operator surfaces this tranche had to harden, the extraction source already
   * refused to accept an environment id that does not belong to the entity being
   * addressed — `project: { entities: { some: { id: entityId } } }` — so there is
   * no forged-scope hole to close on this path and none has been invented.
   */
  findActiveEnvironmentForEntity(entityId: string, environmentId: string): Promise<string | null>;
  findLiveAnonymousSession(
    entityId: string,
    environmentId: string,
    mcpUserId: string,
  ): Promise<AnonymousSession | null>;
  touchAnonymousSession(id: string): Promise<void>;
  /** MINTS. `identity-access` publishes no contract method for this on purpose. */
  createAnonymousSession(
    entityId: string,
    environmentId: string,
    seed: AnonymousSessionSeed,
  ): Promise<AnonymousSession>;
}

@Injectable()
export class McpIdentityStore implements McpIdentityReader {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient) {}

  async readMcpSurface(entityId: string): Promise<McpSurfaceState | null> {
    const config = await this.prisma.entityMcpConfig.findUnique({
      where: { entityId },
      select: { identityMode: true, enabled: true },
    });
    return config ? { identityMode: config.identityMode, enabled: config.enabled } : null;
  }

  async findActiveEnvironmentForEntity(
    entityId: string,
    environmentId: string,
  ): Promise<string | null> {
    const environments = await this.prisma.environment.findMany({
      where: {
        id: environmentId,
        archivedAt: null,
        project: { entities: { some: { id: entityId } } },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 1,
    });
    return environments[0]?.id ?? null;
  }

  async findLiveAnonymousSession(
    entityId: string,
    environmentId: string,
    mcpUserId: string,
  ): Promise<AnonymousSession | null> {
    const existing = await this.prisma.mcpAnonymousSession.findFirst({
      where: { mcpUserId, entityId, environmentId, revokedAt: null },
      select: { id: true, mcpUserId: true },
    });
    return existing ?? null;
  }

  /**
   * Stamp `lastUsedAt`, best effort.
   *
   * FIRE-AND-FORGET IS PRESERVED FROM THE EXTRACTION SOURCE, which called this
   * with `void ... .catch(() => undefined)`. It is a liveness stamp, not an
   * authorization fact: an anonymous session that is admitted and then fails to
   * record that it was used is still admitted, and making the admission depend
   * on the stamp would turn a write hiccup into an outage of the surface.
   */
  async touchAnonymousSession(id: string): Promise<void> {
    try {
      await this.prisma.mcpAnonymousSession.update({
        where: { id },
        data: { lastUsedAt: new Date() },
      });
    } catch {
      // Deliberate: see the note above.
    }
  }

  async createAnonymousSession(
    entityId: string,
    environmentId: string,
    seed: AnonymousSessionSeed,
  ): Promise<AnonymousSession> {
    return this.prisma.mcpAnonymousSession.create({
      data: {
        entityId,
        environmentId,
        mcpUserId: `mcp:anon:${randomUUID().replace(/-/g, "")}`,
        firstSeenIp: seed.firstSeenIp,
        userAgent: seed.userAgent,
      },
      select: { id: true, mcpUserId: true },
    });
  }
}
