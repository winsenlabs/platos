// This context's half of the kernel `ErasureTarget` — count, then ANONYMISE.
//
// `application/skills-erasure-target.ts` records why it is anonymise and not
// delete, and the reason is worth restating where the statement lives: a skill
// row is not the subject's data, it is a TOOL the organization runs, and
// `author` is an attribution on it. Deleting it would remove a capability other
// people's agents depend on because the person who uploaded it exercised a right
// to erasure. `ProjectSkill` and `EnvironmentSkill` are not touched at all —
// neither carries a subject column, and a plan item claiming to erase them would
// be reporting work that does not exist.
//
// *** THE SELECTOR IS RESOLVED BY CONTAINMENT, AND THE CONSEQUENCE IS SHARP ***
//
// `SkillsErasureSelector.scope` is a full `TenantScope`, and the in-memory
// double matches a row with `contains(selector.scope, entry.identity.organization)`
// — the kernel's containment predicate, with the SELECTOR as the outer scope.
// `Skill` is organization-scoped, so `resolvePath` of the inner side is
// `org/<id>` and the only outer path that contains it is `org/<id>` itself. A
// selector addressed at a PROJECT (`org/<id>/proj/<id>`) therefore matches
// NOTHING, and so does one addressed at an environment.
//
// That is transcribed rather than corrected. It is the behaviour the port's own
// comment describes, it is what the double does, and changing it here would make
// an erasure erase more rows against PostgreSQL than against the store every one
// of this context's use-case suites is written against — a divergence in the one
// direction that cannot be undone. It IS reported: an operator addressing an
// erasure at a project gets a truthful zero, and a reader of this file learns
// that "erase this person's skills in this project" is not a question the
// canonical schema can answer, because a skill does not belong to a project.
//
// *** THE ANONYMISATION IS ONE STATEMENT, AND IT HAS TO BE RAW ***
//
// The name is in TWO places: the `author` column and the `author` field of the
// stored `manifest` JSON. `domain/manifest.ts` fixes the manifest's field names
// as the persisted contract, and the double overwrites both — "the manifest
// carries the author too, so overwriting only the column would leave the name
// legible in the stored JSON". The client cannot express a partial JSONB update,
// so the alternative is to READ every matching row and issue one UPDATE per row:
// an N+1 on the erasure path, whose row count is exactly the count this same
// selector just reported and is therefore unbounded by anything.
//
// `jsonb_set` does both halves in one statement. `sole-writer.mjs` reads raw SQL
// by the TABLE the statement names and attributes it exactly as it attributes a
// delegate call, so `UPDATE "Skill"` from this directory is judged against
// `OWNER.Skill`, which is `skills`, which is delegated here. Nothing is
// interpolated: every value is a bound parameter, so the statement is the same
// string for every subject.

import type {
  Result,
  SkillsErasureSelector,
  TransactionScope,
} from "@platos/context-skills/application/ports/index.js";
import { ok } from "@platos/context-skills/application/ports/index.js";

import { looksLikeUuid, requireInstant } from "./skills-guards.js";
import { refuseSkills } from "./skills-refusal.js";
import type { SkillsStamps } from "./skills-catalogue.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * The author attribution an anonymised row carries.
 *
 * The same literal `InMemorySkillsRepository.ANONYMIZED_AUTHOR` uses. It is
 * repeated here rather than imported from the context's testing barrel because
 * this store must not depend on a double for a value it WRITES to a canonical
 * column — the conformance suite asserts the two agree, which is the check that
 * keeps them in step without making production code import a fixture.
 */
export const ANONYMIZED_SKILL_AUTHOR = "[erased]";

/**
 * The organization a selector actually selects, or null when it selects nothing.
 *
 * Null is returned for a project- or environment-level selector as well as for a
 * subject with no principal, and the two are NOT distinguished — because the
 * containment rule above makes them the same answer: no row matches. A store
 * that reported them differently would be inventing a distinction the double
 * does not make and the schema cannot support.
 */
function selectedOrganization(selector: SkillsErasureSelector): string | null {
  if (selector.principalId === null) return null;
  if (selector.scope.level !== "organization") return null;
  if (!looksLikeUuid(selector.scope.organizationId)) return null;
  return selector.scope.organizationId;
}

export function createSkillsErasure(transactions: TenancyTransactions, stamps: SkillsStamps) {
  return {
    async countAuthoredSkills(selector: SkillsErasureSelector): Promise<Result<number>> {
      return refuseSkills(async () => {
        const organizationId = selectedOrganization(selector);
        if (organizationId === null) return ok(0);
        const total = await transactions.reader().skill.count({
          where: { organizationId, author: selector.principalId },
        });
        return ok(total);
      }, "countAuthoredSkills");
    },

    async anonymizeAuthoredSkills(
      selector: SkillsErasureSelector,
      transaction: TransactionScope,
    ): Promise<Result<number>> {
      return refuseSkills(async () => {
        const organizationId = selectedOrganization(selector);
        if (organizationId === null) return ok(0);
        const at = requireInstant("Skill.updatedAt", stamps.now());
        const client = transactions.writer(transaction);
        // `jsonb_set(..., create_missing => true)` writes the key even into a
        // manifest that never carried one, which is the case for a row an older
        // binary wrote before `author` was in the frontmatter. Without it the
        // column would read `[erased]` and the JSON would still hold nothing —
        // truthful but incomplete — and with `false` it would hold the name.
        const count = await client.$executeRaw`
          UPDATE "Skill"
             SET "author" = ${ANONYMIZED_SKILL_AUTHOR},
                 "manifest" = jsonb_set(
                   "manifest",
                   '{author}',
                   to_jsonb(${ANONYMIZED_SKILL_AUTHOR}::text),
                   true
                 ),
                 "updatedAt" = ${at}
           WHERE "organizationId" = ${organizationId}::uuid
             AND "author" = ${selector.principalId}
        `;
        return ok(count);
      }, "anonymizeAuthoredSkills");
    },
  };
}
