// Use case: import a skill from a URL an operator pasted.
//
// The riskiest path in this context, and the ordering below is the defence:
//
//   1. ADMIT the submitted URL — parseable, and http or https only.
//   2. REWRITE it to the raw source address.
//   3. FETCH through the port, which re-checks the ADDRESS of every hop.
//   4. PARSE the body, which is untrusted text.
//   5. REGISTER, as `community` and never as official.
//
// STEP 3 IS WHERE THE ADDRESS CHECK LIVES, AND IT HAS TO BE THERE. The rewrite
// in step 2 can change the host, so a check performed here on the submitted URL
// would not be a check on what gets fetched, and a redirect would move it again
// after that. Resolving names to addresses is I/O; a pure layer cannot do it and
// must not pretend to. What this layer guarantees instead is that NO OTHER PATH
// reaches the fetcher — every import goes through this function.
//
// AN IMPORTED SKILL IS `community`. It is somebody else's code arriving from
// somewhere else. It is not `custom` (which means the tenant wrote it) and it
// certainly is not `official`, which the command type makes unreachable anyway.
//
// PROVENANCE RECORDS THE SUBMITTED URL, NOT THE RESOLVED ONE. `importedFrom` is
// what the operator can recognise and audit. The resolved address is returned
// alongside, so a caller that wants to record the redirect chain has it, but the
// two are never conflated.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitImportUrl,
  parseSkillSource,
  rewriteToRawSource,
  sourceTooLarge,
  type CatalogueScope,
} from "../domain/index.js";
import type { SkillsDependencies } from "./dependencies.js";
import { registerSkill, type RegisteredSkill } from "./register-skill.js";

export interface ImportSkillCommand {
  readonly scope: CatalogueScope;
  readonly url: string;
}

export interface ImportedSkill extends RegisteredSkill {
  /** The URL the operator submitted. Recorded as the skill's provenance. */
  readonly submittedUrl: string;
  /** Where the bytes actually came from, after rewriting and redirects. */
  readonly resolvedUrl: string;
}

export async function importSkillFromUrl(
  dependencies: SkillsDependencies,
  command: ImportSkillCommand,
): Promise<Result<ImportedSkill>> {
  const submitted = admitImportUrl(command.url);
  if (!submitted.ok) return err(submitted.error);

  const target = rewriteToRawSource(submitted.value);
  const policy = dependencies.policy.import;
  const document = await dependencies.sourceFetcher.fetch({
    url: target.toString(),
    maxBytes: policy.maxSourceBytes,
    timeoutSeconds: policy.fetchTimeoutSeconds,
    maxRedirects: policy.maxRedirects,
  });
  if (!document.ok) return err(document.error);

  // Belt to the adapter's braces. The port's contract requires the ceiling to be
  // enforced while reading, but an adapter that got it wrong must not be able to
  // put an oversized body into the catalogue, and this is cheap.
  if (document.value.bytes > policy.maxSourceBytes) {
    return err(sourceTooLarge(document.value.bytes, policy.maxSourceBytes));
  }

  const parsed = parseSkillSource(document.value.body, { importedFrom: command.url });
  if (!parsed.ok) return err(parsed.error);

  const registered = await registerSkill(dependencies, {
    scope: command.scope,
    parsed: parsed.value,
    origin: "community",
  });
  if (!registered.ok) return err(registered.error);

  return ok({
    ...registered.value,
    submittedUrl: command.url,
    resolvedUrl: document.value.resolvedUrl,
  });
}
