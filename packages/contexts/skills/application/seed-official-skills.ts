// Use case: seed the bundled official catalogue into an organization.
//
// IDEMPOTENT BY CONSTRUCTION, not by checking first. Every source is registered
// through the same `(organization, slug, version)` upsert, so a second run
// overwrites the same rows. That is what makes it safe to run at boot, safe to
// run again after a partial failure, and safe to run lazily on a read that found
// no official rows — which is exactly what the live library surface does on a
// fresh install where the process started before the organization existed.
//
// ONE BAD SOURCE MUST NOT COST THE OTHERS. A malformed bundled skill is a defect
// in the shipped catalogue, and refusing to seed anything because of it would
// take down every skill in the product. So each source is reported individually
// and the pass continues. The report is the contract: a caller that wants to
// fail loudly has the failures in hand, and a caller booting a process can log
// them and carry on.
//
// A DECLARED ID THAT DISAGREES WITH THE MANIFEST'S IS THE MANIFEST'S. The
// bundled catalogue names each source, and the source's frontmatter names itself.
// When they differ the parsed value wins — it is what the stored row will be
// keyed by, so preferring the other one would key the row by something that is
// not in it. The disagreement is reported so it can be fixed.

import { err, ok, type OrganizationScope, type Result } from "@platos/kernel";

import { parseSkillSource, type CatalogueEntry, type SkillSlug } from "../domain/index.js";
import type { SkillsDependencies } from "./dependencies.js";
import { registerOfficialSkill } from "./register-skill.js";

/** One bundled skill: the id the catalogue claims, and its source text. */
export interface OfficialSkillSource {
  readonly declaredId: SkillSlug;
  readonly source: string;
}

export interface SeededSkill {
  readonly declaredId: SkillSlug;
  readonly entry: CatalogueEntry;
  /** Set when the source's own id disagreed with the declared one. */
  readonly declaredIdMismatch: SkillSlug | null;
}

export interface FailedSeed {
  readonly declaredId: SkillSlug;
  readonly code: string;
  readonly message: string;
}

export interface SeedReport {
  readonly organization: OrganizationScope;
  readonly seeded: readonly SeededSkill[];
  readonly failed: readonly FailedSeed[];
}

export interface SeedOfficialSkillsCommand {
  readonly organization: OrganizationScope;
  readonly sources: readonly OfficialSkillSource[];
}

export async function seedOfficialSkills(
  dependencies: SkillsDependencies,
  command: SeedOfficialSkillsCommand,
): Promise<Result<SeedReport>> {
  const seeded: SeededSkill[] = [];
  const failed: FailedSeed[] = [];

  for (const source of command.sources) {
    const parsed = parseSkillSource(source.source);
    if (!parsed.ok) {
      failed.push({
        declaredId: source.declaredId,
        code: parsed.error.code,
        message: parsed.error.message,
      });
      continue;
    }
    const registered = await registerOfficialSkill(dependencies, {
      organization: command.organization,
      parsed: parsed.value,
    });
    if (!registered.ok) {
      failed.push({
        declaredId: source.declaredId,
        code: registered.error.code,
        message: registered.error.message,
      });
      continue;
    }
    seeded.push({
      declaredId: source.declaredId,
      entry: registered.value,
      declaredIdMismatch:
        parsed.value.manifest.id === source.declaredId ? null : parsed.value.manifest.id,
    });
  }

  // The pass itself always succeeds: partial seeding is the designed outcome,
  // and the caller reads `failed` to decide what that means for it.
  return ok({ organization: command.organization, seeded, failed });
}

/**
 * Seed only when nothing official is present yet.
 *
 * The lazy path the library read takes. It exists so a fresh organization gets
 * its catalogue on first view, and it is separate from the unconditional pass so
 * that a read never re-writes rows that are already there.
 */
export async function seedOfficialSkillsIfAbsent(
  dependencies: SkillsDependencies,
  command: SeedOfficialSkillsCommand,
): Promise<Result<SeedReport | null>> {
  const present = await dependencies.repository.hasOfficialSkills(command.organization);
  if (!present.ok) return err(present.error);
  if (present.value) return ok(null);
  return seedOfficialSkills(dependencies, command);
}
