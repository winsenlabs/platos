// /api/v1/organizations — "my organizations", and the founding of one.
//
// WIN-257 T2 built `createOrganization` and WIN-257 T4 built
// `listOperatorOrganizations`, and until now neither was reachable over HTTP: the
// only creator of an organization in this product's history is a Prisma nested
// write in a Remix route, and the only reader is a query in the same tree. This
// controller is the first time either is served by the canonical V1 surface.
//
// THE LISTING TAKES NO ORGANIZATION ID, AND THAT IS THE AUTHORIZATION.
// `listOperatorOrganizations(userId)` is "keyed by the operator alone. There is no
// organization id on this call, so a caller has nothing to substitute" — the
// contract's own words. This route therefore needs no scope check of its own and
// must not invent one: the set it returns is defined by who is asking.
//
// THE CREATE IS `accepted`, NOT `required`, FOR `Idempotency-Key`.
// `http/idempotency-policy.ts` requires the header only for the eight one-time
// secret mints, "returned once and never readable again". An organization is not
// a secret: a replayed create either succeeds once and then fails on the slug's
// `@unique`, or — with a key — replays the first response byte for byte, which is
// what the gate already does for every unlisted side-effecting method. Adding a
// ninth `required` row would be inventing a policy for a route that does not mint
// anything.

import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, Req } from "@nestjs/common";

import { asIdentifier, type Result } from "@platos/kernel";
import type { CreatedOrganization, OperatorOrganization, UserId } from "@platos/context-tenancy";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe, UNPAGED_QUERY_PIPE } from "../../http/validation.pipe.js";
import { BodyReader, jsonBody } from "./body.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import { collectionEnvelope, itemEnvelope, wholeCollection, type CollectionEnvelope, type ItemEnvelope } from "./envelope.js";
import { raise } from "./fault.js";
import { instant, nullableInstant } from "./resources.js";
import { authenticateOperator, requireTenancy, type InboundOperatorRequest } from "./operator.js";

/** One row of "my organizations", with the membership that put it there. */
export interface OrganizationResource {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  /** How this operator reaches it. Absent from a bare organization record. */
  readonly membership: {
    readonly id: string;
    readonly role: string;
    readonly deactivatedAt: string | null;
  };
}

export interface CreateOrganizationBody {
  readonly name: string;
  readonly slug: string;
}

/**
 * SHAPE ONLY. `createOrganization` refuses a blank name and a non-slug itself, and
 * a second opinion here would be a domain rule in a transport. See `body.ts`.
 */
export const createOrganizationValidator = (input: unknown): Result<CreateOrganizationBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const reader = new BodyReader(body.value);
  const name = reader.string("name");
  const slug = reader.string("slug");
  return reader.finish({ name, slug });
};

const CREATE_ORGANIZATION_PIPE = new DomainValidationPipe(createOrganizationValidator);

export function organizationResource(row: OperatorOrganization): OrganizationResource {
  return {
    id: row.organization.id,
    slug: row.organization.slug,
    name: row.organization.name,
    archivedAt: nullableInstant(row.organization.archivedAt),
    createdAt: instant(row.organization.createdAt),
    membership: {
      id: row.membership.id,
      role: row.membership.role,
      deactivatedAt: nullableInstant(row.membership.deactivatedAt),
    },
  };
}

function createdOrganizationResource(created: CreatedOrganization): OrganizationResource {
  return organizationResource({
    organization: created.organization,
    membership: created.founderMembership,
  });
}

@Controller({ path: "organizations", version: API_VERSION })
export class OrganizationsController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get()
  async list(
    @Req() request: InboundOperatorRequest,
    @Query(UNPAGED_QUERY_PIPE) _page: null,
  ): Promise<CollectionEnvelope<OrganizationResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const tenancy = requireTenancy(app);
    // THE EFFECTIVE USER, NOT THE ACTOR. Under impersonation the operator is
    // seeing the product as the impersonated account, and `effectiveUserId` is
    // the contract's own name for "whose permissions apply". Listing the support
    // engineer's own organizations here would be a silent, invisible failure —
    // a page that renders perfectly and shows the wrong tenant's data.
    const rows = await tenancy.listOperatorOrganizations(
      asIdentifier<UserId>(operator.effectiveUserId),
    );
    if (!rows.ok) raise(rows.error);
    return collectionEnvelope(wholeCollection(rows.value.map(organizationResource)));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() request: InboundOperatorRequest,
    @Body(CREATE_ORGANIZATION_PIPE) body: CreateOrganizationBody,
  ): Promise<ItemEnvelope<OrganizationResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const tenancy = requireTenancy(app);
    const created = await tenancy.createOrganization({
      name: body.name,
      slug: body.slug,
      founderUserId: asIdentifier<UserId>(operator.effectiveUserId),
    });
    if (!created.ok) raise(created.error);
    return itemEnvelope(createdOrganizationResource(created.value));
  }
}
