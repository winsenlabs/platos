// ADR M0.3 §4 kernel port: IdGenerator.
//
// Identity is an input for the same reason time is: a use case that mints a row
// must be reproducible. ADR M0.3 §4 names ULID; the baseline schema keys almost
// every canonical row with `@default(uuid())`, so both are on the port and the
// caller picks per the column it is writing.

import type { Ulid, Uuid } from "../vo/identifier.js";

export interface IdGenerator {
  /** RFC 4122 v4 — the baseline primary-key format. */
  uuid(): Uuid;
  /** Lexicographically sortable and monotonic within a millisecond. */
  ulid(): Ulid;
}
