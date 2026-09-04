// `Job.externalId` — the registered name a job is dispatched by.
//
// ONE REGEX, ONE DEFINITION. The live system spells this constraint twice, in two
// files, as two constants that happen to agree: `JOB_ID_RE` in the MCP jobs tool
// (which decides what may be CREATED) and `REGISTERED_JOB_ID_RE` in the
// job-execution service (which decides what may be RUN). They are byte-identical
// today, and nothing makes them stay that way — a widening on the create side
// would silently mint rows the execute side then refuses as unregistered.
//
// Collapsing them to one exported constant is the point of this module: the
// property that matters is that the two questions cannot diverge, and the only
// durable way to have that is for there to be one answer.

import { asIdentifier, err, ok, type Result } from "@platos/kernel";

import { jobKeyInvalid } from "./errors.js";
import type { JobKey } from "./identifiers.js";

/**
 * Lower-case alphanumerics and hyphens, 1–64 characters.
 *
 * Anchored at both ends, and deliberately WITHOUT the `u` flag or any character
 * class that could admit a Unicode confusable: the key reaches a sandbox context
 * name and a worker thread name, so its alphabet stays ASCII.
 */
export const JOB_KEY_PATTERN = /^[a-z0-9-]{1,64}$/;

export const JOB_KEY_RULE = "job key must be 1-64 characters of lowercase letters, digits and hyphens";

export function isJobKey(value: string): boolean {
  return JOB_KEY_PATTERN.test(value);
}

export function parseJobKey(value: string): Result<JobKey> {
  return isJobKey(value) ? ok(asIdentifier<JobKey>(value)) : err(jobKeyInvalid(JOB_KEY_RULE));
}
