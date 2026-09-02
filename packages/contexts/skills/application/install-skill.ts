// Use case: install a catalogue entry into an environment, and remove it again.
//
// An install is the `ProjectSkill` / `EnvironmentSkill` pair, created TOP-DOWN
// in one transaction: the project adoption first, then the environment binding
// keyed by the adoption's row id. The order is not stylistic — the second row
// cannot be addressed until the first exists, so a half-made install is not
// representable rather than merely unlikely.
//
// BOTH HALVES ARE UPSERTS THAT RE-ENABLE. Installing something already installed
// switches it back on rather than failing. Delivery is at-least-once everywhere
// in this system and an operator clicking twice is ordinary; an idempotent
// repeat must not be an error.
//
// UNINSTALL REMOVES ONE ENVIRONMENT'S BINDING AND NOTHING ELSE. The project
// adoption survives, so a sibling environment keeps working. The catalogue row
// survives, because it is organization-owned and one environment may not delete
// it. And an official row cannot be uninstalled at all — for it, "uninstall"
// would either be a no-op dressed as success or a catalogue deletion with an
// organization-wide blast radius.
//
// AN UNINSTALL THAT REMOVED NOTHING SAYS SO. The live surface answers
// `{ removed: true }` unconditionally, including when the row was official or
// absent, which is a claim it has not checked. This use case returns what
// actually happened and why; preserving the wire shape, if that is wanted, is
// the transport's decision to make with the truth in hand rather than without it.

import { err, ok, type Result, type TransactionScope } from "@platos/kernel";

import {
  mayUninstall,
  officialSkillImmutable,
  skillNotFound,
  type CatalogueEntry,
  type CatalogueScope,
  type Installation,
} from "../domain/index.js";
import type { SkillsDependencies } from "./dependencies.js";
import { findVisibleSkill } from "./read-catalogue.js";

/** Create or re-enable both halves. Caller supplies the transaction. */
export async function installSkillInTransaction(
  dependencies: SkillsDependencies,
  scope: CatalogueScope,
  entry: CatalogueEntry,
  transaction: TransactionScope,
): Promise<Result<Installation>> {
  const project = await dependencies.repository.upsertProjectInstallation(
    scope,
    entry.skillId,
    transaction,
  );
  if (!project.ok) return err(project.error);

  const environment = await dependencies.repository.upsertEnvironmentInstallation(
    scope,
    project.value,
    transaction,
  );
  if (!environment.ok) return err(environment.error);

  return ok({ project: project.value, environment: environment.value });
}

export interface InstallSkillCommand {
  readonly scope: CatalogueScope;
  /** A row id or a slug, resolved the same way every tenant-facing read does. */
  readonly reference: string;
}

export async function installSkill(
  dependencies: SkillsDependencies,
  command: InstallSkillCommand,
): Promise<Result<Installation>> {
  const entry = await findVisibleSkill(dependencies, command.scope, command.reference);
  if (!entry.ok) return err(entry.error);
  return dependencies.unitOfWork.run((transaction) =>
    installSkillInTransaction(dependencies, command.scope, entry.value, transaction),
  );
}

export interface UninstallReport {
  readonly uninstalled: boolean;
  /** The stable code explaining a refusal, or null when there was none. */
  readonly refusedBecause: string | null;
}

export async function uninstallSkill(
  dependencies: SkillsDependencies,
  command: InstallSkillCommand,
): Promise<Result<UninstallReport>> {
  const entry = await findVisibleSkill(dependencies, command.scope, command.reference);
  if (!entry.ok) {
    // An id this scope cannot see is reported as a refusal rather than as a
    // failure, so the caller's answer does not distinguish "absent" from
    // "another tenant's" — which is what makes the surface unusable as a probe.
    if (entry.error.code === skillNotFound("").code) {
      return ok({ uninstalled: false, refusedBecause: entry.error.code });
    }
    return err(entry.error);
  }
  if (!mayUninstall(entry.value.isOfficial)) {
    return ok({ uninstalled: false, refusedBecause: officialSkillImmutable(command.reference).code });
  }
  const removed = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.deleteEnvironmentInstallation(command.scope, entry.value.skillId, transaction),
  );
  if (!removed.ok) return err(removed.error);
  return ok({ uninstalled: removed.value, refusedBecause: null });
}
