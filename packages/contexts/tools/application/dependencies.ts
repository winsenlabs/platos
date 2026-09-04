// What every use case in this context is constructed with.
//
// One frozen bundle rather than a dozen constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing in
// this package reaches for the wall clock or a random generator. That is what
// makes a use case that dates an audit row, folds a latency into a health
// average, or mints a tool call reproducible at any instant — and it is what
// let the eleven separate `Date.now() - startTime` measurements in the source's
// executor collapse into one derivation in `domain/call.ts`.
//
// ON THE FOUR PEERS. ADR M0.3 §1 row 7 permits exactly `tenancy`,
// `identity-access`, `secrets` and `providers` plus the kernel. All four are
// genuinely called, and each for one reason:
//
//   `tenancy` mints the operator grant every control-surface use case verifies,
//   and it is where an `Entity` comes from. This context writes
//   `EnvironmentEntityTool` — the join between an environment and an entity —
//   and owns neither side of it, so it asks.
//
//   `identity-access` authenticates the INBOUND MCP caller. This is the §3
//   inversion, in code: the source has `auth.service` importing
//   `ToolRegistryService` to validate tool scopes at login, and §3 records the
//   destination as a PHYSICAL DELETE of that edge with the validation moving to
//   execution time inside `tools`. So the arrow runs `tools -> identity-access`,
//   one way, and the `identity-isolation` rule locks the reverse permanently.
//
//   `secrets` resolves the credential an `EntityMcpClient` names. This context
//   holds a `credentialId` and never material; `domain/mcp-client.ts` takes the
//   plaintext as a parameter for exactly this reason.
//
//   `providers` is held for the priced side of a tool call. `ToolCallAudit`
//   carries a `Decimal(18, 6)` `costCents`, and the only context that may turn
//   token usage into an exact decimal is the one that owns the rate cards.
//
// THE CATALOGUE-SHAPED INPUT IS `policy`. Every limit a rule consults is a
// parameter, so an installation can widen a page or shorten a dispatch budget
// without a code change and a test can exercise a rule against a two-tool
// index instead of five hundred.

import type { Clock, IdGenerator, UnitOfWork } from "@platos/kernel";
import type { IdentityAccessContract } from "@platos/context-identity-access";
import type { ProvidersContract } from "@platos/context-providers";
import type { SecretsContract } from "@platos/context-secrets";
import type { TenancyContract } from "@platos/context-tenancy";

import type { ToolsPolicy } from "../domain/index.js";
import type { ContentDigest, ToolDispatch, ToolsRepository } from "./ports/index.js";

export interface ToolsDependencies {
  readonly repository: ToolsRepository;
  readonly dispatch: ToolDispatch;
  readonly digest: ContentDigest;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly policy: ToolsPolicy;
  readonly tenancy: TenancyContract;
  readonly identityAccess: IdentityAccessContract;
  readonly secrets: SecretsContract;
  readonly providers: ProvidersContract;
}

export function toolsDependencies(dependencies: ToolsDependencies): ToolsDependencies {
  return Object.freeze({ ...dependencies });
}
