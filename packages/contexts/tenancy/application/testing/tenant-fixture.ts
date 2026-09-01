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
  aProject,
  type EnvironmentRecord,
  type OrganizationRecord,
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
