// THE GATE'S OWN DATABASE HANDLE AND SESSION MINT (WIN-235; moved here by
// WIN-257 T8).
//
// WHY THIS FILE EXISTS. The persisted-state gate drives a DEPLOYED webapp and
// agent over HTTP and then reads the rows back out of PostgreSQL to check what
// really persisted. That read-back is the half of the gate that joins to
// something the candidate does not control, and it needs a Prisma client and an
// operator session to make the HTTP calls with.
//
// It used to get both by importing `apps/webapp/app/services/database.server` and
// `apps/webapp/app/services/auth.server` — the webapp's OWN production modules.
// That was convenient and it was also the reason the gate could not survive T8:
// those modules are deleted, `@platos/tenancy-database` has left the dashboard's
// production dependency closure, and `webapp-no-prisma` now binds over
// `apps/webapp`.
//
// IT WAS ALSO WRONG BEFORE THE CUTOVER, for a reason worth keeping. A gate that
// reads its evidence through the subject's own client is a gate that inherits the
// subject's bugs: a webapp pointed at the wrong database would have read back the
// wrong database and passed. The handle belongs to the gate, and the gate says
// which database it is reading by naming its own variable.
//
// `PLATOS_GATE_DATABASE_URL` FALLS BACK TO `DATABASE_URL`, which is what every
// existing invocation sets, so no workflow changes; naming it separately is what
// makes "the gate reads the database the candidate writes" a configuration a
// reader can see rather than one buried in an import.

import { PlatosAuthService, PrismaClient } from "@platos/tenancy-database";

function url(): string {
  const value = process.env.PLATOS_GATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "the persisted-state gate reads the candidate's database directly: set PLATOS_GATE_DATABASE_URL (or DATABASE_URL)",
    );
  }
  return value;
}

/** The gate's read-back handle. One per process; the suite disconnects it. */
export const gateDatabase = new PrismaClient({ datasourceUrl: url() });

/**
 * An operator session for the gate's own HTTP calls.
 *
 * Minted through `PlatosAuthService` against the same database, because the
 * candidate has no route that mints a session without an emailed magic link
 * (D20) and a gate that waited for an inbox would be a gate that needs a relay.
 * `ENCRYPTION_KEY` is the credential root the fixture was sealed under.
 */
export function gateAuth(): PlatosAuthService {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("the persisted-state gate needs ENCRYPTION_KEY to mint an operator session");
  return new PlatosAuthService(gateDatabase, { encryptionKey });
}

/**
 * The `Cookie` header the gate presents, in the dialect the candidate reads.
 *
 * REMIX'S ENCODING, RESTATED — `base64(JSON.stringify(token))`. It used to come
 * from the webapp's own `commitOperatorSession`, which is a production module the
 * gate may no longer import. `apps/core-api/src/transports/rest/
 * session-cookie-value.ts` documents the same four lines from the other side and
 * `apps/webapp/test/coreVocabulary.test.ts` is not the join here: the join is the
 * gate itself, which authenticates against a running candidate and fails if the
 * bytes are wrong.
 *
 * The NAME is the production one. The runner is `NODE_ENV=test` and the
 * candidate image is production, which chooses the `__Host-` prefix.
 */
export function gateOperatorCookie(token: string): string {
  const value = Buffer.from(JSON.stringify(token), "utf8").toString("base64");
  return `__Host-platos_operator_session=${encodeURIComponent(value)}`;
}
