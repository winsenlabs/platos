// WIN-267 T4 — WHERE THE VERSION IS SPELLED, AND THE ONLY PLACE IT IS.
//
// T2's finding, applied to the process that will inherit the surface: twenty-four
// controllers in `apps/agent` had written `api/v1` into their own paths, so the
// major lived in twenty-four places and moving it would have meant twenty-four
// edits and one that got missed. `apps/agent/src/http/api-surface.ts` is the file
// that fixed it there. This is the same file for `apps/core-api`, created with
// the first business route this process serves rather than after the
// twenty-fourth.
//
// TWO CONSTANTS AND NO FUNCTION. `runtime/lifecycle.ts` composes them into
// `enableVersioning({ prefix: `${API_PREFIX}/v`, defaultVersion: API_VERSION })`,
// and every versioned controller carries `@Version(API_VERSION)`. Nothing else
// in the process may write either string, which `rest-chassis.test.ts` checks by
// walking the source rather than by trusting this comment.

/** The path segment every business operation sits under. Never `/api/v1`. */
export const API_PREFIX = "api";

/**
 * The major this build serves.
 *
 * A STRING, because that is what `@Version` and `VersioningOptions` take, and a
 * number here would be silently coerced at each of the two call sites into a
 * value neither of them declares.
 */
export const API_VERSION = "1";
