// Use cases: the inbound MCP surface's exposure decision.
//
// `EntityToolPolicy` says which of an entity's tools a third party calling
// `/mcp/entity/:id` may use, and under what identity. DEFAULT-DENY: an exposure
// with no policy row is not exposed, and `listEntityToolPolicies` completes the
// listing with the synthetic denials `domain/entity-policy.ts` mints so an
// operator has something to switch on without a write having happened first.
//
// THE ALLOWLIST CACHE IS RESYNCED AFTER EVERY MUTATION AND IS NEVER READ HERE.
// `EntityMcpConfig.toolAllowlist` is a denormalised copy of the exposed names,
// kept so a hot path can answer without a join. Writing it is the last step of
// every mutation below; reading it as the decision is what would let a failed
// sync leave a tool exposed after its policy said otherwise. The authority is
// the policy rows, always.

import { err, ok, type EntityId, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  asToolsIdentifier,
  effectiveIdentityMode,
  encodeLabels,
  entityNotInScope,
  exposedToolNames,
  filterForCaller,
  mcpDisabled,
  synthesizeDenial,
  toolNotFound,
  type ActorId,
  type EntityToolPolicy,
  type EntityToolPolicyId,
  type IdentityMode,
  type McpCaller,
  type ToolExposure,
  type ToolId,
} from "../domain/index.js";
import {
  requireAccess,
  verifyMcpCaller,
  verifyOperator,
  type PrincipalAuthorizationView,
} from "./authorization.js";
import type { ToolsDependencies } from "./dependencies.js";

export interface ReadEntityToolPoliciesQuery {
  readonly authorization: unknown;
  readonly entityId: EntityId;
  /** Filter to exposed / not-exposed. Absent means both. */
  readonly exposed?: boolean | null;
}

/**
 * Every exposure of an entity, each with its policy or its synthetic denial.
 *
 * The COMPLETION is what makes this surface usable. Listing only the rows that
 * exist would show an operator an empty page for a freshly discovered entity —
 * the exact moment they need the page most.
 */
export async function listEntityToolPolicies(
  dependencies: ToolsDependencies,
  query: ReadEntityToolPoliciesQuery,
): Promise<Result<readonly EntityToolPolicy[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const exposures = await dependencies.repository.listEntityExposures(scope, query.entityId);
  if (!exposures.ok) return err(exposures.error);
  const policies = await dependencies.repository.listEntityToolPolicies(scope, query.entityId);
  if (!policies.ok) return err(policies.error);

  const byToolId = new Map(policies.value.map((policy) => [policy.toolId, policy]));
  const completed = exposures.value
    .filter((exposure) => exposure.enabled)
    .map(
      (exposure) =>
        byToolId.get(exposure.toolId) ??
        synthesizeDenial(
          {
            environmentId: scope.environmentId,
            entityId: query.entityId,
            toolId: exposure.toolId,
            toolName: exposure.toolName,
          },
          dependencies.policy.acl,
        ),
    );

  if (query.exposed === null || query.exposed === undefined) return ok(completed);
  return ok(completed.filter((policy) => (policy.effect === "ALLOW") === query.exposed));
}

export interface SetEntityToolPolicyCommand {
  readonly authorization: unknown;
  readonly entityId: EntityId;
  readonly toolId: ToolId;
  readonly exposed?: boolean;
  readonly minIdentityMode?: IdentityMode;
  readonly scopeLabels?: readonly string[];
  readonly allowedPatIds?: readonly string[];
}

/**
 * Write one policy, then resync the allowlist cache.
 *
 * A PARTIAL PATCH KEEPS WHAT IT DOES NOT MENTION. The two halves of the label
 * column are patched independently — supplying `scopeLabels` alone must not
 * silently revoke every permitted token — so the current value of the other
 * half is read and re-encoded with it. That is the one place the two meanings
 * packed into one `String[]` could quietly destroy each other.
 */
export async function setEntityToolPolicy(
  dependencies: ToolsDependencies,
  command: SetEntityToolPolicyCommand,
): Promise<Result<EntityToolPolicy>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const permitted = requireAccess(granted.value, "secret:mutate");
  if (!permitted.ok) return err(permitted.error);
  const scope = granted.value.scope;

  const exposures = await dependencies.repository.listEntityExposures(scope, command.entityId);
  if (!exposures.ok) return err(exposures.error);
  const exposure = exposures.value.find((candidate) => candidate.toolId === command.toolId);
  if (exposure === undefined) return err(toolNotFound(command.toolId));

  const policies = await dependencies.repository.listEntityToolPolicies(scope, command.entityId);
  if (!policies.ok) return err(policies.error);
  const current =
    policies.value.find((policy) => policy.toolId === command.toolId) ??
    synthesizeDenial(
      {
        environmentId: scope.environmentId,
        entityId: command.entityId,
        toolId: command.toolId,
        toolName: exposure.toolName,
      },
      dependencies.policy.acl,
    );

  const scopeLabels = command.scopeLabels ?? current.scopeLabels;
  const allowedPatIds = command.allowedPatIds ?? current.allowedPatIds;
  const encoded = encodeLabels(scopeLabels, allowedPatIds);

  const next: EntityToolPolicy = {
    ...current,
    entityToolPolicyId:
      current.addedAt === null
        ? asToolsIdentifier<EntityToolPolicyId>(dependencies.ids.uuid())
        : current.entityToolPolicyId,
    effect: command.exposed === undefined ? current.effect : command.exposed ? "ALLOW" : "DENY",
    minIdentityMode: command.minIdentityMode ?? current.minIdentityMode,
    scopeLabels: encoded.filter((label) => !label.startsWith("platos:pat:")),
    allowedPatIds,
    addedBy: asToolsIdentifier<ActorId>(granted.value.actorUserId),
    addedAt: current.addedAt ?? dependencies.clock.now(),
  };

  const saved = await dependencies.repository.upsertEntityToolPolicy(next);
  if (!saved.ok) return err(saved.error);

  const resynced = await resyncAllowlist(dependencies, scope, command.entityId);
  if (!resynced.ok) return err(resynced.error);
  return ok(saved.value);
}

/**
 * Recompute `EntityMcpConfig.toolAllowlist` from the policy rows.
 *
 * Returned as a `Result` and propagated rather than swallowed. An audit write
 * that fails is a lost record; an allowlist that fails to shrink is a tool
 * still reachable after an operator revoked it, and the operator must be told
 * their revocation did not land.
 */
export async function resyncAllowlist(
  dependencies: ToolsDependencies,
  scope: EnvironmentScope,
  entityId: EntityId,
): Promise<Result<readonly string[]>> {
  const policies = await dependencies.repository.listEntityToolPolicies(scope, entityId);
  if (!policies.ok) return err(policies.error);
  const names = exposedToolNames(policies.value);

  const config = await dependencies.repository.findMcpConfig(scope, entityId);
  if (!config.ok) return err(config.error);
  if (config.value === null) return ok(names);

  const saved = await dependencies.repository.saveMcpConfig(scope, {
    ...config.value,
    toolAllowlist: names,
    updatedAt: dependencies.clock.now(),
  });
  return saved.ok ? ok(names) : err(saved.error);
}

export interface ListCallableForMcpCallerQuery {
  readonly scope: EnvironmentScope;
  readonly entityId: EntityId;
  /**
   * The credential the third party presented on `/mcp/entity/:id`.
   *
   * NULL IS A REFUSAL, NOT AN ANONYMOUS CALLER. `IdentityMode` has an
   * `anonymous` rank and this surface does not reach it: an unauthenticated
   * request is denied here, before any policy row is read, and a surface that
   * genuinely wants anonymous callers would have to say so through a
   * deliberately authenticated principal rather than through the absence of one.
   */
  readonly presentedToken: string | null;
}

/**
 * The caller, DERIVED from what identity-access verified — never asserted.
 *
 * The earlier shape took an `McpCaller` as an ARGUMENT, which made the whole
 * ACL below a function of what the caller claimed about itself: a request
 * naming `mcp:pat:<someone-else>` with the labels it wished it held was
 * indistinguishable from one that actually held them. Every field here now
 * comes off the verified principal instead.
 *
 * `identityMode` is `bearer` BY CONSTRUCTION, not by choice. This use case
 * authenticates through `authenticateBearer`, so a caller that reaches this
 * line presented a bearer credential and is a bearer caller. A surface
 * configured for `oidc` therefore admits none of them, which is
 * `effectiveIdentityMode`'s floor doing exactly what it is for.
 */
function callerOf(principal: PrincipalAuthorizationView): McpCaller {
  return {
    identityMode: "bearer",
    principalId: principal.principalId,
    scopes: principal.permissions,
  };
}

/**
 * What one AUTHENTICATED inbound caller may see — the `tools/list` answer.
 *
 * FOUR GATES, IN THIS ORDER, AND THE ORDER IS THE FAIL-CLOSED ARGUMENT:
 *
 *   1. WHO. `verifyMcpCaller` asks identity-access, one way, at the moment of
 *      the call — ADR M0.3 §3's `auth -> tool-gateway` fix. An absent, unknown,
 *      revoked, wrong-scope or `mcp:tools`-less credential is refused here,
 *      before this environment's policy rows have been read at all, so a
 *      credential that is not for this scope cannot make it do work.
 *
 *   2. IS THE SURFACE ON. `EntityMcpConfig.enabled` is the operator kill
 *      switch and it defaults to false. Consulted BEFORE the listing rather
 *      than after, so switching a surface off takes effect on the next call —
 *      not once the allowlist cache happens to be resynced.
 *
 *   3. WHICH TOOLS THIS CALLER'S IDENTITY REACHES. The policy rows, floored by
 *      the surface's own identity mode. The floor is applied HERE rather than
 *      inside `permitsCaller` because it is a property of the SURFACE and the
 *      predicate is about one policy row; taking the weaker of the two would
 *      let a per-tool setting downgrade the surface.
 *
 *   4. WHICH OF THEM THE ENTITY STILL OFFERS. A policy outliving its exposure
 *      is the common case — an operator exposes a tool, the backend stops
 *      declaring it, and the policy row is untouched — and listing it would
 *      offer a model a tool that cannot be dispatched.
 *
 * THE ALLOWLIST CACHE IS STILL NOT READ. Gate 3 goes to the policy rows, as
 * the header note requires; `toolAllowlist` is a denormalisation and a reader
 * that consulted it would expose whatever the last successful sync left behind.
 */
export async function listCallableForMcpCaller(
  dependencies: ToolsDependencies,
  query: ListCallableForMcpCallerQuery,
): Promise<Result<readonly ToolExposure[]>> {
  const principal = await verifyMcpCaller(dependencies, query.presentedToken, query.scope);
  if (!principal.ok) return err(principal.error);

  const config = await dependencies.repository.findMcpConfig(query.scope, query.entityId);
  if (!config.ok) return err(config.error);
  if (config.value === null) return err(entityNotInScope(query.entityId));
  if (!config.value.enabled) return err(mcpDisabled(query.entityId));

  const policies = await dependencies.repository.listEntityToolPolicies(query.scope, query.entityId);
  if (!policies.ok) return err(policies.error);
  const exposures = await dependencies.repository.listEntityExposures(query.scope, query.entityId);
  if (!exposures.ok) return err(exposures.error);

  const surface = config.value;
  const floored = policies.value.map((policy) => ({
    ...policy,
    minIdentityMode: effectiveIdentityMode(surface, policy.minIdentityMode),
  }));
  const permitted = new Set(
    filterForCaller(floored, callerOf(principal.value)).map((policy) => policy.toolId),
  );
  return ok(
    exposures.value.filter(
      (exposure) => permitted.has(exposure.toolId) && exposure.enabled && exposure.dispatchable,
    ),
  );
}
