// /organizations/:organizationId/invitations and /invitations/accept
// — WHO MAY INVITE (D1), AND SPENDING AN INVITATION.
//
// D1 (2026-09-15): "Only an ACTIVE member with the role OWNER or ADMIN of the
// target organization may issue an invitation. Any other caller is refused with a
// distinct code. The rule lives in the tenancy application (`issueInvitation`),
// not in a transport." So this file checks nothing about the inviter. It
// authenticates an operator and hands the EFFECTIVE user to the use case, which
// answers `TENANCY_INVITATION_FORBIDDEN` for every caller who is not an active
// OWNER/ADMIN of THAT organization — a member, a deactivated admin, and a real
// admin of another organization who put this organization's id in the path. The
// last is the forged scope, and the use case refuses it as not-a-member, not as
// not-found: the lookup that would authorize it is keyed by the id the caller
// named.
//
// -----------------------------------------------------------------------------
// THE INVITATION TOKEN IS NOT IN THE RESPONSE, AND IT IS DELIVERED NOWHERE YET
//
// `issueInvitation` returns the raw token ("the secret to deliver"). D9 approves
// exactly two classes of secret-bearing response — one-time-reveal-by-design and
// protocol-required — and signs V1 rows off individually; an invitation token
// handed to the inviter is neither, and nobody signed it off. The Remix route this
// replaces returned `{ ok, invitationId }` and said "Delivery is handled by the
// configured operator channel", which was not true: nothing delivered it. So the
// V1 answer is the oracle's shape — the id, the expiry and how many outstanding
// invitations to that address it superseded — and delivery remains the open item
// it already was. Its next step is recorded where it belongs: a tenancy
// `InvitationDelivery` port bound to `notifier-email`, as D20 did for sign-in.
//
// -----------------------------------------------------------------------------
// ACCEPTING TAKES THE ADDRESS THE OPERATOR PROVED, NOT ONE THEY TYPED
//
// `acceptInvitation` compares the invitation's address against a CLAIMED address
// and against the account's own. The claimed address here is the authenticated
// operator's — the one identity-access verified by delivering a sign-in link to
// it — so a body field cannot claim somebody else's. The token is the only input.
//
// -----------------------------------------------------------------------------
// AND IT SPENDS THE INVITE_ACCEPT BUDGET FIRST, AS THE ORACLE DOES
//
// The oracle's `PlatosAuthService.acceptInvitation`
// (`internal-packages/tenancy-database/src/auth.ts`) consumes
// `AuthRateLimitAction.INVITE_ACCEPT` before its transaction opens, so a caller
// guessing tokens is refused at the limiter whether or not a guess would have
// matched. The budget belongs to identity-access and the use case to tenancy, and
// neither context may reach into the other's application, so the TRANSPORT spends
// it through identity-access's published `consumeRateLimit` and only then calls
// tenancy — two published methods, in the oracle's order. The bucket is the
// authenticated ACTOR (the human guessing, not an impersonated account), and the
// scope is null because no organization is known until the token resolves. With
// the limiter unreachable this refuses under D3 (`RATE_LIMIT_FAILED_CLOSED`).

import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";

import { asIdentifier, err, ok, type FieldViolation, type OrganizationId, type Result } from "@platos/kernel";
import type { OrganizationRole, UserId } from "@platos/context-tenancy";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe } from "../../http/validation.pipe.js";
import { BodyReader, jsonBody } from "./body.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import { itemEnvelope, type ItemEnvelope } from "./envelope.js";
import { raise } from "./fault.js";
import {
  authenticateOperator,
  requireIdentityAccess,
  requireTenancy,
  type InboundOperatorRequest,
} from "./operator.js";
import { instant } from "./resources.js";
import { requestInvalid } from "./transport-errors.js";

export interface IssueInvitationBody {
  readonly email: string;
  /** OWNER, ADMIN or MEMBER; MEMBER when absent. The use case refuses anything else. */
  readonly role?: string;
}

export interface AcceptInvitationBody {
  readonly token: string;
}

/** An issued invitation — and deliberately not its token. See the banner. */
export interface IssuedInvitationResource {
  readonly invitationId: string;
  readonly expiresAt: string;
  readonly supersededCount: number;
}

export interface AcceptedInvitationResource {
  readonly organizationId: string;
  readonly role: string;
  readonly membershipId: string;
}

/**
 * SHAPE ONLY: `email` a string, `role` a string when present. The address grammar
 * (`TENANCY_INVALID_EMAIL`) and the role enumeration (`TENANCY_INVALID_ROLE`) are
 * the use case's.
 */
export const issueInvitationValidator = (input: unknown): Result<IssueInvitationBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const violations: FieldViolation[] = [];
  const email = body.value["email"];
  if (typeof email !== "string") {
    violations.push({
      field: "body.email",
      code: email === undefined || email === null ? "required" : "not_a_string",
      message: "email is required and must be a string.",
    });
  }
  const role = body.value["role"];
  if (role !== undefined && typeof role !== "string") {
    violations.push({ field: "body.role", code: "not_a_string", message: "role must be a string." });
  }
  if (violations.length > 0) return err(requestInvalid(violations));
  return ok({ email: email as string, ...(role === undefined ? {} : { role: role as string }) });
};

export const acceptInvitationValidator = (input: unknown): Result<AcceptInvitationBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const reader = new BodyReader(body.value);
  const token = reader.string("token");
  return reader.finish({ token });
};

/** The INVITE_ACCEPT bucket for one authenticated human. See the banner. */
export function inviteAcceptBucket(actorUserId: string): string {
  return `invite-accept:user:${actorUserId}`;
}

const ISSUE_PIPE = new DomainValidationPipe(issueInvitationValidator);
const ACCEPT_PIPE = new DomainValidationPipe(acceptInvitationValidator);

@Controller({ version: API_VERSION })
export class InvitationsController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  /** 201: an invitation row that did not exist now does. */
  @Post("organizations/:organizationId/invitations")
  @HttpCode(HttpStatus.CREATED)
  async issue(
    @Req() request: InboundOperatorRequest,
    @Param("organizationId") organizationId: string,
    @Body(ISSUE_PIPE) body: IssueInvitationBody,
  ): Promise<ItemEnvelope<IssuedInvitationResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const issued = await requireTenancy(app).issueInvitation({
      organizationId: asIdentifier<OrganizationId>(organizationId),
      inviterUserId: asIdentifier<UserId>(operator.effectiveUserId),
      email: body.email,
      ...(body.role === undefined ? {} : { role: body.role as OrganizationRole }),
    });
    if (!issued.ok) raise(issued.error);
    return itemEnvelope({
      invitationId: issued.value.invitationId,
      expiresAt: instant(issued.value.expiresAt),
      supersededCount: issued.value.supersededCount,
    });
  }

  /** 200: the membership may have existed already — acceptance reactivates one. */
  @Post("invitations/accept")
  @HttpCode(HttpStatus.OK)
  async accept(
    @Req() request: InboundOperatorRequest,
    @Body(ACCEPT_PIPE) body: AcceptInvitationBody,
  ): Promise<ItemEnvelope<AcceptedInvitationResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const budget = await requireIdentityAccess(app).consumeRateLimit({
      action: "INVITE_ACCEPT",
      identifier: inviteAcceptBucket(operator.actorUserId),
      scope: null,
      principalId: null,
    });
    if (!budget.ok) raise(budget.error);
    const accepted = await requireTenancy(app).acceptInvitation({
      token: body.token,
      userId: asIdentifier<UserId>(operator.effectiveUserId),
      email: operator.email,
    });
    if (!accepted.ok) raise(accepted.error);
    return itemEnvelope({
      organizationId: accepted.value.organizationId,
      role: accepted.value.role,
      membershipId: accepted.value.membership.id,
    });
  }
}
