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
//   a loadout entry into a skill needs a `skills` contract that describes one.
//   At the time this context was made real, `skills` was still a generated
//   placeholder whose contract offers a single `describe(id)` returning a
//   placeholder aggregate. Calling that would be theatre. The handle is the
//   declared edge along which the loadout projection will travel when `skills`
//   lands, and `contracts/index.ts` says plainly which view is thin because of
//   it.

import type { Clock, IdGenerator, UnitOfWork } from "@platos/kernel";
import type { ProvidersContract } from "@platos/context-providers";
import type { SkillsContract } from "@platos/context-skills";
import type { TenancyContract } from "@platos/context-tenancy";

import type { AgentsPolicy } from "../domain/index.js";
import type {
  AgentsRepository,
  AgentVersionLock,
  MacroRecorder,
  ScaffoldingRepository,
} from "./ports/index.js";

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
  /** Opaque by design: see the note above. */
  readonly skills: SkillsContract;
}

export function agentsDependencies(dependencies: AgentsDependencies): AgentsDependencies {
  return Object.freeze({ ...dependencies });
}
