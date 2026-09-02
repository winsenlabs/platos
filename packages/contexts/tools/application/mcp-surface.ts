// Use cases: the hosted MCP surface's configuration, and the audit trail.
//
// `EntityMcpConfig` is one row per entity and its `enabled` flag is what makes
// `/mcp/entity/:id` reachable at all. Every mutation here is behind
// `secret:mutate`, and the tools that drive them are tier-1 gated in
// `domain/platform-baseline.ts` — two independent gates on the same decision,
// because turning it on gives a third party a public endpoint into a customer's
// tool set.
//
// THE AUDIT READ LIVES HERE RATHER THAN IN ITS OWN FILE BECAUSE IT ANSWERS THE
// SAME OPERATOR QUESTION. "What is this surface exposed as, and what has been
// called through it" is one investigation, and splitting it across two files
// would put the window clamp and the exposure flag in different places.

import { err, ok, type EntityId, type Result } from "@platos/kernel";

import {
  admitAuditQuery,
  admitRateLimit,
  auditWindowStart,
  entityNotInScope,
  isHostReady,
  type AuditEntry,
  type AuditQuery,
  type EntityMcpConfig,
  type IdentityMode,
} from "../domain/index.js";
import { requireAccess, verifyOperator } from "./authorization.js";
import type { ToolsDependencies } from "./dependencies.js";

export interface DescribeMcpSurfaceQuery {
  readonly authorization: unknown;
  readonly entityId: EntityId;
}

export interface McpSurfaceState {
  readonly config: EntityMcpConfig;
  /** Enabled AND holding at least one exposed tool. See `domain/mcp-config.ts`. */
  readonly ready: boolean;
}

export async function describeMcpSurface(
  dependencies: ToolsDependencies,
  query: DescribeMcpSurfaceQuery,
): Promise<Result<McpSurfaceState>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const config = await dependencies.repository.findMcpConfig(granted.value.scope, query.entityId);
  if (!config.ok) return err(config.error);
  if (config.value === null) return err(entityNotInScope(query.entityId));
  return ok({ config: config.value, ready: isHostReady(config.value) });
}

export interface ConfigureMcpSurfaceCommand extends DescribeMcpSurfaceQuery {
  readonly enabled?: boolean;
  readonly identityMode?: IdentityMode;
  readonly rateLimitPerMinute?: number;
  readonly redirectUriAllowlist?: readonly string[];
  readonly injectMcpContext?: boolean;
}

/**
 * Patch the hosted surface.
 *
 * `toolAllowlist` is NOT patchable through this command, deliberately. It is a
 * derived cache of `EntityToolPolicy` and the only writer is
 * `application/entity-tool-policy.ts`'s resync. Exposing it here would let an
 * operator grant a tool by editing a cache, and the grant would survive exactly
 * until the next policy mutation recomputed it — a permission that silently
 * expires is worse than one that was never granted.
 */
export async function configureMcpSurface(
  dependencies: ToolsDependencies,
  command: ConfigureMcpSurfaceCommand,
): Promise<Result<McpSurfaceState>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const permitted = requireAccess(granted.value, "secret:mutate");
  if (!permitted.ok) return err(permitted.error);
  const scope = granted.value.scope;

  const existing = await dependencies.repository.findMcpConfig(scope, command.entityId);
  if (!existing.ok) return err(existing.error);
  if (existing.value === null) return err(entityNotInScope(command.entityId));

  let rateLimitPerMinute = existing.value.rateLimitPerMinute;
  if (command.rateLimitPerMinute !== undefined) {
    const admitted = admitRateLimit(command.rateLimitPerMinute);
    if (!admitted.ok) return err(admitted.error);
    rateLimitPerMinute = admitted.value;
  }

  const next: EntityMcpConfig = {
    ...existing.value,
    enabled: command.enabled ?? existing.value.enabled,
    identityMode: command.identityMode ?? existing.value.identityMode,
    rateLimitPerMinute,
    redirectUriAllowlist: command.redirectUriAllowlist ?? existing.value.redirectUriAllowlist,
    injectMcpContext: command.injectMcpContext ?? existing.value.injectMcpContext,
    updatedAt: dependencies.clock.now(),
  };
  const saved = await dependencies.repository.saveMcpConfig(scope, next);
  if (!saved.ok) return err(saved.error);
  return ok({ config: saved.value, ready: isHostReady(saved.value) });
}

export interface ReadToolAuditQuery extends Partial<AuditQuery> {
  readonly authorization: unknown;
}

/**
 * Page the audit trail, newest first.
 *
 * The window is clamped rather than refused (see `domain/audit.ts`) and the
 * start instant is computed HERE from the clock port, not inside the adapter.
 * An adapter reading the wall clock would make the boundary of a paged listing
 * move between the count and the page.
 */
export async function readToolAudit(
  dependencies: ToolsDependencies,
  query: ReadToolAuditQuery,
): Promise<Result<readonly AuditEntry[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const admitted = admitAuditQuery(query);
  const listed = await dependencies.repository.pageAudit(granted.value.scope, admitted);
  if (!listed.ok) return err(listed.error);

  const since = auditWindowStart(admitted, dependencies.clock.now());
  return ok(listed.value.filter((entry) => entry.createdAt.getTime() >= since.getTime()));
}
