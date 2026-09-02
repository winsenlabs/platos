// The `skills` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport can build
// its status table from one list and an operator grepping a log finds exactly
// one definition.
//
// TWO FAMILIES OF FAILURE ARE DELIBERATELY KEPT APART.
//
//   SKILLS_MANIFEST_* is the baseline `SkillParseError`, whose `reason` field
//     the REST surface returns to the caller alongside a 400. The reasons that
//     surface carries — missing_frontmatter, invalid_id, missing_field,
//     invalid_field, yaml_indent, yaml_missing_colon — become distinct codes
//     rather than one code with a free-text rider, because a caller branching on
//     a substring of a message is the coupling stable codes exist to remove.
//
//   SKILLS_SOURCE_* is the import path's own failures: a rejected URL, a body
//     over the ceiling, a fetch that did not land. They are separate because a
//     manifest that parses badly is the author's problem and a source that will
//     not load is the network's, and a transport maps them to different statuses.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const SKILLS_ERROR_CODES = [
  "SKILLS_MANIFEST_FRONTMATTER_MISSING",
  "SKILLS_MANIFEST_ID_INVALID",
  "SKILLS_MANIFEST_FIELD_MISSING",
  "SKILLS_MANIFEST_FIELD_INVALID",
  "SKILLS_MANIFEST_YAML_INDENT",
  "SKILLS_MANIFEST_YAML_MISSING_COLON",
  "SKILLS_SOURCE_URL_INVALID",
  "SKILLS_SOURCE_PROTOCOL_UNSUPPORTED",
  "SKILLS_SOURCE_TOO_LARGE",
  "SKILLS_SOURCE_FETCH_FAILED",
  "SKILLS_SKILL_NOT_FOUND",
  "SKILLS_SKILL_NOT_INSTALLED",
  "SKILLS_OFFICIAL_SKILL_IMMUTABLE",
  "SKILLS_ENVIRONMENT_KEYS_MISSING",
  "SKILLS_SANDBOX_UNAVAILABLE",
  "SKILLS_SANDBOX_REFUSED",
  "SKILLS_REPOSITORY_UNAVAILABLE",
  "SKILLS_ERASURE_PLAN_FOREIGN",
] as const;

export type SkillsErrorCode = (typeof SKILLS_ERROR_CODES)[number];

/**
 * The baseline `SkillParseError.reason` values, kept as a closed set so the
 * mapping from a parse failure to a stable code is total and reviewable rather
 * than a chain of string comparisons spread across the parser.
 */
export type ManifestParseReason =
  | "missing_frontmatter"
  | "invalid_id"
  | "missing_field"
  | "invalid_field"
  | "yaml_indent"
  | "yaml_missing_colon";

export function manifestFrontmatterMissing(): DomainError {
  return domainError(
    "SKILLS_MANIFEST_FRONTMATTER_MISSING",
    "invalid_input",
    "skill source is missing its YAML frontmatter header",
    { details: { reason: "missing_frontmatter" } },
  );
}

/**
 * The namespacing rule, refused by name. A bare `web_search` is rejected because
 * an un-namespaced id collides across organizations the moment two authors pick
 * the same word, and the slug is half of this context's uniqueness key.
 */
export function manifestIdInvalid(id: string): DomainError {
  return domainError(
    "SKILLS_MANIFEST_ID_INVALID",
    "invalid_input",
    `skill id "${id}" must be namespaced, as in "platos.web_search"`,
    { details: { id, reason: "invalid_id" } },
  );
}

export function manifestFieldMissing(field: string): DomainError {
  return domainError(
    "SKILLS_MANIFEST_FIELD_MISSING",
    "invalid_input",
    `skill manifest is missing required field "${field}"`,
    { fields: [{ field, code: "required", message: "required" }], details: { reason: "missing_field" } },
  );
}

export function manifestFieldInvalid(field: string, message: string): DomainError {
  return domainError("SKILLS_MANIFEST_FIELD_INVALID", "invalid_input", message, {
    fields: [{ field, code: "invalid", message }],
    details: { reason: "invalid_field" },
  });
}

export function manifestYamlIndent(line: number, text: string): DomainError {
  return domainError(
    "SKILLS_MANIFEST_YAML_INDENT",
    "invalid_input",
    `unexpected indent at line ${line}`,
    { details: { line, text, reason: "yaml_indent" } },
  );
}

export function manifestYamlMissingColon(line: number, text: string): DomainError {
  return domainError(
    "SKILLS_MANIFEST_YAML_MISSING_COLON",
    "invalid_input",
    `expected "key: value" at line ${line}`,
    { details: { line, text, reason: "yaml_missing_colon" } },
  );
}

export function sourceUrlInvalid(url: string, reason: string): DomainError {
  // The URL is echoed; the FETCHED BODY never is. Reflecting remote content in
  // an error is how an import turns into a content-injection surface, and the
  // baseline importer's own comment says so.
  return domainError("SKILLS_SOURCE_URL_INVALID", "invalid_input", "skill import URL was rejected", {
    details: { url, reason },
  });
}

export function sourceProtocolUnsupported(protocol: string): DomainError {
  return domainError(
    "SKILLS_SOURCE_PROTOCOL_UNSUPPORTED",
    "invalid_input",
    `only http and https URLs may be imported (got "${protocol}")`,
    { details: { protocol } },
  );
}

export function sourceTooLarge(bytes: number, maxBytes: number): DomainError {
  return domainError(
    "SKILLS_SOURCE_TOO_LARGE",
    "invalid_input",
    `skill source of ${bytes} bytes exceeds the ${maxBytes}-byte ceiling`,
    { details: { bytes, maxBytes } },
  );
}

export function sourceFetchFailed(url: string, status: number | null): DomainError {
  return domainError("SKILLS_SOURCE_FETCH_FAILED", "unavailable", "skill source could not be loaded", {
    retryAfterSeconds: 5,
    details: { url, status },
  });
}

/** `not_found`, not `forbidden`: an id outside the caller's visibility is absent. */
export function skillNotFound(reference: string): DomainError {
  return domainError("SKILLS_SKILL_NOT_FOUND", "not_found", "skill is not visible in this scope", {
    details: { reference },
  });
}

/**
 * The row exists and is visible, but this environment holds no binding for it.
 * Distinct from `SKILLS_SKILL_NOT_FOUND` because the remedy differs: one is
 * "you named the wrong skill", the other is "install it here first".
 */
export function skillNotInstalled(reference: string): DomainError {
  return domainError(
    "SKILLS_SKILL_NOT_INSTALLED",
    "precondition_failed",
    "skill is visible but is not installed in this environment",
    { details: { reference } },
  );
}

export function officialSkillImmutable(reference: string): DomainError {
  return domainError(
    "SKILLS_OFFICIAL_SKILL_IMMUTABLE",
    "conflict",
    "an official skill is owned by the catalogue and cannot be edited or uninstalled here",
    { details: { reference } },
  );
}

/**
 * The enable-time gate. `missing` is the operator-actionable payload the live
 * surface already returns, kept structured rather than folded into the message.
 */
export function environmentKeysMissing(slug: string, missing: readonly string[]): DomainError {
  return domainError(
    "SKILLS_ENVIRONMENT_KEYS_MISSING",
    "precondition_failed",
    `cannot enable skill "${slug}" — missing environment keys: ${missing.join(", ")}`,
    { details: { slug, missing: [...missing] } },
  );
}

export function sandboxUnavailable(reason: string): DomainError {
  return domainError("SKILLS_SANDBOX_UNAVAILABLE", "unavailable", "skill sandbox is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/**
 * The sandbox ran and declined. Separate from `SKILLS_SANDBOX_UNAVAILABLE`
 * because a refusal is deterministic and a retry will refuse again, while an
 * outage is worth retrying — and a caller that cannot tell them apart retries
 * forever or gives up too early.
 */
export function sandboxRefused(handler: string, reason: string): DomainError {
  return domainError("SKILLS_SANDBOX_REFUSED", "precondition_failed", "skill sandbox refused the request", {
    details: { handler, reason },
  });
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("SKILLS_REPOSITORY_UNAVAILABLE", "unavailable", "skills repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/**
 * The kernel's `ErasurePlan` carries no subject, so a target handed a plan it did
 * not mint cannot know whose rows to destroy. Refusing is the only safe answer.
 */
export function erasurePlanForeign(targetName: string): DomainError {
  return domainError(
    "SKILLS_ERASURE_PLAN_FOREIGN",
    "precondition_failed",
    "erasure plan was not produced by this target and carries no subject to act on",
    { details: { targetName } },
  );
}

/** Collect field violations into one invalid-field error. */
export function manifestFieldsInvalid(message: string, fields: readonly FieldViolation[]): DomainError {
  return domainError("SKILLS_MANIFEST_FIELD_INVALID", "invalid_input", message, {
    fields,
    details: { reason: "invalid_field" },
  });
}
