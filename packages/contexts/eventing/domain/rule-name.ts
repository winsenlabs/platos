// `NotificationRule.name` — 1 to 120 characters.
//
// The bound is the legacy one ("name must be 1–120 chars", enforced identically
// on create and on update). It is measured in UTF-16 code units, which is what
// `String.length` counts and therefore what the legacy check counted; a column
// with no length constraint of its own means this predicate IS the constraint.
//
// Whitespace is NOT trimmed. `" "` is a legal legacy name and the unique index
// `@@unique([environmentId, name])` treats it as distinct from `""`. Trimming
// here would make two rules that the database considers different collide, so
// the only safe refactor is to preserve the absence of trimming and say why.

import { err, ok, type Result } from "@platos/kernel";

import { ruleNameInvalid } from "./errors.js";
import type { RuleName } from "./identifiers.js";

export const MIN_RULE_NAME_LENGTH = 1;
export const MAX_RULE_NAME_LENGTH = 120;

export function parseRuleName(raw: string): Result<RuleName> {
  if (typeof raw !== "string") {
    return err(
      ruleNameInvalid("name must be a string", [
        { field: "name", code: "type", message: "expected a string" },
      ]),
    );
  }
  if (raw.length < MIN_RULE_NAME_LENGTH || raw.length > MAX_RULE_NAME_LENGTH) {
    return err(
      ruleNameInvalid(`name must be ${MIN_RULE_NAME_LENGTH}–${MAX_RULE_NAME_LENGTH} chars`, [
        {
          field: "name",
          code: "length",
          message: `got ${raw.length}; allowed ${MIN_RULE_NAME_LENGTH}–${MAX_RULE_NAME_LENGTH}`,
        },
      ]),
    );
  }
  return ok(raw as RuleName);
}
