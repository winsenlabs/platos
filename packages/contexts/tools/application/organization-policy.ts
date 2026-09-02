// Use cases: tier-2 organization policy.
//
// `OrganizationMcpPolicy` is a pattern and an effect, keyed
// `@@unique([organizationId, pattern])`. It is the only tier an ORGANIZATION
// controls: tier 1 is the installation's, tier 3 is an agent version's and tier
// 4 is a session's.
//
// THE COLUMN IS TWO-VALUED AND THE STATE SPACE IS THREE-VALUED. `PolicyEffect`
// is ALLOW or DENY, so this tier can say `auto_allow` and `block` and cannot
// say `require_approval`. That is a real expressive gap and it is refused
// loudly rather than rounded: `policyEffectUnsupported` names the state the
// caller asked for, so an operator who wanted "make my org approve every
// channel mutation" is told the tier cannot do it instead of quietly getting
// `auto_allow` and believing otherwise.
//
// A POLICY MAY ONLY TIGHTEN — AND AN `ALLOW` ROW DOES NOT LOOSEN ANYTHING.
// Writing `{ pattern: "gdpr.*", effect: ALLOW }` does not undo the tier-1
// baseline; it contributes `auto_allow` to a `max` that tier 1 already pushed
// to `require_approval`. Operators expect the opposite often enough that the
// listing view says so, and `domain/permission.ts` is where it is true.

import { err, ok, type Result } from "@platos/kernel";

import {
  effectFromState,
  policyEffectUnsupported,
  policyPatternInvalid,
  type OrganizationMcpPolicyId,
  type PermissionState,
} from "../domain/index.js";
import { requireAccess, verifyOperator } from "./authorization.js";
import type { ToolsDependencies } from "./dependencies.js";
import type { OrganizationPolicyRecord } from "./ports/index.js";

/** Transcribed bounds. A pattern outside them is a typo, not a policy. */
export const MIN_POLICY_PATTERN_LENGTH = 1;
export const MAX_POLICY_PATTERN_LENGTH = 200;

export interface ReadOrganizationPoliciesQuery {
  readonly authorization: unknown;
}

export interface SetOrganizationPolicyCommand extends ReadOrganizationPoliciesQuery {
  readonly pattern: string;
  readonly state: PermissionState;
}

export interface DeleteOrganizationPolicyCommand extends ReadOrganizationPoliciesQuery {
  readonly organizationMcpPolicyId: OrganizationMcpPolicyId;
}

export async function listOrganizationPolicies(
  dependencies: ToolsDependencies,
  query: ReadOrganizationPoliciesQuery,
): Promise<Result<readonly OrganizationPolicyRecord[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  return dependencies.repository.listOrganizationPolicies(granted.value.scope);
}

export async function setOrganizationPolicy(
  dependencies: ToolsDependencies,
  command: SetOrganizationPolicyCommand,
): Promise<Result<OrganizationPolicyRecord>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const permitted = requireAccess(granted.value, "secret:mutate");
  if (!permitted.ok) return err(permitted.error);

  const pattern = command.pattern.trim();
  if (pattern.length < MIN_POLICY_PATTERN_LENGTH || pattern.length > MAX_POLICY_PATTERN_LENGTH) {
    return err(
      policyPatternInvalid(
        `a policy pattern must be ${MIN_POLICY_PATTERN_LENGTH}–${MAX_POLICY_PATTERN_LENGTH} characters`,
      ),
    );
  }

  const effect = effectFromState(command.state);
  if (effect === null) return err(policyEffectUnsupported(command.state));

  return dependencies.repository.upsertOrganizationPolicy(granted.value.scope, pattern, effect);
}

export async function deleteOrganizationPolicy(
  dependencies: ToolsDependencies,
  command: DeleteOrganizationPolicyCommand,
): Promise<Result<boolean>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const permitted = requireAccess(granted.value, "secret:mutate");
  if (!permitted.ok) return err(permitted.error);
  return dependencies.repository.deleteOrganizationPolicy(
    granted.value.scope,
    command.organizationMcpPolicyId,
  );
}
