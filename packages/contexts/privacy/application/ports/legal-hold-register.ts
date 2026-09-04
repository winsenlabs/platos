// The `LegalHoldRegister` port — the operator's list of subjects that must not
// be erased.
//
// A port rather than a policy field because the register is installation
// configuration a human edits between requests, and because reading it is I/O:
// `domain/policy.ts` is a frozen value handed in at construction, and a hold
// added five minutes ago has to stop the next erasure without a redeploy.
//
// ORGANIZATION-SCOPED, even where an installation keeps one global list. A hold is
// a statement about one tenant's obligation, and a port that took no scope would
// make a single-tenant implementation look correct while a multi-tenant one had
// nowhere to put the distinction.
//
// FAILING TO READ IT IS NOT AN EMPTY REGISTER. That is the whole reason this
// returns `Result`: an unreadable register and an empty one are the same value
// to a caller who ignores the difference, and the erasure is irreversible, so
// the request is refused rather than run unchecked
// (`PRIVACY_LEGAL_HOLD_REGISTER_UNAVAILABLE`).
//
// The entries are RAW HANDLES — that is what an operator writes. They are
// matched in memory by `findLegalHold` and never persisted: what reaches the
// operation row is a register POSITION plus a truncated digest.

import type { OrganizationId, Result } from "@platos/kernel";

export interface LegalHoldRegister {
  /**
   * The hold entries for one organization, IN REGISTER ORDER.
   *
   * Order is load-bearing: `legalHoldReference` names the 1-based position an
   * operator navigates by, so a resolver that sorted or de-duplicated would make
   * every stored reference point at the wrong line.
   */
  entries(organizationId: OrganizationId): Promise<Result<readonly string[]>>;
}
