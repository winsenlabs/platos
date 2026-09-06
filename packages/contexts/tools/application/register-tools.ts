// Use case: register one entity's complete tool declaration in one environment.
//
// DECLARATIVE REPLACE, NOT INCREMENTAL MERGE. Whatever the declaration names is
// exposed; whatever it does not is deleted. That is the property the source
// calls out and it is the reason the registry can SHRINK — an incremental
// registry only ever grows, so a backend that dropped a tool keeps offering it
// to every model in the environment until somebody notices.
//
// THE WRITE IS IN TWO TIERS AND ONLY ONE OF THEM IS TENANT-SCOPED.
//
//   `Tool` rows are installation-global and content-addressed. An upsert here
//   is find-or-create: an identical shape finds the row two other organizations
//   are already using, and a changed shape mints a new one. Nothing is updated,
//   so no other environment's exposure changes under it.
//
//   `EnvironmentEntityTool` rows are the tenant-scoped part, and they are
//   replaced wholesale for exactly one (environment, entity) pair.
//
// The two happen in ONE unit of work. A `Tool` minted without its exposure is
// harmless garbage; an exposure pointing at a `Tool` that was rolled back is a
// foreign key violation on the next read, so the boundary wraps both.

import { err, ok, runResult, type EntityId, type Result } from "@platos/kernel";

import {
  admitDeclaration,
  canonicalToolDocument,
  declaredNames,
  entityNotInScope,
  registrationOutcome,
  toSchemaHash,
  type AdmittedTool,
  type ExternalEntityId,
  type RegistrationOutcome,
  type ToolDeclarationIntake,
  type ToolExposure,
  type ToolId,
} from "../domain/index.js";
import { requireAccess, withOperator } from "./authorization.js";
import type { ToolsDependencies } from "./dependencies.js";
import type { ToolUpsert } from "./ports/index.js";

export interface RegisterToolsCommand {
  readonly authorization: unknown;
  readonly entityId: EntityId;
  /** The entity's own name for itself. Verified against the tenancy record. */
  readonly externalEntityId: ExternalEntityId;
  readonly tools: readonly ToolDeclarationIntake[];
  /**
   * Where a wire call is delivered. Null for an MCP entity, which is reached
   * by a session rather than a callback.
   */
  readonly callbackUrl: string | null;
}

export interface RegisteredTools {
  readonly outcome: RegistrationOutcome;
  readonly exposures: readonly ToolExposure[];
}

export async function registerTools(
  dependencies: ToolsDependencies,
  command: RegisterToolsCommand,
): Promise<Result<RegisteredTools>> {
  return withOperator(dependencies, command.authorization, async (grant) => {
    const permitted = requireAccess(grant, "secret:mutate");
    if (!permitted.ok) return err(permitted.error);
    const scope = grant.scope;

    // The entity is TENANCY's, and the two identifiers a caller supplies for it
    // must agree with each other AND with the record. The source checks both in
    // one `findFirst`; here the check is explicit, because a caller that
    // supplied a real entity id and somebody else's external id would otherwise
    // register that entity's tools under this one's name in every `ToolHealth`
    // row.
    const entity = await dependencies.tenancy.findEntity(command.entityId);
    if (!entity.ok) return err(entity.error);
    if (
      entity.value.externalId !== command.externalEntityId ||
      entity.value.projectId !== scope.projectId
    ) {
      return err(entityNotInScope(command.entityId));
    }

    const declaration = admitDeclaration(command.tools, command.externalEntityId);
    if (!declaration.ok) return err(declaration.error);

    const previous = await dependencies.repository.listEntityExposures(scope, command.entityId);
    if (!previous.ok) return err(previous.error);

    return runResult(dependencies.unitOfWork, async () => {
      const toolIds: ToolId[] = [];
      for (const tool of declaration.value) {
        const minted = await mintTool(dependencies, tool);
        if (!minted.ok) return err(minted.error);
        toolIds.push(minted.value);
      }

      const replaced = await dependencies.repository.replaceExposures({
        scope,
        entityId: command.entityId,
        callbackUrl: command.callbackUrl,
        toolIds,
      });
      if (!replaced.ok) return err(replaced.error);

      return ok({
        outcome: registrationOutcome({
          registeredToolIds: toolIds,
          previousToolIds: new Set(previous.value.map((exposure) => exposure.toolId)),
          previousNames: previous.value.map((exposure) => exposure.toolName),
          declared: declaredNames(declaration.value),
        }),
        exposures: replaced.value,
      });
    });
  });
}

/**
 * Find-or-create one content-addressed `Tool` row.
 *
 * The digest is taken over the canonical document from `domain/tool.ts` and
 * truncated by the rule there. Doing the lookup BEFORE the upsert is not an
 * optimisation: it is what makes a re-registration of an unchanged declaration
 * touch no rows at all, which is the common case every time a backend restarts.
 */
async function mintTool(
  dependencies: ToolsDependencies,
  tool: AdmittedTool,
): Promise<Result<ToolId>> {
  const hash = toSchemaHash(dependencies.digest.sha256Hex(canonicalToolDocument(tool)));
  if (!hash.ok) return err(hash.error);

  const existing = await dependencies.repository.findToolByFingerprint(tool.name, hash.value);
  if (!existing.ok) return err(existing.error);
  if (existing.value !== null) return ok(existing.value.toolId);

  const upsert: ToolUpsert = {
    name: tool.name,
    description: tool.description,
    paramSchema: tool.paramSchema,
    category: tool.category,
    schemaHash: hash.value,
  };
  const created = await dependencies.repository.upsertTool(upsert);
  return created.ok ? ok(created.value.toolId) : err(created.error);
}
