// Use case: edit a catalogue entry's presentation.
//
// Three columns move — name, description, tags — and nothing else. Not the slug
// or the version, because they are the identity the uniqueness key is built
// from; not the manifest, the source or the prompt block, because those come
// from a parsed document and editing them here would put the stored row out of
// step with the source it claims to be; not `isOfficial`, because that is a
// privilege.
//
// AN EMPTY PATCH IS A READ. Applying nothing must not bump `updatedAt` and must
// not write a row, which matters because `updatedAt` is what an operator reads
// to answer "when did this last change".
//
// OFFICIAL ROWS ARE EDITABLE HERE. That is the live behaviour and it is
// preserved on purpose — see `mayEdit` in `domain/installation.ts` for the
// reasoning and for the finding it is recorded as. The gate is written as a
// call rather than inlined so that changing the answer is a one-line change in
// one place when that decision is taken.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  mayEdit,
  officialSkillImmutable,
  patchIsEmpty,
  type CatalogueEntry,
  type CataloguePatch,
  type CatalogueScope,
} from "../domain/index.js";
import type { SkillsDependencies } from "./dependencies.js";
import { findVisibleSkill } from "./read-catalogue.js";

export interface PatchSkillCommand {
  readonly scope: CatalogueScope;
  readonly reference: string;
  readonly patch: CataloguePatch;
}

export async function patchSkill(
  dependencies: SkillsDependencies,
  command: PatchSkillCommand,
): Promise<Result<CatalogueEntry>> {
  const entry = await findVisibleSkill(dependencies, command.scope, command.reference);
  if (!entry.ok) return err(entry.error);
  if (!mayEdit(entry.value.isOfficial)) return err(officialSkillImmutable(command.reference));
  if (patchIsEmpty(command.patch)) return ok(entry.value);
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.patchSkill(entry.value.skillId, command.patch, transaction),
  );
}
