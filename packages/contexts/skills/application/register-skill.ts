// Use case: register a skill into the catalogue.
//
// Two entry points that differ in exactly one way, and the difference is a
// privilege boundary rather than a convenience:
//
//   registerSkill          the TENANT-facing path. Registers into the caller's
//                          organization, forces a non-official origin, and
//                          MATERIALISES the install so the skill is usable in
//                          the environment that registered it.
//
//   registerOfficialSkill  the SEEDING path. Registers an organization-owned
//                          catalogue row and creates NO install. Official rows
//                          are visible everywhere in the organization without
//                          one (`domain/visibility.ts`), so an install would be
//                          rows that change nothing, per environment, forever.
//
// A MANIFEST CANNOT PROMOTE ITSELF. `origin: official` in fetched frontmatter is
// a suggestion; `resolveOrigin` lets an explicit override win, and the
// tenant-facing path always passes one. This is why the two paths are separate
// functions rather than one with a flag: a flag defaulted wrong is a privilege
// escalation, and a caller cannot reach the seeding path by mistake.
//
// REGISTRATION IS AN UPSERT ON `(organization, slug, version)`. Re-registering
// the same manifest updates one row. That is what makes the seeder idempotent
// and what stops an operator re-uploading a skill from accumulating rows that
// all answer to the same slug.

import { err, ok, type OrganizationScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  draftFrom,
  organizationOf,
  parseSkillSource,
  type CatalogueEntry,
  type CatalogueScope,
  type ParsedSkill,
  type SkillOrigin,
} from "../domain/index.js";
import type { SkillsDependencies } from "./dependencies.js";
import { installSkillInTransaction } from "./install-skill.js";

export interface RegisterSkillCommand {
  readonly scope: CatalogueScope;
  readonly parsed: ParsedSkill;
  /**
   * `official` is NOT reachable here — the type says so. Promotion happens only
   * through `registerOfficialSkill`.
   */
  readonly origin?: Exclude<SkillOrigin, "official"> | undefined;
}

export interface RegisterFromSourceCommand {
  readonly scope: CatalogueScope;
  readonly source: string;
  readonly importedFrom?: string | null;
  readonly origin?: Exclude<SkillOrigin, "official"> | undefined;
}

export interface RegisteredSkill {
  readonly entry: CatalogueEntry;
  /** True when this registration also made the skill usable in the scope. */
  readonly installed: boolean;
}

async function upsertAndInstall(
  dependencies: SkillsDependencies,
  command: RegisterSkillCommand,
  transaction: TransactionScope,
): Promise<Result<RegisteredSkill>> {
  const draft = draftFrom(organizationOf(command.scope), command.parsed, {
    // Default `custom`, matching the live surface: an unlabelled upload is the
    // tenant's own, not the community's.
    origin: command.origin ?? "custom",
  });
  const entry = await dependencies.repository.upsertSkill(draft, transaction);
  if (!entry.ok) return err(entry.error);

  const installed = await installSkillInTransaction(
    dependencies,
    command.scope,
    entry.value,
    transaction,
  );
  if (!installed.ok) return err(installed.error);
  return ok({ entry: entry.value, installed: true });
}

export async function registerSkill(
  dependencies: SkillsDependencies,
  command: RegisterSkillCommand,
): Promise<Result<RegisteredSkill>> {
  return dependencies.unitOfWork.run((transaction) => upsertAndInstall(dependencies, command, transaction));
}

/** Parse raw source, then register it. The parse failure surfaces unchanged. */
export async function registerSkillFromSource(
  dependencies: SkillsDependencies,
  command: RegisterFromSourceCommand,
): Promise<Result<RegisteredSkill>> {
  const parsed = parseSkillSource(command.source, { importedFrom: command.importedFrom ?? null });
  if (!parsed.ok) return err(parsed.error);
  return registerSkill(dependencies, {
    scope: command.scope,
    parsed: parsed.value,
    ...(command.origin === undefined ? {} : { origin: command.origin }),
  });
}

export interface RegisterOfficialCommand {
  readonly organization: OrganizationScope;
  readonly parsed: ParsedSkill;
}

/**
 * The seeding path. Organization-owned, official, and NOT installed anywhere.
 *
 * There is no `CatalogueScope` here because there is genuinely no environment
 * involved. The live seeder's own comment makes the point: no fabricated tenancy
 * tuple is passed through it. Taking an `OrganizationScope` makes that
 * structural rather than a convention someone has to remember.
 */
export async function registerOfficialSkill(
  dependencies: SkillsDependencies,
  command: RegisterOfficialCommand,
): Promise<Result<CatalogueEntry>> {
  const draft = draftFrom(command.organization, command.parsed, { origin: "official", isOfficial: true });
  return dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.upsertSkill(draft, transaction),
  );
}
