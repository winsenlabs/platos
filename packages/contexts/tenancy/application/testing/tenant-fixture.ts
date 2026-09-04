// A fully wired in-memory tenancy.
//
// `createTenancyFixture()` returns real use-case dependencies backed by the
// fakes, so every use case in this package is invokable in memory with no
// database, no framework and no network — which is the point of the onion.
//
// The record builders are NOT redefined here: they come from
// `domain/record-builders.ts`, so this context's domain tests, its application
// tests and the adapter's contract tests all build the same records.

import {
  anEnvironment,
  anOrganization,
  anOrganizationMembership,
  aProject,
  aProjectMembership,
  OrganizationRole,
  ProjectRole,
  userId,
  type EnvironmentRecord,
  type OrganizationMembershipRecord,
  type OrganizationRecord,
  type ProjectMembershipRecord,
  type ProjectRecord,
} from "../../domain/index.js";
import type { TenancyDependencies } from "../dependencies.js";
import {
  createAccessKeyRevocationCounter,
  createInvitationTokenIssuer,
  createMutableClock,
  createOperatorDirectory,
  createRecordingLocks,
  createRecordingSessionRevoker,
  createSequentialIdGenerator,
  createSilentLogger,
  createUnitOfWork,
  type MutableClock,
  type RecordingLocks,
  type RecordingSessionRevoker,
  type RecordingUnitOfWork,
  type StubOperatorDirectory,
} from "./fakes.js";
import {
  createInMemoryTenancyRepository,
  createTenancyStore,
  type TenancyStore,
} from "./in-memory-repository.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

export interface TenancyFixture {
  readonly store: TenancyStore;
  readonly dependencies: TenancyDependencies;
  readonly clock: MutableClock;
  readonly locks: RecordingLocks;
  readonly sessionRevoker: RecordingSessionRevoker;
  readonly operators: StubOperatorDirectory;
  readonly unitOfWork: RecordingUnitOfWork;
}

export function createTenancyFixture(): TenancyFixture {
  const store = createTenancyStore();
  const clock = createMutableClock(EPOCH);
  const locks = createRecordingLocks(store);
  const sessionRevoker = createRecordingSessionRevoker();
  const operators = createOperatorDirectory();
  const unitOfWork = createUnitOfWork();
  const dependencies: TenancyDependencies = {
    repository: createInMemoryTenancyRepository(store),
    locks,
    sessionRevoker,
    accessKeyRevocation: createAccessKeyRevocationCounter(store),
    invitationTokens: createInvitationTokenIssuer(),
    operators,
    clock,
    ids: createSequentialIdGenerator(),
    unitOfWork,
    logger: createSilentLogger(),
  };
  return { store, dependencies, clock, locks, sessionRevoker, operators, unitOfWork };
}

/** The standard tree: one organization, one project, one environment. */
export interface SeededTree {
  readonly organization: OrganizationRecord;
  readonly project: ProjectRecord;
  readonly environment: EnvironmentRecord;
}

export function seedTree(store: TenancyStore, prefix = "acme"): SeededTree {
  const organization = anOrganization(prefix);
  const project = aProject(`${prefix}-app`, organization.id);
  const environment = anEnvironment(`${prefix}-prod`, project.id);
  store.organizations.push(organization);
  store.projects.push(project);
  store.environments.push(environment);
  return { organization, project, environment };
}

/** A user placed inside a seeded tree, with the rows that put them there. */
export interface SeededMember {
  readonly organizationMembership: OrganizationMembershipRecord;
  /** Null when the member holds no project role, which gate 3 discriminates. */
  readonly projectMembership: ProjectMembershipRecord | null;
}

/**
 * Put a user inside a seeded tree.
 *
 * The two rows are built by the SAME `domain/record-builders.ts` every other
 * suite uses, so a membership seeded here is byte-identical to one seeded in
 * this context's own tests. `projectRole: null` — the default — leaves the user
 * with no `ProjectMembership` at all, which is the input gate 3 of
 * `decideEnvironmentAccess` actually discriminates on; passing a role adds the
 * row with its integrity key derived from the project, exactly as the composite
 * foreign key derives it.
 */
export function seedMember(
  store: TenancyStore,
  tree: SeededTree,
  user: string,
  options: {
    readonly organizationRole?: OrganizationRole;
    readonly projectRole?: ProjectRole | null;
    readonly deactivatedAt?: Date | null;
  } = {},
): SeededMember {
  const organizationMembership = anOrganizationMembership(
    `${user}-in-${tree.organization.id}`,
    tree.organization.id,
    userId(user),
    {
      role: options.organizationRole ?? OrganizationRole.MEMBER,
      deactivatedAt: options.deactivatedAt ?? null,
    },
  );
  store.organizationMemberships.push(organizationMembership);
  const projectRole = options.projectRole ?? null;
  if (projectRole === null) return { organizationMembership, projectMembership: null };
  const projectMembership = aProjectMembership(
    `${user}-on-${tree.project.id}`,
    tree.project,
    organizationMembership,
    { role: projectRole },
  );
  store.projectMemberships.push(projectMembership);
  return { organizationMembership, projectMembership };
}
