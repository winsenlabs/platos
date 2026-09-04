// What every use case in this context is constructed with.
//
// One frozen bundle rather than nine constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing in
// this package reaches for the wall clock or a random generator. That is what
// makes a use case that dates a version, mints a slug's collision token, or
// decides a retention cutoff reproducible at any instant — and it is what turns
// the canary split from a thing you test statistically into a thing you test
// with two literals (see `domain/binding.ts`).
//
// THE POLICY IS AN INPUT TOO. `domain/policy.ts` ships the transcribed defaults
// and every rule takes them as a parameter, so an installation can raise a page
// ceiling or change the fallback model without a code change and a test can
// exercise a rule against a two-version retention window instead of fifty.
//
// ON `tenancy`, `providers` AND `skills`. ADR M0.3 §1 row 5 permits this context
// exactly these three peers plus the kernel. They are held here in three
// different states, and the difference is worth stating rather than hiding:
//
//   `tenancy` IS CALLED, on every path. It is the authorization seam in
//   `authorization.ts` — the grant it mints is what every use case verifies
//   before it reads or writes a row, and the environment a use case operates on
//   comes from that grant rather than from an id the caller also supplied.
//
//   `providers` IS CALLED, on the routing path. An agent version pins a provider
//   key on its runtime configuration or on a single model route, and resolving
//   that pin — including refusing a key that belongs to a different provider
//   than the route's model names — is `providers`' answer to give. This context
//   never opens a route: `openModelRoute` is the seam `conversations` reaches,
//   and composing a turn is that context's work.
//
//   `skills` IS AN OPAQUE HANDLE, and honestly so. `AgentSkill` names an
//   `EnvironmentSkill` by id (§7 decision 5 puts the loadout here), so resolving
//   a loadout entry into a skill needs a `skills` surface that describes one. No
//   use case here calls it, and calling it to look busy would be theatre. So this
//   bundle does NOT hold `SkillsContract`. It holds `SkillsPeer`, declared below:
//   the one member of that surface this context has a use for, and nothing else.
//
//   THE NARROWING IS THE POINT, NOT TIDINESS. `skills` publishes fourteen methods
//   and a name. A handle typed as all fifteen makes every in-memory double in
//   this package a hostage to all fifteen, so a method `skills` adds for its own
//   reasons breaks a context that never calls one. That is not hypothetical: it
//   is precisely how `InMemorySkills` stopped compiling the moment `skills`
//   ceased to be a generated placeholder and the two contexts met in one tree.
//   A port this context owns cannot be broken from outside, and the real
//   `SkillsContract` satisfies it structurally, so the composition root hands the
//   published surface over unchanged and writes no adapter to do it.
//
//   `tenancy` and `providers` keep their full published types on purpose. This
//   context CALLS them, so the whole surface is a dependency it genuinely has,
//   and their doubles narrow at the double rather than at the seam.

import type { Clock, IdGenerator, Result, UnitOfWork } from "@platos/kernel";
import type { ProvidersContract } from "@platos/context-providers";
import type { RequestSkill, SkillView } from "@platos/context-skills";
import type { TenancyContract } from "@platos/context-tenancy";

import type { AgentsPolicy } from "../domain/index.js";
import type {
  AgentsRepository,
  AgentVersionLock,
  MacroRecorder,
  ScaffoldingRepository,
} from "./ports/index.js";

/**
 * The whole of `skills` this context depends on, named by `agents`.
 *
 * One method: the edge a loadout entry would travel along to become a skill a
 * caller can read the name of. `SkillsContract` is wider by thirteen methods,
 * every one of them another context's business to call.
 *
 * The request and the view stay `skills`' own types. Narrowing which methods
 * this context depends on does not licence it to restate its neighbour's
 * vocabulary, and re-declaring either shape here would put a second definition
 * of a `skills` row in a package that owns no such row.
 */
export interface SkillsPeer {
  readonly name: "skills";
  describe(request: RequestSkill): Promise<Result<SkillView>>;
}

export interface AgentsDependencies {
  readonly repository: AgentsRepository;
  readonly scaffolding: ScaffoldingRepository;
  readonly versionLock: AgentVersionLock;
  readonly recorder: MacroRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly policy: AgentsPolicy;
  readonly tenancy: TenancyContract;
  readonly providers: ProvidersContract;
  /** Opaque by design, and narrow by design: see the note above. */
  readonly skills: SkillsPeer;
}

export function agentsDependencies(dependencies: AgentsDependencies): AgentsDependencies {
  return Object.freeze({ ...dependencies });
}
