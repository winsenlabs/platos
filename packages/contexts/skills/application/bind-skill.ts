// Use case: resolve the environment binding a loadout will point at.
//
// This is the seam between `agents` and `skills`, and its shape follows directly
// from ADR M0.3 §7 decision 5: `AgentSkill` belongs to `agents` because a
// loadout is authoring. So this context resolves and gates the ENVIRONMENT
// binding, hands back its id, and `agents` writes the agent-version link. The
// edge stays one-way and neither context writes the other's rows.
//
// THE READINESS GATE LIVES HERE, NOT IN `agents`. A skill whose required
// environment keys are not set is refused, with the missing NAMES returned so an
// operator can act. Putting the gate here is what stops every future caller from
// having to remember it — and there is more than one caller, because the same
// binding is reachable from the REST surface and from the runtime tooling.
//
// AN OFFICIAL SKILL IS INSTALLED ON DEMAND. Official rows carry no install until
// something binds one, so this path materialises the pair. Every other path
// reads without creating: a catalogue listing that installed what it listed
// would install the entire catalogue on first view.
//
// THE GATE IS A CHECK, NOT A PROMISE. Keys can be unset again after binding.
// That is why `composeRuntimeSkills` re-asks at load time and DROPS rather than
// fails — see its header. The two answers are deliberately different in kind.

import { err, ok, runResult, type Result, type TransactionScope } from "@platos/kernel";

import {
  environmentKeysMissing,
  isEnvironmentReady,
  missingKeys,
  shouldMaterialiseInstall,
  skillNotInstalled,
  type CatalogueEntry,
  type CatalogueScope,
  type Installation,
} from "../domain/index.js";
import type { SkillsDependencies } from "./dependencies.js";
import { installSkillInTransaction } from "./install-skill.js";
import { findVisibleSkill } from "./read-catalogue.js";

export interface BindSkillCommand {
  readonly scope: CatalogueScope;
  /** A row id or a slug. */
  readonly reference: string;
}

export interface BoundSkill {
  readonly entry: CatalogueEntry;
  readonly installation: Installation;
}

/** Refuse unless every required key is set right now. */
async function requireEnvironmentReady(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  entry: CatalogueEntry,
): Promise<Result<null>> {
  const required = entry.requiredEnvironmentKeys;
  if (required.length === 0) return ok(null);
  const presence = await dependencies.environmentKeys.presenceOf(scope.environment, required);
  if (!presence.ok) return err(presence.error);
  if (isEnvironmentReady(required, presence.value)) return ok(null);
  return err(environmentKeysMissing(entry.identity.slug, missingKeys(required, presence.value)));
}

async function resolveInstallation(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  entry: CatalogueEntry,
  transaction: TransactionScope,
): Promise<Result<Installation>> {
  if (shouldMaterialiseInstall(entry.isOfficial)) {
    return installSkillInTransaction(dependencies, scope, entry, transaction);
  }
  const found = await dependencies.repository.findInstallation(scope, entry.skillId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(skillNotInstalled(entry.identity.slug));
  return ok(found.value);
}

export async function bindSkill(
  dependencies: SkillsDependencies,
  command: BindSkillCommand,
): Promise<Result<BoundSkill>> {
  const entry = await findVisibleSkill(dependencies, command.scope, command.reference);
  if (!entry.ok) return err(entry.error);

  // The gate runs BEFORE anything is written. An official skill refused for
  // missing keys must not leave a materialised install behind as a side effect
  // of having been refused.
  const ready = await requireEnvironmentReady(dependencies, command.scope, entry.value);
  if (!ready.ok) return err(ready.error);

  const installation = await runResult(dependencies.unitOfWork, (transaction) =>
    resolveInstallation(dependencies, command.scope, entry.value, transaction),
  );
  if (!installation.ok) return err(installation.error);
  return ok({ entry: entry.value, installation: installation.value });
}

/**
 * Resolve a binding WITHOUT creating one and WITHOUT gating on readiness.
 *
 * The read-only counterpart, for callers that need to know what a loadout points
 * at rather than to establish one — unbinding, and reading a binding's config.
 * It must not materialise, because unbinding something that was never installed
 * would otherwise install it first.
 */
export async function findBinding(
  dependencies: SkillsDependencies,
  command: BindSkillCommand,
): Promise<Result<BoundSkill | null>> {
  const entry = await dependencies.repository.findVisibleSkillByReference(
    command.scope,
    command.reference,
  );
  if (!entry.ok) return err(entry.error);
  if (entry.value === null) return ok(null);
  const installation = await dependencies.repository.findInstallation(command.scope, entry.value.skillId);
  if (!installation.ok) return err(installation.error);
  if (installation.value === null) return ok(null);
  return ok({ entry: entry.value, installation: installation.value });
}
