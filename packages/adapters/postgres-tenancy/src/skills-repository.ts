// `skills`' canonical store — one port, three tables, one connection, in the one
// directory ADR M0.3 §15 gives the ORM.
//
// ONE COMPOSITE AND NOT THREE PROPERTIES. `SkillsRepository` is a single port
// with seventeen methods whose names do not collide with each other, so the three
// halves below are spread into one object exactly as `tools`', `agents`' and
// `channels`' are. It is nonetheless exposed on `PostgresTenancyAdapter` as a
// PROPERTY rather than spread into the adapter, and that is FORCED rather than
// chosen: `SkillsRepository.findInstallation(scope, skillId)` and
// `ChannelsRepository.findInstallation(installationId)` are both top-level
// members with different signatures, so one interface cannot extend both. It is
// the same collision `secrets` hit on `appendAudit`, on a different word.
//
// ONE TRANSACTION ACROSS ALL THREE TABLES, AND ACROSS THE OTHER EIGHT OWNERS.
// They are handed the SAME `TenancyTransactions`, which is what makes an install
// atomic: `install-skill.ts` adopts the catalogue row into the project and binds
// it in the environment, and those are TWO rows in two tables that must commit
// or roll back together. A thirteenth adapter package holding only this
// context's repository would have had its own pool and its own ambient frame,
// and an install that failed on its second row would have left a project
// adoption behind that nothing points at.
//
// WHAT IS NOT HERE, AND WHY. `skills` declares FOUR driven ports and this
// satisfies the ONE that is a canonical store.
//
//   `skill-source-fetcher.ts` is a NETWORK FETCH over a URL an operator pasted.
//   Its own header says "NOTHING IN THIS REPOSITORY IMPLEMENTS THIS PORT YET"
//   and lists five clauses — DNS resolution against forbidden address ranges,
//   the same check on every redirect hop, a byte ceiling enforced while reading,
//   no remote content in an error, no vendor error escaping — not one of which a
//   PostgreSQL client can honour. Satisfying it from here would put an
//   SSRF-defence contract in a package that opens no sockets.
//
//   `skill-sandbox.ts` is the CONFINED RUNTIME a skill's tools execute in. Its
//   own header says which isolation "is an operational choice that has already
//   changed more than once in this system's life", and ADR M0.3 §7 decision 10
//   puts durable work behind `packages/adapters/durable-runtime`. It writes no
//   row at all.
//
//   `environment-key-directory.ts` reads whether an environment VARIABLE NAME is
//   set, and every one of those rows is `EnvironmentVariable`, which ADR M0.3 §1
//   row 3 gives to `secrets`. Implementing it here would make this directory a
//   reader of another owner's table under the name of `skills`' adapter — and
//   the port's own header is explicit that the coupling is resolved at the
//   composition root precisely because `skills` may not depend on `secrets`.
//   The row this directory could physically read is not the row this port is
//   entitled to.

import type { SkillsRepository } from "@platos/context-skills/application/ports/index.js";

import { createSkillsCatalogue, type SkillsStamps } from "./skills-catalogue.js";
import { createSkillsErasure } from "./skills-erasure.js";
import { createSkillsInstallations } from "./skills-installations.js";
import type { TenancyTransactions } from "./transaction.js";

export type { SkillsStamps } from "./skills-catalogue.js";

/**
 * The default stamps: a real uuid per row and a wall clock that never repeats.
 *
 * WHY THE STORE STAMPS AT ALL rather than leaving it to `@default(uuid())` and
 * `@default(now())`. Two reasons, and each is a defect the column defaults would
 * have shipped.
 *
 *   `now()` on PostgreSQL is the TRANSACTION's start time. An install writes a
 *   `ProjectSkill` and an `EnvironmentSkill` in one unit of work, and a seeding
 *   run writes a whole official catalogue in one: every row would carry the
 *   identical instant, and `updatedAt` would stop being able to order anything.
 *
 *   The IDS have to be knowable to the caller of a conformance scenario. The
 *   in-memory double takes an id source (`Stamps`) so a suite can compare two
 *   stores' answers verbatim; a store that let the database mint would have to be
 *   compared with the ids masked out, which is the normalisation that hides a
 *   real difference.
 *
 * The instant source is monotonic within the process for the reason
 * `governance-repository.ts` gives: `createdAt` and `updatedAt` are
 * `timestamp(3)`, so two rows written in the same millisecond TIE.
 */
export function createSkillsStamps(): SkillsStamps {
  let previous = 0;
  return {
    now(): Date {
      const now = Date.now();
      previous = now > previous ? now : previous + 1;
      return new Date(previous);
    },
    skillId: () => crypto.randomUUID(),
    projectSkillId: () => crypto.randomUUID(),
    environmentSkillId: () => crypto.randomUUID(),
  };
}

/**
 * Build the store over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown` — a refusal that names the right fact
 * and the wrong cause.
 */
export function createSkillsRepository(
  transactions: TenancyTransactions,
  stamps: SkillsStamps = createSkillsStamps(),
): SkillsRepository {
  return {
    ...createSkillsCatalogue(transactions, stamps),
    ...createSkillsInstallations(transactions, stamps),
    ...createSkillsErasure(transactions, stamps),
  };
}
