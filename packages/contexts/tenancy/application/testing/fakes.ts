// Deterministic doubles for every port a tenancy use case depends on.
//
// TIME AND IDENTITY ARE INPUTS. `MutableClock` starts at a fixed instant and
// only moves when a test moves it; `SequentialIdGenerator` counts. Between them
// every assertion below is exact rather than approximate, which is what the
// kernel `Clock`/`IdGenerator` ports are for.

import type {
  Clock,
  EnvironmentId,
  IdGenerator,
  LogFields,
  LogLevel,
  Logger,
  OrganizationId,
  TransactionScope,
  Ulid,
  UnitOfWork,
  Uuid,
} from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

import type {
  EmailAddress,
  SessionRevocationOrder,
  TokenDigest,
  UserId,
} from "../../domain/index.js";
import type {
  EnvironmentAccessKeyRevocationCounter,
  InvitationTokenIssuer,
  OperatorAccount,
  OperatorDirectory,
  OperatorSessionRevoker,
  TenancyLocks,
} from "../ports/index.js";
import type { TenancyStore } from "./in-memory-repository.js";

export interface MutableClock extends Clock {
  advance(milliseconds: number): void;
  set(instant: Date): void;
}

export function createMutableClock(start = new Date("2026-01-01T00:00:00.000Z")): MutableClock {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
    set: (instant) => {
      current = instant;
    },
  };
}

export function createSequentialIdGenerator(prefix = "id"): IdGenerator {
  let counter = 0;
  return {
    uuid: () => asIdentifier<Uuid>(`${prefix}-${(counter += 1)}`),
    ulid: () => asIdentifier<Ulid>(`${prefix}-ulid-${(counter += 1)}`),
  };
}

export interface RecordingUnitOfWork extends UnitOfWork {
  /** How many transactions were opened. Nested `run` joins rather than opens. */
  readonly transactionCount: () => number;
  /** How many outermost transactions rolled back. */
  readonly rollbackCount: () => number;
}

/** Shallow copy of every row list. Records are replaced, never mutated. */
function snapshot(store: TenancyStore): TenancyStore {
  return {
    organizations: [...store.organizations],
    projects: [...store.projects],
    environments: [...store.environments],
    organizationMemberships: [...store.organizationMemberships],
    projectMemberships: [...store.projectMemberships],
    invitations: [...store.invitations],
    entities: [...store.entities],
    environmentSessions: [...store.environmentSessions],
    sequence: store.sequence,
  };
}

/** Put every row list back the way `snapshot` found it, in place. */
function restore(store: TenancyStore, taken: TenancyStore): void {
  store.organizations.splice(0, store.organizations.length, ...taken.organizations);
  store.projects.splice(0, store.projects.length, ...taken.projects);
  store.environments.splice(0, store.environments.length, ...taken.environments);
  store.organizationMemberships.splice(
    0,
    store.organizationMemberships.length,
    ...taken.organizationMemberships,
  );
  store.projectMemberships.splice(0, store.projectMemberships.length, ...taken.projectMemberships);
  store.invitations.splice(0, store.invitations.length, ...taken.invitations);
  store.entities.splice(0, store.entities.length, ...taken.entities);
  store.environmentSessions.splice(0, store.environmentSessions.length, ...taken.environmentSessions);
  store.sequence = taken.sequence;
}

/**
 * Runs the work and hands it an opaque `TransactionScope`. Nesting JOINS the
 * outer transaction, which is the kernel port's stated contract, so a use case
 * built from two smaller ones stays one transaction.
 *
 * IT ROLLS BACK, and it takes the store in order to be able to. The earlier
 * version of this fake did not — it said so, and said a test wanting "nothing
 * was written" should assert on the store instead. That was wrong in a way only
 * a multi-write use case exposes: with no rollback, a transaction whose SECOND
 * write throws leaves the FIRST one committed in the store, so an atomicity test
 * written against this fixture would have to assert the very corruption the
 * transaction exists to prevent, and would pass against a use case with no
 * transaction at all. `createProject` writes three rows, so the fixture has to
 * be able to take them all back.
 *
 * WHAT IT DOES NOT DO is turn a returned error `Result` into a rollback. Only a
 * REJECTION rolls back, which is exactly `UnitOfWork.run`'s contract and exactly
 * the trap `cost-monitoring` fell into: an error `Result` returned from inside
 * `run` resolves the promise, and a resolved promise commits. A use case that
 * must not commit has to throw, and the suites below prove each one does.
 */
export function createUnitOfWork(store: TenancyStore): RecordingUnitOfWork {
  let depth = 0;
  let opened = 0;
  let rolledBack = 0;
  let current: TransactionScope | null = null;
  let taken: TenancyStore | null = null;
  return {
    transactionCount: () => opened,
    rollbackCount: () => rolledBack,
    async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
      const outermost = current === null;
      if (outermost) {
        opened += 1;
        current = { transactionId: asIdentifier(`txn-${opened}`) };
        taken = snapshot(store);
      }
      const transaction = current as TransactionScope;
      depth += 1;
      try {
        return await work(transaction);
      } catch (failure) {
        // Only the outermost frame owns the rollback; a nested `run` joined this
        // transaction and must not restore a snapshot it never took.
        if (depth === 1 && taken !== null) {
          restore(store, taken);
          rolledBack += 1;
        }
        throw failure;
      } finally {
        depth -= 1;
        if (depth === 0) {
          current = null;
          taken = null;
        }
      }
    },
  };
}

export function createSilentLogger(): Logger {
  const logger: Logger = {
    log: (_level: LogLevel, _message: string, _fields?: LogFields) => undefined,
    child: (_fields: LogFields) => logger,
  };
  return logger;
}

/**
 * The advisory and row locks, recorded so a test can assert a use case took
 * them. `lockOrganizationForUpdate` reproduces the oracle's condition exactly:
 * the row must exist AND be unarchived, or the caller denies.
 */
export interface RecordingLocks extends TenancyLocks {
  readonly organizationLocks: readonly OrganizationId[];
  readonly invitationSlots: readonly string[];
  readonly environmentLocks: readonly EnvironmentId[];
}

export function createRecordingLocks(store: TenancyStore): RecordingLocks {
  const organizationLocks: OrganizationId[] = [];
  const invitationSlots: string[] = [];
  const environmentLocks: EnvironmentId[] = [];
  return {
    organizationLocks,
    invitationSlots,
    environmentLocks,
    async lockOrganizationForUpdate(organizationId: OrganizationId, _transaction) {
      organizationLocks.push(organizationId);
      const row = store.organizations.find((candidate) => candidate.id === organizationId);
      return row !== undefined && row.archivedAt === null;
    },
    async lockInvitationSlot(organizationId: OrganizationId, email: EmailAddress, _transaction) {
      invitationSlots.push(`organization-invitation:${organizationId}:${email}`);
    },
    async lockEnvironmentForUpdate(environmentId: EnvironmentId, _transaction) {
      environmentLocks.push(environmentId);
      return store.environments.some((candidate) => candidate.id === environmentId);
    },
  };
}

/**
 * Stands in for identity-access's `OperatorSession` table. Seed it with the
 * live sessions of a user and assert they end when a privilege changes.
 */
export interface RecordingSessionRevoker extends OperatorSessionRevoker {
  readonly orders: readonly SessionRevocationOrder[];
  seed(userId: UserId, liveSessionCount: number): void;
  liveSessions(userId: UserId): number;
}

export function createRecordingSessionRevoker(): RecordingSessionRevoker {
  const orders: SessionRevocationOrder[] = [];
  const live = new Map<UserId, number>();
  return {
    orders,
    seed: (userId, liveSessionCount) => {
      live.set(userId, liveSessionCount);
    },
    liveSessions: (userId) => live.get(userId) ?? 0,
    async revoke(order: SessionRevocationOrder, _transaction) {
      orders.push(order);
      const revoked = live.get(order.userId) ?? 0;
      live.set(order.userId, 0);
      return revoked;
    },
  };
}

/** Reads and increments the counter held on the environment row in the store. */
export function createAccessKeyRevocationCounter(
  store: TenancyStore,
): EnvironmentAccessKeyRevocationCounter {
  return {
    async read(environmentId: EnvironmentId) {
      const row = store.environments.find((candidate) => candidate.id === environmentId);
      return row?.accessKeyRevocationVersion ?? null;
    },
    async bump(environmentId: EnvironmentId, _transaction) {
      const index = store.environments.findIndex((candidate) => candidate.id === environmentId);
      const row = store.environments[index];
      if (row === undefined) throw new Error(`no environment ${environmentId} in store`);
      const next = {
        ...row,
        accessKeyRevocationVersion: row.accessKeyRevocationVersion + 1,
      };
      store.environments.splice(index, 1, next);
      return next.accessKeyRevocationVersion;
    },
  };
}

/** Deterministic tokens: no randomness, and the digest is not the token. */
export function createInvitationTokenIssuer(): InvitationTokenIssuer {
  let counter = 0;
  const digest = (token: string) => asIdentifier<TokenDigest>(`digest:${token}`);
  return {
    mint: () => {
      const token = `plt_inv_${(counter += 1)}`;
      return { token, digest: digest(token) };
    },
    digest,
  };
}

export interface StubOperatorDirectory extends OperatorDirectory {
  add(account: OperatorAccount): void;
}

export function createOperatorDirectory(): StubOperatorDirectory {
  const accounts = new Map<UserId, OperatorAccount>();
  return {
    add: (account) => {
      accounts.set(account.userId, account);
    },
    async findAccount(userId: UserId) {
      return accounts.get(userId) ?? null;
    },
  };
}
