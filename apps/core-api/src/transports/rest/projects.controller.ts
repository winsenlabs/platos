// /api/v1/projects — the projects an operator can see, and the founding of one.
//
// THE LISTING IS THE ROUTE WIN-257 T4 EXISTS FOR. `listVisibleProjects` replaced
// `operatorVisibleProjectWhere` — an authorization rule that existed nowhere but
// as a `Prisma.ProjectWhereInput` in the Remix tree — and the contract states the
// rule it ported: "an organization OWNER/ADMIN sees every unarchived project in
// the organization, everybody else sees exactly the projects they hold a
// membership on, and a deactivated organization membership hides all of them
// without a single `ProjectMembership` row changing."
//
// `through` IS ON THE WIRE BECAUSE THE RULE HAS TWO BRANCHES. A row reached by
// `organization-admin` and one reached by `project-membership` are the same
// project and a different authorization, and a client that cannot tell them apart
// cannot render "you can see this because you administer the organization" — nor
// can a support engineer diagnose why a project vanished when a membership was
// deactivated. Dropping it would make the two branches indistinguishable on the
// wire, which is the same defect as two guards sharing an error code.
//
// THE CREATE COMMITS THREE ROWS OR NONE, AND THIS ROUTE DOES NOT KNOW THAT.
// `createProject` commits the project, its first environment and the creator's
// ADMIN membership in one unit of work, because "a project with no environment is
// unreachable" and one whose creator holds no membership "is lost to any creator
// who is not already an organization admin". The transport passes six fields and
// renders what came back; the invariant is the use case's, which is exactly where
// M4 must keep it.

import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, Req } from "@nestjs/common";

import { asIdentifier, type Result } from "@platos/kernel";
import type { OrganizationId } from "@platos/kernel";
import type { CreatedProject, OperatorProject, UserId } from "@platos/context-tenancy";

import { API_VERSION } from "../../http/api-surface.js";
import { DomainValidationPipe, UNPAGED_QUERY_PIPE } from "../../http/validation.pipe.js";
import { BodyReader, jsonBody } from "./body.js";
import { REST_APPLICATION, type RestApplication } from "./dependencies.js";
import { collectionEnvelope, itemEnvelope, wholeCollection, type CollectionEnvelope, type ItemEnvelope } from "./envelope.js";
import { raise } from "./fault.js";
import { instant, nullableInstant } from "./resources.js";
import { authenticateOperator, requireTenancy, type InboundOperatorRequest } from "./operator.js";

export interface ProjectResource {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  /** `organization-admin` or `project-membership`. See the banner. */
  readonly through: string;
}

/** What `createProject` commits, all three rows of it. */
export interface CreatedProjectResource {
  readonly project: ProjectResource;
  readonly environment: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly createdAt: string;
  };
  readonly membership: { readonly id: string; readonly role: string };
}

export interface CreateProjectBody {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly environmentName: string;
  readonly environmentSlug: string;
}

export const createProjectValidator = (input: unknown): Result<CreateProjectBody> => {
  const body = jsonBody(input);
  if (!body.ok) return body;
  const reader = new BodyReader(body.value);
  const organizationId = reader.string("organizationId");
  const name = reader.string("name");
  const slug = reader.string("slug");
  const environmentName = reader.string("environmentName");
  const environmentSlug = reader.string("environmentSlug");
  return reader.finish({ organizationId, name, slug, environmentName, environmentSlug });
};

const CREATE_PROJECT_PIPE = new DomainValidationPipe(createProjectValidator);

export function projectResource(row: OperatorProject): ProjectResource {
  return {
    id: row.project.id,
    organizationId: row.project.organizationId,
    slug: row.project.slug,
    name: row.project.name,
    archivedAt: nullableInstant(row.project.archivedAt),
    createdAt: instant(row.project.createdAt),
    through: row.through,
  };
}

function createdProjectResource(created: CreatedProject): CreatedProjectResource {
  return {
    // `through` IS `project-membership` BECAUSE THAT IS THE ROW JUST COMMITTED.
    // `createProject` always writes the creator an ADMIN PROJECT membership, so
    // the grant that makes this project visible to them is that membership —
    // even for an organization admin, who would also have seen it the other way.
    // Reporting the grant the operation MADE, rather than the widest one that
    // happens to apply, is what keeps this field a fact rather than a guess.
    project: projectResource({ project: created.project, through: "project-membership" }),
    environment: {
      id: created.environment.id,
      slug: created.environment.slug,
      name: created.environment.name,
      createdAt: instant(created.environment.createdAt),
    },
    membership: { id: created.membership.id, role: created.membership.role },
  };
}

@Controller({ path: "projects", version: API_VERSION })
export class ProjectsController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get()
  async list(
    @Req() request: InboundOperatorRequest,
    @Query(UNPAGED_QUERY_PIPE) _page: null,
  ): Promise<CollectionEnvelope<ProjectResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const tenancy = requireTenancy(app);
    const rows = await tenancy.listVisibleProjects(asIdentifier<UserId>(operator.effectiveUserId));
    if (!rows.ok) raise(rows.error);
    return collectionEnvelope(wholeCollection(rows.value.map(projectResource)));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() request: InboundOperatorRequest,
    @Body(CREATE_PROJECT_PIPE) body: CreateProjectBody,
  ): Promise<ItemEnvelope<CreatedProjectResource>> {
    const app = this.application.app;
    const operator = await authenticateOperator(app, request);
    const tenancy = requireTenancy(app);
    // THE ORGANIZATION IS THE CALLER'S CLAIM AND THE USE CASE IS THE JUDGE. It
    // arrives in the body, and `createProject` answers
    // `TENANCY_PROJECT_CREATION_FORBIDDEN` with `details.reason` of
    // `no-such-organization`, `organization-archived`, `not-a-member` or
    // `membership-deactivated`. A transport that pre-checked membership would
    // hold half of that decision, and its half would be the one that went stale.
    const created = await tenancy.createProject({
      organizationId: asIdentifier<OrganizationId>(body.organizationId),
      actorUserId: asIdentifier<UserId>(operator.effectiveUserId),
      name: body.name,
      slug: body.slug,
      environmentName: body.environmentName,
      environmentSlug: body.environmentSlug,
    });
    if (!created.ok) raise(created.error);
    return itemEnvelope(createdProjectResource(created.value));
  }
}
