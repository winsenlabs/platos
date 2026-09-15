// /api/v1/organizations/:organizationId/members — THE TEAM PAGE, AND THE ROLE
// CHANGE ON IT.
//
// `settings.team` is one of the Remix routes T8 deletes, and it did two things
// with one query: listed an organization's active members with their addresses,
// and changed one member's role through `operatorAuth.changeMembershipRole`. The
// listing had no home in any context; it is now `listOrganizationMembers`, a
// tenancy read model that carries the route's OWNER/ADMIN gate with it. The role
// change was already on `TenancyContract` and served by nothing.
//
// THE ORGANIZATION IS THE CALLER'S CLAIM AND TENANCY IS THE JUDGE. It arrives in
// the path; this file authenticates the operator and passes the EFFECTIVE user
// through, and every decision about whether that user may see or change this
// organization's memberships is the use case's:
//
//   TENANCY_MEMBER_LIST_FORBIDDEN  403  not an active OWNER/ADMIN of it — and a
//                                       real admin of ANOTHER organization naming
//                                       this id is refused exactly the same way
//   TENANCY_MEMBERSHIP_FORBIDDEN   403  the ported role-change gates
//   TENANCY_LAST_OWNER             409  the organization would have no owner
//   TENANCY_INVALID_ROLE           400  not OWNER, ADMIN or MEMBER
//
// A transport that pre-checked membership here would hold half of each decision,
// and its half would be the one that went stale.
//
// THE ADDRESS IS ON THE WIRE BECAUSE THE PAGE SHOWS IT, and nothing else about the
// account is: `accountDisabledAt` says whether the member can still sign in, which
// a team page needs, and the user's other memberships, sessions and identities
// stay where they are.

import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Query, Req } from "@nestjs/common";

import { asIdentifier, type OrganizationId, type Result } from "@platos/kernel";
import type {
  OrganizationMemberView,
  OrganizationMembershipId,
  OrganizationRole,
  UserId,
} from "@platos/context-tenancy";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe, UNPAGED_QUERY_PIPE } from "../../http/validation.pipe.js";
import { BodyReader, jsonBody } from "./body.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import {
  collectionEnvelope,
  itemEnvelope,
  wholeCollection,
  type CollectionEnvelope,
  type ItemEnvelope,
} from "./envelope.js";
import { raise } from "./fault.js";
import { authenticateOperator, requireTenancy, type InboundOperatorRequest } from "./operator.js";
import { instant, nullableInstant } from "./resources.js";

export interface OrganizationMemberResource {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: string;
  /** The address the member signs in with; null when identity-access has no such user. */
  readonly email: string | null;
  /** Non-null when the account behind the membership can no longer sign in. */
  readonly accountDisabledAt: string | null;
}

export interface ChangeMemberRoleBody {
  readonly role: string;
}

/**
 * What a role change reports: whether anything moved.
 *
 * `revokedSessionCount` IS DELIBERATELY NOT ON THE WIRE, and the reason was
 * measured against a real PostgreSQL rather than assumed. The contract returns
 * the count the session revoker reported, but the schema's own row function
 * `revoke_operator_sessions_for_membership_change` fires on the role UPDATE and
 * ends the member's sessions FIRST, inside the same transaction — so the revoker
 * finds none left and reports 0 while every session did end. Publishing that
 * number would tell an administrator nothing was revoked when everything was.
 * `identity-tenancy-rest.integration.test.ts` reads the session row back instead.
 */
export interface MemberRoleChangeResource {
  readonly changed: boolean;
}

/** SHAPE ONLY. `TENANCY_INVALID_ROLE` is the use case's refusal, not this file's. */
export const changeMemberRoleValidator = (input: unknown): Result<ChangeMemberRoleBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const reader = new BodyReader(body.value);
  const role = reader.string("role");
  return reader.finish({ role });
};

const CHANGE_ROLE_PIPE = new DomainValidationPipe(changeMemberRoleValidator);

export function organizationMemberResource(row: OrganizationMemberView): OrganizationMemberResource {
  return {
    membershipId: row.membership.id,
    userId: row.membership.userId,
    role: row.membership.role,
    createdAt: instant(row.membership.createdAt),
    email: row.account?.email ?? null,
    accountDisabledAt: nullableInstant(row.account?.disabledAt ?? null),
  };
}

@Controller({ path: "organizations/:organizationId/members", version: API_VERSION })
export class OrganizationMembersController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get()
  async list(
    @Req() request: InboundOperatorRequest,
    @Param("organizationId") organizationId: string,
    @Query(UNPAGED_QUERY_PIPE) _page: null,
  ): Promise<CollectionEnvelope<OrganizationMemberResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const members = await requireTenancy(app).listOrganizationMembers({
      organizationId: asIdentifier<OrganizationId>(organizationId),
      actorUserId: asIdentifier<UserId>(operator.effectiveUserId),
    });
    if (!members.ok) raise(members.error);
    return collectionEnvelope(wholeCollection(members.value.map(organizationMemberResource)));
  }

  /**
   * 200: the membership already existed and keeps its id. A change ENDS the
   * member's sessions in the same transaction; see `MemberRoleChangeResource` for
   * why the count of them is not reported.
   */
  @Patch(":membershipId")
  @HttpCode(HttpStatus.OK)
  async changeRole(
    @Req() request: InboundOperatorRequest,
    @Param("organizationId") organizationId: string,
    @Param("membershipId") membershipId: string,
    @Body(CHANGE_ROLE_PIPE) body: ChangeMemberRoleBody,
  ): Promise<ItemEnvelope<MemberRoleChangeResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const changed = await requireTenancy(app).changeMembershipRole({
      organizationId: asIdentifier<OrganizationId>(organizationId),
      membershipId: asIdentifier<OrganizationMembershipId>(membershipId),
      actorUserId: asIdentifier<UserId>(operator.effectiveUserId),
      // THE CAST IS THE CONTRACT'S TYPE, NOT A CHECK. The use case refuses a value
      // outside the enumeration with its own code; see the banner.
      role: body.role as OrganizationRole,
    });
    if (!changed.ok) raise(changed.error);
    return itemEnvelope({ changed: changed.value.changed });
  }
}
