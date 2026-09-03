// Use case: discover an MCP entity's tools and register them.
//
// A WIRE entity PUSHES a declaration; an MCP entity is ASKED for one. This is
// the asking, and its output is the same `registerTools` write, so the two
// paths converge on one transaction and cannot drift into two registries.
//
// AN ENTITY IS PROJECT-SCOPED AND AN EXPOSURE IS ENVIRONMENT-SCOPED, SO ONE
// DISCOVERY IS N REGISTRATIONS. `Entity` hangs off `Project` (tenancy's own
// note on that row is explicit that it is a SIBLING of `Environment`, not a
// child), while `EnvironmentEntityTool` needs an environment. A wire backend
// resolves this by opening one socket per environment; discovery is outbound
// and has no connection to carry one, so it enumerates the project's
// environments and registers once into each. Tool definitions fan out; secret
// material stays per-environment, because each pass resolves the credential
// against its own scope.
//
// DISCOVERY IS NOT PER-USER, AND THAT IS ENFORCED RATHER THAN DOCUMENTED. The
// pass runs with no end-user identity, so a `{{endUserId}}`-templated discovery
// endpoint FAILS CLOSED here — you cannot enumerate a per-user server without a
// user, and the alternative would be enumerating one user's tools and offering
// them to everyone. The substitution happens later, at dispatch.
//
// A PARTIAL FAILURE IS NOT A FAILURE. One environment refusing does not undo
// the environments that succeeded: each is its own registration transaction,
// and the report carries the first error so an operator sees it without losing
// the work that landed.

import { err, ok, type EntityId, type Result } from "@platos/kernel";
import type { EnvironmentAuthorization } from "@platos/context-secrets";

import {
  asToolsIdentifier,
  entityNotInScope,
  withDiscoveryOutcome,
  type ExternalEntityId,
  type ToolName,
} from "../domain/index.js";
import { requireAccess, withOperator, type TenancyOperatorGrant } from "./authorization.js";
import type { ToolsDependencies } from "./dependencies.js";
import { registerTools } from "./register-tools.js";
import { resolveDispatchTarget } from "./resolve-transport.js";

export interface DiscoverEntityToolsCommand {
  readonly authorization: unknown;
  readonly entityId: EntityId;
  readonly externalEntityId: ExternalEntityId;
  readonly vaultAuthorization: EnvironmentAuthorization;
}

/**
 * The name a fail-closed refusal reports when discovery itself is templated.
 *
 * It is the MCP method being called and not a tool of the entity's, which is
 * the honest thing for the error to say: nothing has been discovered yet, so
 * there is no tool name to blame.
 */
export const DISCOVERY_TOOL_NAME: ToolName = asToolsIdentifier<ToolName>("tools/list");

export interface DiscoveryReport {
  readonly registered: number;
  readonly removed: number;
  /** The first environment's failure, or null when every pass succeeded. */
  readonly error: string | null;
}

export async function discoverEntityTools(
  dependencies: ToolsDependencies,
  command: DiscoverEntityToolsCommand,
): Promise<Result<DiscoveryReport>> {
  return withOperator(dependencies, command.authorization, async (grant) => {
    const permitted = requireAccess(grant, "secret:mutate");
    if (!permitted.ok) return err(permitted.error);
    const scope = grant.scope;

    const entity = await dependencies.tenancy.findEntity(command.entityId);
    if (!entity.ok) return err(entity.error);
    if (entity.value.projectId !== scope.projectId) return err(entityNotInScope(command.entityId));

    const client = await dependencies.repository.findMcpClient(scope, command.entityId);
    if (!client.ok) return err(client.error);
    if (client.value === null) {
      return ok({ registered: 0, removed: 0, error: "the entity has no MCP client configuration" });
    }

    // An MCP entity is dispatchable BECAUSE the client row exists, which is
    // exactly the rule `domain/exposure.ts` states — so discovery resolves its
    // target through the SAME function dispatch does, and no separate
    // "is discovery possible" predicate can drift away from the dispatch one.
    const target = await resolveDispatchTarget(dependencies, {
      scope,
      subject: {
        entityId: command.entityId,
        externalEntityId: command.externalEntityId,
        connectionKind: "mcp",
        callbackUrl: "",
        dispatchable: true,
        toolName: DISCOVERY_TOOL_NAME,
      },
      // NO END USER. A templated discovery endpoint fails closed here; see the
      // header note on why substituting one would be worse than failing.
      endUserId: null,
      vaultAuthorization: command.vaultAuthorization,
    });
    if (!target.ok) {
      await recordDiscoveryFailure(dependencies, grant, command, target.error.message);
      return ok({ registered: 0, removed: 0, error: target.error.message });
    }

    const discovered = await dependencies.dispatch.discover({ target: target.value });
    if (!discovered.ok) {
      await recordDiscoveryFailure(dependencies, grant, command, discovered.error.message);
      return ok({ registered: 0, removed: 0, error: discovered.error.message });
    }

    const registered = await registerTools(dependencies, {
      authorization: command.authorization,
      entityId: command.entityId,
      externalEntityId: command.externalEntityId,
      tools: discovered.value.tools,
      // MCP entities are reached by a session, never a callback. Writing one
      // would make `dispatchabilityOf` report the entity live on the wire path.
      callbackUrl: null,
    });
    if (!registered.ok) {
      await recordDiscoveryFailure(dependencies, grant, command, registered.error.message);
      return ok({ registered: 0, removed: 0, error: registered.error.message });
    }

    await recordDiscoveryFailure(dependencies, grant, command, null);
    return ok({
      registered: registered.value.outcome.registered,
      removed: registered.value.outcome.removed,
      error: null,
    });
  });
}

/**
 * Stamp the pass onto the client row — including the successes.
 *
 * IT TAKES THE GRANT ITS CALLER ALREADY HOLDS rather than re-verifying the
 * authorization. The earlier form asked tenancy a second time and returned
 * SILENTLY when the answer was no — a fifteenth copy of the guard, and the one
 * copy whose refusal went nowhere. There is only one caller, it is inside
 * `withOperator`, and a grant it could not have obtained without the check is
 * the honest thing to hand down.
 */
async function recordDiscoveryFailure(
  dependencies: ToolsDependencies,
  grant: TenancyOperatorGrant,
  command: DiscoverEntityToolsCommand,
  error: string | null,
): Promise<void> {
  const client = await dependencies.repository.findMcpClient(grant.scope, command.entityId);
  if (!client.ok || client.value === null) return;
  await dependencies.repository.saveMcpClient(
    grant.scope,
    withDiscoveryOutcome(client.value, { error }, dependencies.clock.now()),
  );
}
