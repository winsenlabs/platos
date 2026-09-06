#!/usr/bin/env node
// Generates the ADR M0.3 §4 V1 package skeleton and its complete TypeScript
// project graph.
//
// OWNERSHIP IS TWO-TIER (WIN-256).
//
//   Scaffolding — every project's package.json, tsconfig.json and README.md,
//   plus the root solution tsconfig. This tier is the ADR §1 context DAG made
//   executable: 32 projects, 94 project edges. It is generated and byte-compared
//   for the life of the V1 layout and is NEVER released.
//
//   Source — the declaration-only placeholder .ts files. This tier is generated
//   only until a project's source tree is ADOPTED by real implementation code.
//
// Until M2 there was one tier and the generator owned every file under the V1
// roots, so `--check` reported any newly added source file as EXTRA. That is
// correct for a skeleton and unworkable for real code: it made adding a single
// domain file a CI failure. Adoption is the seam. It is explicit, reviewed and
// monotonic — un-adopting a project that still holds real files fails closed,
// because its placeholders reappear MISSING and its real files become EXTRA.
//
// Adopting a project releases ONLY its source tree. Its three scaffolding files
// stay byte-compared, it keeps its place in the 32/94 graph, and every rule in
// scripts/arch/boundary-rules.mjs continues to police the real code that lands
// there.
//
//   node scripts/arch/gen-v1-skeleton.mjs            # write generated files
//   node scripts/arch/gen-v1-skeleton.mjs --check    # fail on generated drift
//   node scripts/arch/gen-v1-skeleton.mjs --list     # print emitted paths

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTEXT_DEPENDS_ON, CONTEXT_NAMES, SDK_CONTAINMENT } from "./boundary-rules.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

// Adapter-facing ports belong to their contexts. Only genuinely cross-cutting
// decoupling ports remain in the pure-leaf kernel (ADR M0.3 §13 amendment).
//
// AN ADAPTER DIRECTORY MAY SATISFY MORE THAN ONE PORT (ADR M0.3 §15 amendment).
// `port`/`owner` are the PRIMARY binding — the one the directory is named after
// and the one its README and manifest description lead with. `additional` holds
// every further port the same directory satisfies, each with the context that
// owns it. The pair is flattened by `adapterBindings()` below, and every gate
// that used to read `adapter.port` now reads that flattening instead, so a
// second binding is not a second declaration a reviewer has to remember to make.
//
// This is a WIDENING, not a relaxation: the flattened list is compared as a SET
// against the composition root's own table, so an adapter that satisfies a port
// it was not bound to and a port with no satisfying adapter both still fail —
// see `selfCheck` below and `scripts/arch/composition-root.mjs`.
export const ADAPTERS = [
  {
    dir: "postgres-tenancy",
    port: "TenancyRepository",
    owner: "tenancy",
    // WIN-258 T2. ONE PostgreSQL database behind ONE client, so ONE directory.
    // ADR M0.3 §4's body already spells this directory "per-context
    // repositories, owner-tagged"; §15 records why the body wins over the
    // header's narrower "implements ONE port".
    // WIN-258 T5 adds the THIRD, and the argument does not change with the
    // count: `tools` owns ten canonical rows in that same database, so its
    // repository is the same client, the same pool and the same transaction.
    //
    // WIN-258 T5 adds the FOURTH and FIFTH, for the seven rows of §1 row 5.
    // `agents` publishes TWO canonical-store ports rather than one —
    // `AgentsRepository` for the version/binding invariant and
    // `ScaffoldingRepository` for the two rows a SURFACE writes on its own
    // behalf — so it contributes two bindings to one directory.
    //
    // WIN-258 T5 adds the SIXTH. `cost-monitoring`'s six rows — Budget,
    // BudgetThresholdEvent, AlertChannel, AlertChannelConfiguration,
    // AlertDelivery and its send records — live in the SAME PostgreSQL
    // database, so they are behind the same client and in the same directory.
    // Adding an owner here is what gives this adapter its project reference and
    // workspace dependency on the context whose port it satisfies; §15 records
    // why the body's "per-context repositories, owner-tagged" wins over the
    // header's narrower "implements ONE port".
    additional: [
      { port: "IdentityAccessRepository", owner: "identity-access" },
      { port: "ToolsRepository", owner: "tools" },
      { port: "AgentsRepository", owner: "agents" },
      { port: "ScaffoldingRepository", owner: "agents" },
      { port: "BudgetRepository", owner: "cost-monitoring" },
      { port: "ChannelsRepository", owner: "channels" },
      // WIN-258 T5 — `governance`'s FIVE canonical-store ports, the SIXTH owner
      // of the one PostgreSQL client. `SafetyEvent`, `MessageRating`,
      // `EvalCriterion`, `AgentEval` and `GoldenSet` live in that same database,
      // so by §15 they are written from the same directory behind the same
      // client. The context publishes five SEPARATE ports rather than one
      // composite, and that is deliberate on its side: an eval is append-only
      // and a criterion is edited, a rating flips in place and a safety event is
      // never touched again. Five ports are five bindings.
      //
      // They are PROPERTIES on the adapter rather than spread-in methods, like
      // tenancy's five below — but for a stronger reason. Tenancy's are
      // properties so a composition root can hand each over under its own name;
      // these five COLLIDE with each other on `findById`, `page`, `create`,
      // `update` and `remove`, so a flat spread would answer four ports from one
      // table.
      { port: "SafetyLedger", owner: "governance" },
      { port: "RatingsRepository", owner: "governance" },
      { port: "CriteriaRepository", owner: "governance" },
      { port: "EvalsRepository", owner: "governance" },
      { port: "GoldenSetsRepository", owner: "governance" },
      // WIN-258 T5 adds the SEVENTH and EIGHTH. `secrets` owns four canonical
      // rows in that same database and publishes TWO canonical-store ports over
      // them, because `environment-variable-repository.ts` keeps the vault and
      // the configuration row in separate vocabularies on purpose.
      //
      // BOTH ARE SATISFIED BY PROPERTIES rather than by spread-in methods, and
      // unlike tenancy's five below that was FORCED. `SecretsRepository` and
      // `ToolsRepository` both declare a top-level `appendAudit`, with different
      // signatures, so one interface cannot extend both — the composition root
      // therefore proves these two as `PostgresTenancyAdapter["secrets"]` and
      // `PostgresTenancyAdapter["secretsVariables"]`.
      { port: "SecretsRepository", owner: "secrets" },
      { port: "EnvironmentVariableRepository", owner: "secrets" },
      // WIN-258 T5 adds the NINTH. `providers` owns four canonical rows in that
      // same database — `ProviderKey`, `EnvironmentProvider`, `Model` and
      // `ModelPrice` — and publishes ONE canonical-store port over all four.
      //
      // IT IS SATISFIED BY THE ADAPTER ITSELF rather than by a property: its
      // eighteen method names collide with nothing the directory already
      // publishes, so `PostgresTenancyAdapter extends ProvidersRepository`
      // resolves directly. The context's two OTHER ports get no row here and
      // that is a claim rather than an omission: `ModelRouter` already has one,
      // on `model-router-providers` below, and `ProviderProbeCache` is a
      // five-minute memo of what a provider said, which §13's map has no home
      // for and which no canonical store should hold.
      { port: "ProvidersRepository", owner: "providers" },
      // WIN-258 T5 — `conversations`' FOUR canonical-store ports, the NINTH
      // owner of the one PostgreSQL client. `Thread`, `Turn`, `Step` and
      // `PostmanExecution` live in that same database, so by §15 they are
      // written from the same directory behind the same client. The context
      // publishes four SEPARATE ports because they are four lifetimes, and
      // declares NO non-store port at all — there is nothing here to skip.
      { port: "ThreadRepository", owner: "conversations" },
      { port: "TurnRepository", owner: "conversations" },
      { port: "PostmanRepository", owner: "conversations" },
      { port: "ConversationsErasureStore", owner: "conversations" },
      // WIN-258 T5 adds the NINTH. `skills` owns three canonical rows in that
      // same database and publishes ONE canonical-store port over all three,
      // because a catalogue entry, a project's adoption of it and an
      // environment's binding of that adoption are one aggregate with one
      // uniqueness key.
      //
      // IT IS SATISFIED BY A PROPERTY rather than by spread-in methods, and like
      // `secrets`' two that was FORCED. `SkillsRepository.findInstallation` and
      // `ChannelsRepository.findInstallation` are both top-level members with
      // different signatures, so one interface cannot extend both — the
      // composition root therefore proves this one as
      // `PostgresTenancyAdapter["skills"]`.
      { port: "SkillsRepository", owner: "skills" },
      // WIN-258 M2.3 — TENANCY'S FIVE NON-REPOSITORY PORTS GET SLOTS.
      //
      // `TenancyDependencies` names six driven ports and only one of them is
      // the repository. The other five have been SATISFIED by this directory
      // since tranche 3 — they are named properties of
      // `PostgresTenancyAdapter` — and had no rows here, so
      // `reportAdapterSupply` could not judge them and readiness answered for
      // twelve directories while five ports it needs went unchecked.
      //
      // THE BINDING TABLE IS THE SURFACE THAT PROVES EVERY PORT HAS A
      // SATISFYING ADAPTER, so a port left out of it is not a smaller claim —
      // it silently narrows the gate's completeness property. Amendment 15
      // already allows many bindings per directory, so the five are rows on the
      // directory that holds them rather than a thirteenth package.
      //
      // They are PROPERTIES rather than spread-in methods, which is why the
      // composition root proves them as `PostgresTenancyAdapter["locks"]` and
      // not as `PostgresTenancyAdapter`: a nested port is satisfied by the
      // property's type, and asking whether the whole adapter extends
      // `TenancyLocks` would resolve to `never` and fail a binding that holds.
      { port: "TenancyLocks", owner: "tenancy" },
      { port: "OperatorSessionRevoker", owner: "tenancy" },
      { port: "EnvironmentAccessKeyRevocationCounter", owner: "tenancy" },
      { port: "InvitationTokenIssuer", owner: "tenancy" },
      { port: "OperatorDirectory", owner: "tenancy" },
      // WIN-258 T5 adds the NINTH owner. `memory` owns three canonical rows in
      // that same database — `Memory`, `MemoryEntity` and `MemoryRelationship` —
      // and publishes TWO canonical-store ports over them, because
      // `knowledge-graph-repository.ts` keeps the graph in its own vocabulary on
      // purpose: one store is on the write path of every remembered fact and the
      // other on the write path of extraction and the read path of fused
      // retrieval.
      //
      // BOTH ARE SATISFIED BY PROPERTIES rather than by spread-in methods, and
      // like `secrets`' pair that was FORCED. `KnowledgeGraphRepository` and
      // `TenancyRepository` both declare a top-level `findEntity`, with
      // different signatures, so one interface cannot extend both — the
      // composition root therefore proves these two as
      // `PostgresTenancyAdapter["memory"]` and
      // `PostgresTenancyAdapter["memoryGraph"]`.
      //
      // The context's four OTHER ports get no binding on this directory. `Cache`
      // is bound to `redis-cache` below — ADR M0.3 §13 assigns the PORT here and
      // puts Redis behind that adapter — while `EmbeddingModel` and
      // `ExtractionJudge` are priced provider calls and `ContentDigest` is a
      // synchronous host hash with no failure channel and no row.
      { port: "MemoryRepository", owner: "memory" },
      { port: "KnowledgeGraphRepository", owner: "memory" },
    ],
    note: "the tenancy-database client; per-context repositories, owner-tagged",
  },
  { dir: "outbox", port: "OutboxWriter", owner: "kernel", note: "THE single writer of the Event/outbox table" },
  { dir: "durable-runtime", port: "DurableRuntime", owner: "kernel", note: "the durable job runtime behind one kernel port (ADR M0.3 §12)" },
  { dir: "clickhouse-observability", port: "ObservabilitySink", owner: "observability", note: "the column-store observability client" },
  { dir: "objectstore-minio", port: "ObjectStore", owner: "files", note: "the S3-compatible object store client" },
  { dir: "redis-ratelimit", port: "RateLimiter", owner: "identity-access", note: "one namespaced keyspace, one owner" },
  { dir: "redis-cache", port: "Cache", owner: "memory", note: "one namespaced keyspace, one owner" },
  { dir: "redis-streams", port: "EventBus", owner: "kernel", note: "one namespaced keyspace, one owner" },
  { dir: "model-router-providers", port: "ModelRouter", owner: "providers", note: "the model-provider clients" },
  { dir: "channel-slack", port: "ChannelAdapter", owner: "channels", note: "one channel client" },
  { dir: "notifier-email", port: "Notifier", owner: "cost-monitoring", note: "outbound email" },
  { dir: "notifier-webhook", port: "Notifier", owner: "cost-monitoring", note: "outbound HTTP callbacks" },
];

/**
 * Every (adapter directory, port, owner) triple the layout declares, flattened.
 *
 * ONE entry per BINDING, not per directory. `postgres-tenancy` appears SIX
 * times because it satisfies three ports; every other directory appears once.
 * This is the list the composition root's table is compared against, the list
 * the project graph derives its owner edges from, and the list `selfCheck`
 * counts.
 */
export function adapterBindings(adapters = ADAPTERS) {
  const bindings = [];
  for (const adapter of adapters) {
    bindings.push({ adapter: adapter.dir, port: adapter.port, owner: adapter.owner });
    for (const extra of adapter.additional ?? []) {
      bindings.push({ adapter: adapter.dir, port: extra.port, owner: extra.owner });
    }
  }
  return bindings;
}

/** Every context (never the kernel) whose port `adapter` satisfies, in order. */
export function adapterOwners(adapter) {
  const owners = [adapter.owner];
  for (const extra of adapter.additional ?? []) {
    if (!owners.includes(extra.owner)) owners.push(extra.owner);
  }
  return owners;
}

/** The projects an adapter references: one per distinct owner it serves. */
export function adapterOwnerProjects(adapter) {
  return adapterOwners(adapter).map((owner) =>
    owner === "kernel" ? "packages/kernel" : `packages/contexts/${owner}`,
  );
}

/** The workspace packages an adapter depends on: one per distinct owner. */
export function adapterOwnerPackages(adapter) {
  return adapterOwners(adapter).map((owner) =>
    owner === "kernel" ? "@platos/kernel" : `@platos/context-${owner}`,
  );
}

// ADR M0.3 §4 names twelve concrete adapter DIRECTORIES and, after the §15
// amendment, FOURTEEN BINDINGS across them. Both are pinned: a thirteenth
// directory and a fifteenth binding are each a reviewed line rather than a
// silent consequence of editing a table.
// 13 -> 14 (WIN-258 T5, ADR M0.3 s15). `postgres-tenancy` gains a THIRD
// binding, `tools:ToolsRepository`. The directory count is UNCHANGED at twelve
// and that is the point of pinning the two separately: a new binding inside an
// existing directory is a different reviewed decision from a new directory, and
// a single pin could not have told them apart.
//
// 14 -> 16 (WIN-258 T5). `agents` publishes TWO canonical-store ports and the
// same directory satisfies both, so one tranche moves this pin by two while
// leaving EXPECTED_ADAPTER_COUNT alone.
//
// 16 -> 17 (WIN-258 T5). `cost-monitoring:BudgetRepository`, the SIXTH binding
// and the fifth owner of the one directory §15 gives the ORM. The DIRECTORY
// count is deliberately unmoved a third time: the whole point of the amendment
// is that another owner is a row on an existing directory rather than a
// thirteenth package holding a second PostgreSQL client.
//
// 17 -> 22 (WIN-258 M2.3). Tenancy's five NON-REPOSITORY driven ports get slots
// — locks, a session revoker, an access-key revocation counter, an invitation
// token issuer and an operator directory. They add no owner and no edge:
// `tenancy` was already an owner of this directory and the project reference it
// needs is already there. What they add is JUDGEABILITY — five ports this
// layout depends on that `reportAdapterSupply` could not previously see.
//
// 22 -> 31 (WIN-258 T5, four tranches of this wave landed together).
// `channels` adds ONE canonical-store binding (`ChannelsRepository`),
// `governance` FIVE (`SafetyLedger`, `RatingsRepository`, `CriteriaRepository`,
// `EvalsRepository`, `GoldenSetsRepository`) and `secrets` TWO
// (`SecretsRepository`, `EnvironmentVariableRepository`). `governance` publishes
// five separate ports because an eval is append-only and a criterion is edited,
// a rating flips in place and a safety event is never touched again; `secrets`
// publishes two because the vault and the configuration row that points at one
// are separate vocabularies. All eight are PROPERTIES rather than spread-in
// methods: `governance`'s five COLLIDE with each other on `findById`, `page`,
// `create`, `update` and `remove`, and `SecretsRepository` collides with
// `ToolsRepository` on a top-level `appendAudit` of a different signature, so
// one interface cannot extend both. EXPECTED_ADAPTER_COUNT is deliberately
// unmoved through all of it, which is the whole point of pinning the two
// separately: another owner is a row on an existing directory, not a thirteenth
// package holding a second PostgreSQL client.
//
// 30 -> 38 (WIN-258 T5, four times). `providers` adds ONE canonical-store binding,
// `ProvidersRepository`, over the four rows of ADR M0.3 §1 row 4; it is the
// NINTH owner of the one PostgreSQL client and the only one of tranche 5's
// stores whose port needed no property at all, because its eighteen method names
// are disjoint from every other port this directory satisfies and the
// composition root proves it against the adapter itself. `conversations` adds
// FOUR — `ThreadRepository`, `TurnRepository`, `PostmanRepository` and
// `ConversationsErasureStore` — and is the TENTH owner. Four ports and not one
// because they are four lifetimes: a thread is opened, forked, compacted and
// archived; a turn and its steps settle together and are never edited again; a
// postman execution outlives the turn it produced, which is what makes it an
// audit row; and the erasure half is the only surface in the context that
// deletes anything. Those four are PROPERTIES for the middle of the three
// reasons this file now carries — they do not collide with each other the way
// governance's five do and they are not blocked from spreading the way secrets'
// two are; `ConversationsDependencies` simply names four SLOTS, and a root has to
// hand each port over under its own name. EXPECTED_ADAPTER_COUNT is unmoved
// again, and for the tenth time that is the point of pinning the two separately.
//
// AND `memory` adds TWO canonical-store bindings,
// `MemoryRepository` and `KnowledgeGraphRepository`, and is the TWELFTH owner of
// the one PostgreSQL client. It publishes two ports because the memory store is
// on the write path of every remembered fact and the graph is on the write path
// of extraction and the read path of fused retrieval, and its own port file asks
// for the split so an installation can stand one of them up against a different
// technology. BOTH are PROPERTIES rather than spread-in methods, and that was
// forced the way `secrets`' pair was: `KnowledgeGraphRepository` and
// `TenancyRepository` both declare a top-level `findEntity` of a different
// signature, so one interface cannot extend both. EXPECTED_ADAPTER_COUNT is
// deliberately unmoved a TWELFTH time, which is the point of pinning the two
// separately.
export const EXPECTED_ADAPTER_COUNT = 12;
export const EXPECTED_BINDING_COUNT = 38;

/**
 * The `owner:Port` pairs that legitimately have more than one adapter.
 *
 * `Notifier` is ADR M0.3 §4's own case: `notifier-email` and `notifier-webhook`
 * are two delivery channels behind one context port, and that is the design.
 * Every other port has exactly one home, and `selfCheck` fails both ways — an
 * unlisted port with two homes, and a listed port that has stopped having two.
 */
export const MULTI_HOME_PORTS = ["cost-monitoring:Notifier"];

export const TRANSPORTS = ["rest", "mcp", "ws", "webhook", "channels-ingress", "bff"];

const KERNEL_PORTS = [
  "EventBus", "OutboxWriter", "UnitOfWork", "Clock", "IdGenerator", "Logger",
  "DurableRuntime", "SafetyEventSink", "ErasureTarget",
];

export const OWNED_ROOTS = ["packages/kernel", "packages/contexts", "packages/adapters", "apps/core-api", "apps/mcp-stdio"];
export const ROOT_SOLUTION_PATH = "tsconfig.json";
export const EXPECTED_PROJECT_COUNT = 32;
// 94 -> 95 (WIN-297): apps/core-api -> packages/kernel. The composition root
// binds twelve adapters to the ports they implement and three of those ports
// (OutboxWriter, DurableRuntime, EventBus) are kernel-hosted, so without this
// edge a quarter of its one job cannot be typed. It is also the only project
// that can implement Clock, IdGenerator and Logger — kernel ports with no vendor
// SDK and therefore no adapter of their own. The kernel is a leaf (rule (f)), so
// this edge cannot create a cycle, and the 17-context DAG is unchanged. The
// independent expectation in scripts/arch/v1-project-graph.mjs carries the same
// delta and is maintained separately on purpose.
// 95 -> 96 (WIN-258 T2, ADR M0.3 §15). `packages/adapters/postgres-tenancy` ->
// `packages/contexts/identity-access`. The directory satisfies that context's
// `IdentityAccessRepository` as well as tenancy's `TenancyRepository`, so it
// names both contexts' port types and needs both project references. The edge
// cannot create a cycle: contexts are leaves relative to adapters, and
// `tenancy` already depends on `identity-access`, so the 17-context DAG is
// untouched. The independent expectation in scripts/arch/v1-project-graph.mjs
// carries the same delta and is maintained separately on purpose.
// 96 -> 97 (WIN-258 T5, ADR M0.3 s15). `packages/adapters/postgres-tenancy` ->
// `packages/contexts/tools`. A THIRD owner edge out of the one directory, for
// the third context whose canonical rows live in the one PostgreSQL database.
// It cannot create a cycle for the same reason the second could not: contexts
// are leaves relative to adapters, and nothing in `tools` names an adapter. The
// 17-context DAG is untouched -- `tools` depends on `tenancy`,
// `identity-access`, `secrets` and `providers`, and this edge adds none of
// those. The independent expectation in scripts/arch/v1-project-graph.mjs
// carries the same delta and is maintained separately on purpose.
//
// 97 -> 98 (WIN-258 T5, the same amendment again). `packages/adapters/postgres-tenancy`
// -> `packages/contexts/agents`. A FOURTH owner edge out of the one directory,
// carrying that context's TWO canonical-store ports: the seven rows of §1 row 5
// are in the one PostgreSQL database, behind the one client, so their
// repositories are in the one adapter directory. Two bindings, one edge — a
// project reference is per PACKAGE, not per port. It cannot create a cycle, and
// it does not widen the 17-context DAG.
//
// 98 -> 99 (WIN-258 T5, a third time). `packages/adapters/postgres-tenancy` ->
// `packages/contexts/cost-monitoring`. A FIFTH owner edge, for that context's
// `BudgetRepository`. `cost-monitoring` depends on `tenancy` and `providers`
// and nothing depends on it, so the 17-context DAG is again unchanged and no
// cycle is possible.
//
// 99 -> 103 (WIN-258 T5, four tranches of this wave landed together).
// `packages/adapters/postgres-tenancy` -> `packages/contexts/skills` is the
// fourth, carrying ONE binding. `skills` depends on `tenancy` and `files` and
// nothing depends on it from an adapter, so the 17-context DAG is again
// unchanged and no cycle is possible.
// `packages/adapters/postgres-tenancy` -> `packages/contexts/channels`, ->
// `packages/contexts/governance` and -> `packages/contexts/secrets`. THREE owner
// edges carrying EIGHT bindings — one, five and two — because a project
// reference is per PACKAGE, not per port; that is the same one-edge-many-bindings
// shape `agents` introduced at two. None can create a cycle: contexts are leaves
// relative to adapters, and the 17-context DAG is untouched — `channels` depends
// on `tenancy` and `identity-access`, `governance` on `tenancy` and `agents`,
// and `secrets` on the kernel alone, with `tools`, `providers` and
// `conversations` already depending on `secrets`. The independent expectation in
// scripts/arch/v1-project-graph.mjs carries the same delta and is maintained
// separately on purpose.
//
// 102 -> 106 (WIN-258 T5, a NINTH, a TENTH, an ELEVENTH and a TWELFTH owner).
// `packages/adapters/postgres-tenancy` -> `packages/contexts/providers`, for that
// context's `ProvidersRepository` over the four rows of §1 row 4: ONE edge
// carrying ONE binding, because `providers` publishes a single canonical-store
// port over all four and its other two ports belong elsewhere — `ModelRouter` to
// `model-router-providers` and `ProviderProbeCache` to no adapter at all. And
// `packages/adapters/postgres-tenancy` -> `packages/contexts/conversations`: ONE
// edge carrying FOUR bindings, because a project reference is per PACKAGE and not
// per port — the same one-edge-many-bindings shape `agents` introduced at two and
// `governance` at five. And -> `packages/contexts/skills`: ONE edge carrying
// ONE binding, on the same rule, because `SkillsRepository` is one port over
// three tables.
//
// NONE CAN CREATE A CYCLE, and on the first that needed checking rather than
// asserting: `providers` DEPENDS on `secrets`, which is already an owner of the
// same directory. A cycle would need `secrets` to depend on `providers`, and the
// §1 DAG has it depending on the kernel alone — so the two owner edges are
// parallel rather than circular. `conversations` is the DAG's sink: it depends on
// eleven contexts and nothing depends on it. `skills` depends on `tenancy` and
// `files` and `agents` depends on `skills`, all of which the DAG already
// carries, and an adapter is a leaf of it. The 17-context DAG is untouched by
// all three.
//
// AND `packages/adapters/postgres-tenancy`
// -> `packages/contexts/memory`. A TWELFTH owner edge, carrying that context's TWO
// canonical-store ports — one edge, two bindings, because a project reference is
// per PACKAGE and not per port. It cannot create a cycle: contexts are leaves
// relative to adapters, `memory` depends on `tenancy` and `providers`, and
// nothing in the 17-context DAG depends on `memory`. The independent expectation
// in scripts/arch/v1-project-graph.mjs carries the same delta and is maintained
// separately on purpose.
export const EXPECTED_EDGE_COUNT = 106;

// The three per-project files that make up the SCAFFOLDING tier. Adoption never
// releases these: a project's manifest, its tsconfig (which carries the project
// references that ARE the 94-edge DAG) and its README stay generated forever.
export const SCAFFOLDING_BASENAMES = ["package.json", "tsconfig.json", "README.md"];

// Scaffolding is invariant for the life of the V1 layout:
// 32 projects x 3 files + the root solution tsconfig.
export const EXPECTED_SCAFFOLDING_FILE_COUNT = 97;

// Declaration-only source placeholders in a fully unadopted skeleton:
// kernel 3 + contexts 17x4 + adapters 12x2 + core-api 8 + mcp-stdio 1.
// This is the same 104-file set the architecture gate scans.
export const EXPECTED_PLACEHOLDER_FILE_COUNT = 104;

// ---------------------------------------------------------------------------
// ADOPTED PROJECTS (WIN-256). Append-only, one project path per entry, each with
// the issue that adopted it.
//
// Adopting a project means: real implementation code now owns its source tree.
// The generator stops emitting that project's source placeholders and `--check`
// stops reporting files under its source tree as EXTRA. Its scaffolding is still
// byte-compared, and boundary-rules.mjs still polices every file that lands there.
//
// DO NOT REMOVE AN ENTRY to make a failure go away. Un-adopting a project whose
// real files are still on disk fails closed by construction (MISSING placeholders
// + EXTRA real files), and `gen-v1-skeleton.test.mjs` asserts exactly that.
// ---------------------------------------------------------------------------
export const ADOPTED_PROJECTS = [
  "packages/kernel", // WIN-256 — the nine decoupling ports and the value objects
  "packages/contexts/identity-access", // WIN-256 — the DAG leaf that kills the wrong-way auth edges
  "packages/contexts/tenancy", // WIN-256 — the org/project/environment tree and its authorization
  "packages/contexts/secrets", // WIN-256 — the credential vault and the encryption boundary
  "packages/contexts/files", // WIN-256 — attachments + artifacts, and the ObjectStore port it owns
  "packages/contexts/providers", // WIN-256 — provider keys, the model catalogue, rate cards, and the ModelRouter port it owns
  "packages/contexts/eventing", // WIN-256 — the outbox drain, NotificationRule, and NotificationRequested
  "packages/contexts/skills", // WIN-256 — the skill catalogue, its install pair, and the manifest parser
  "packages/contexts/jobs", // WIN-256 — Job definitions and the AgentApproval suspension seam
  "packages/contexts/memory", // WIN-256 — memories, the knowledge graph, extraction, and the Cache port it owns
  "packages/contexts/cost-monitoring", // WIN-256 — budgets, the spend ledger, threshold alerting, and the Notifier port it owns
  "packages/contexts/privacy", // WIN-256 — right-to-erasure orchestration over the kernel ErasureTarget[]
  "packages/contexts/observability", // WIN-256 — the analytical projection, the drain, and the AdminAudit trail
  "packages/contexts/agents", // WIN-256 — agent definitions, immutable versions, bindings and the canary split, clusters, skill loadout, macros and saved requests
  "packages/contexts/tools", // WIN-256 — the tool-gateway/mcp-platform merge: the registry, the four-tier gate, and the ToolDispatch port it owns
  "packages/contexts/channels", // WIN-256 — hosted channels, the inbox lease, the refresh fence, and the ChannelAdapter port it owns
  "packages/contexts/governance", // WIN-256 — the safety ledger and the kernel SafetyEventSink behind it, message ratings, eval criteria, judged evals and golden sets
  "packages/contexts/conversations", // WIN-256 — the turn-execution engine: Thread, Turn, Step, PostmanExecution, and the DAG sink nothing imports
  "packages/adapters/model-router-providers", // WIN-256 — the ModelRouter implementation and THE sole holder of the inference SDK
  "packages/adapters/postgres-tenancy", // WIN-258 — the TenancyRepository over PostgreSQL and THE sole holder of the tenancy-database client
  "packages/adapters/outbox", // WIN-258 T4 — the kernel OutboxWriter: the envelope, the ordered identifier, every refusal, and the store seam the one ORM home implements
  "apps/core-api", // WIN-297 — the bootable process and THE composition root
  "apps/mcp-stdio", // WIN-297 — the thin stdio binary and its host-injected runtime seam
];

// ---------------------------------------------------------------------------
// CONTEXTS THAT PUBLISH THEIR USE CASES (WIN-257). Append-only, one project path
// per entry, each with the issue that needed it.
//
// A context manifest publishes two subpaths by default: `.` (its contracts) and
// `./application/ports/index.js` (its driven ports). Both are types. The factory
// that BUILDS the context — `createIdentityAccessService`, `createTenancyService`
// — lives in `application/index.js`, which was not published, so the composition
// root could name every context contract and construct none of them. WIN-297
// recorded that as a finding and deliberately did not fix it, on the grounds
// that publishing an entry point nothing imports is dead surface.
//
// So the list is not "every adopted context": it is the contexts `apps/core-api`
// ACTUALLY composes. An entry here without a matching import in the composition
// root is exactly the dead surface WIN-297 declined to create, and every entry
// must be an adopted project — `selfCheck` fails otherwise, because an
// unadopted project's source tree is generated placeholders and its
// `application/index.ts` would be one too.
// ---------------------------------------------------------------------------
export const APPLICATION_ENTRY_PROJECTS = [
  "packages/contexts/identity-access", // WIN-257 — composed by apps/core-api as the identity/session owner
  "packages/contexts/tenancy", // WIN-257 — composed by apps/core-api as the tenant-tree and authorization owner
  // WIN-258 T5 — imported by `packages/adapters/postgres-tenancy`, not by
  // apps/core-api, and that WIDENS the rule stated above rather than breaking
  // it. The list is "the contexts whose `application/index.js` a V1 project
  // actually imports"; the composition root was simply the only importer there
  // had ever been. `agents` publishes its in-memory `AgentsRepository` and
  // `ScaffoldingRepository` from there as the contract fixtures the adapter is
  // measured against, and the adapter's conformance differential runs ONE
  // scenario through the double and through PostgreSQL and compares the two
  // observation lists. Without this entry that differential cannot name the
  // doubles, and the claim in their own headers — "it enforces what the store
  // enforces" — is unchecked.
  "packages/contexts/agents",
  // WIN-258 T5 — imported by `packages/adapters/postgres-tenancy` for the same
  // reason `agents` is, and it is the same fact about where a context keeps its
  // doubles rather than a second rule. `secrets` publishes `inMemorySecretsStore`
  // from `application/index.js` — its own header says the doubles "ship with the
  // package on purpose" — and that store is the fake half of this tranche's
  // conformance differential: ONE scenario, asked of the double and of
  // PostgreSQL, with the two observation maps compared verbatim. Without this
  // entry the differential cannot name the double at all, and the only
  // alternative — a second double living in the adapter — would measure the
  // adapter against a copy of itself.
  "packages/contexts/secrets",
  // WIN-258 T5 — imported by `packages/adapters/postgres-tenancy` for the third
  // time and for the same fact about where a context keeps its doubles.
  // `skills` publishes `InMemorySkillsRepository` from `application/index.js`,
  // and that double's own header says it "is a REAL implementation of the port's
  // contract" which "enforces the two properties a Postgres implementation would
  // enforce with constraints". That is a claim about THIS adapter, so this
  // adapter is what checks it: ONE conformance scenario, asked of the double and
  // of PostgreSQL, with the two observation maps compared verbatim. Without this
  // entry the differential cannot name the double at all, and the only
  // alternative — a second double living in the adapter — would measure the
  // adapter against a copy of itself.
  "packages/contexts/skills",
];

// ---------------------------------------------------------------------------
// CONTEXTS THAT PUBLISH THEIR IN-MEMORY DOUBLES (WIN-258 T5). Append-only, one
// project path per entry, each with the issue that needed it.
//
// A SECOND LIST RATHER THAN A SECOND USE OF THE ONE ABOVE, because the two
// publish different things for different readers and the honesty check that
// keeps each list true is a different check. `APPLICATION_ENTRY_PROJECTS`
// publishes the factory that BUILDS a context and is true when
// `apps/core-api/src/app.module.ts` imports it. This list publishes
// `application/testing/index.js` — the in-memory doubles a context already
// writes for its own suites — and is true when a CANONICAL-STORE ADAPTER
// imports it.
//
// WHY AN ADAPTER NEEDS THEM. WIN-258's whole instrument is the conformance
// DIFFERENTIAL: one scenario, asked of the in-memory double and of the real
// PostgreSQL store, with the two observation maps compared verbatim. That is how
// tranche 2 found `operatorIdentities.upsert` keyed on the wrong unique index,
// and it is the only test shape that can find a divergence rather than assert an
// author's belief. `identity-access` and `tenancy` were reachable because they
// were already on the list above; `tools` was not, so the differential could not
// have been written for it at all.
//
// A double that cannot be reached from outside its own package is a double the
// adapter implementing its port cannot be compared against — which is the same
// dead-surface argument WIN-297 made, pointing the other way.
// ---------------------------------------------------------------------------
export const TESTING_ENTRY_PROJECTS = [
  "packages/contexts/tools", // WIN-258 T5 — compared against the PostgreSQL ToolsRepository by packages/adapters/postgres-tenancy
  "packages/contexts/cost-monitoring", // WIN-258 T5 — measured against InMemoryBudgetRepository by packages/adapters/postgres-tenancy
  "packages/contexts/channels", // WIN-258 T5 — measured against InMemoryChannelsRepository by packages/adapters/postgres-tenancy
  "packages/contexts/governance", // WIN-258 T5 — its FIVE doubles are the differential packages/adapters/postgres-tenancy is measured against
  "packages/contexts/providers", // WIN-258 T5 — measured against InMemoryProvidersRepository by packages/adapters/postgres-tenancy
  "packages/contexts/conversations", // WIN-258 T5 — InMemoryConversations satisfies all FOUR of its ports and is the differential
  "packages/contexts/memory", // WIN-258 T5 — InMemoryMemoryRepository and InMemoryKnowledgeGraphRepository are the differential packages/adapters/postgres-tenancy is measured against
];

// THREE TRANCHE-5 STORES NEEDED AN ENTRY AND EACH BRANCH ADDED THE LIST ITSELF,
// which merged as TWO declarations of the same constant — a duplicate the
// module loader rejects outright, and the one kind of silent merge damage that
// cannot ship. The entries are ONE list here, and a fourth branch adding the
// list again would reproduce exactly that. `agents` is absent on purpose: it
// publishes its doubles from `application/index.js`, so it is on
// APPLICATION_ENTRY_PROJECTS above instead.
//
// `providers` is the FOURTH, and it is the entry whose absence would have been
// hardest to see: `InMemoryProvidersRepository` is already published from
// `application/testing/index.js` FOR THE CONTEXTS DOWNSTREAM OF IT — its own
// header names `agents`, `tools`, `memory`, `cost-monitoring` and
// `conversations` — so the file existed, the export map did not, and the suite
// that needs it is in an adapter rather than in a context.
//
// `governance` is the third, and it needs the entry more than either: its
// conformance differential is measured against FIVE doubles at once —
// `InMemorySafetyLedger`, `InMemoryRatingsRepository`,
// `InMemoryCriteriaRepository`, `InMemoryEvalsRepository` and
// `InMemoryGoldenSetsRepository` — and without the subpath the adapter's suites
// do not fail an assertion, they fail to LOAD.
//
// Every entry must be an adopted project: an unadopted one's `application/`
// tree is generated placeholders, so `selfCheck` fails on it.

// Every entry point below takes an optional `adopted` override so the adoption
// path itself is exercisable. Production callers pass nothing and get
// ADOPTED_PROJECTS. An untestable adoption seam would be an unproven gate.
function adoptedSet(adopted = ADOPTED_PROJECTS) {
  return adopted instanceof Set ? adopted : new Set(adopted);
}

/** The project path that owns `path`, or null when no V1 project does. */
export function owningProject(path) {
  for (const project of projectPaths()) {
    if (path === project || path.startsWith(`${project}/`)) return project;
  }
  return null;
}

/** True when `path` is one of a project's three scaffolding files. */
export function isScaffoldingPath(path) {
  const project = owningProject(path);
  if (!project) return path === ROOT_SOLUTION_PATH;
  return SCAFFOLDING_BASENAMES.includes(path.slice(project.length + 1));
}

/** True when `path` sits in the released source tree of an adopted project. */
export function isAdoptedSourcePath(path, adopted) {
  const project = owningProject(path);
  if (!project || !adoptedSet(adopted).has(project)) return false;
  return !isScaffoldingPath(path);
}

/** Split a rendered file map into its two ownership tiers. */
export function tierCounts(files) {
  const scaffolding = [...files.keys()].filter((path) => isScaffoldingPath(path)).length;
  return { scaffolding, placeholders: files.size - scaffolding, total: files.size };
}

const HEADER = "// PLACEHOLDER — generated by scripts/arch/gen-v1-skeleton.mjs. Do not edit by hand.\n";
const BUILD_SCRIPTS = { build: "tsc -b", clean: "tsc -b --clean" };

// An adopted project holds real code, so it gets the scripts real code needs.
// Tests live beside the source they cover and are compiled by the project's own
// composite tsconfig, so they are typechecked under the same `strict` +
// `noUncheckedIndexedAccess` settings as the code — a test that only runs under
// esbuild is not holding the domain to the standard the domain is held to.
// These packages are `private`, so the emitted test JavaScript in dist/ is inert.
const ADOPTED_SCRIPTS = { ...BUILD_SCRIPTS, test: "vitest run" };

// An adopted APP is additionally a process, so it gets the one script that
// starts it. `start` runs the built entry point rather than a bundler or a
// watcher: the thing CI proves and the thing an operator runs must be the same
// artifact, or the executable start/stop evidence is about something that never
// ships (WIN-297).
const ADOPTED_APP_SCRIPTS = { ...ADOPTED_SCRIPTS, start: "node dist/main.js" };

// Projects whose adopted script set is the app set rather than the library set.
const APP_PROJECTS = new Set(["apps/core-api", "apps/mcp-stdio"]);

// Projects whose default test run must leave some of their suites out, and the
// run that leaves them out (WIN-258).
//
// `packages/adapters/postgres-tenancy` ships two real-PostgreSQL suites. They
// start a container, and `pnpm test:v1-packages` runs inside the typecheck job,
// which has no Docker daemon — the same reason `differential-state-conservation`
// is a job of its own. So the default run excludes them by FILENAME and a
// dedicated root script and CI job run them.
//
// It is a script and not a `vitest.config.ts` because
// `scripts/arch/v1-project-graph.mjs` requires every TypeScript file in a
// project to sit inside that project's tsconfig `include`, and a config file at
// the package root sits outside `src/**`. Moving it under `src/` would stop
// vitest discovering it. The three globs are spelled out rather than relying on
// the two defaults surviving a CLI override.
const PROJECT_TEST_SCRIPTS = {
  "packages/adapters/postgres-tenancy":
    "vitest run --exclude '**/node_modules/**' --exclude '**/dist/**' --exclude '**/*.integration.test.ts'",
};

function scriptsFor(project, adopted) {
  if (!adoptedSet(adopted).has(project)) return BUILD_SCRIPTS;
  const base = APP_PROJECTS.has(project) ? ADOPTED_APP_SCRIPTS : ADOPTED_SCRIPTS;
  const override = PROJECT_TEST_SCRIPTS[project];
  return override === undefined ? base : { ...base, test: override };
}

function pascal(name) {
  return name.split(/[-_]/u).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function camel(name) {
  return name.replace(/-(.)/gu, (_match, character) => character.toUpperCase());
}

function workspaceDependencies(names) {
  return Object.fromEntries(names.map((name) => [name, "workspace:*"]));
}

function packageManifest({ name, description, main, types, dependencies = {}, devDependencies = {}, exports = undefined, scripts = BUILD_SCRIPTS }) {
  const manifest = {
    name,
    version: "0.0.0",
    private: true,
    description,
    license: "Apache-2.0",
    type: "module",
    main,
    types,
    exports: exports ?? { ".": { types, import: main } },
    scripts,
  };
  if (Object.keys(dependencies).length) manifest.dependencies = dependencies;
  if (Object.keys(devDependencies).length) manifest.devDependencies = devDependencies;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function kernelManifest(adopted) {
  return packageManifest({
    scripts: scriptsFor("packages/kernel", adopted),
    name: "@platos/kernel",
    description: "Port interfaces and pure value objects. Zero runtime dependencies.",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
  });
}

function contextManifest(
  name,
  adopted,
  applicationEntries = APPLICATION_ENTRY_PROJECTS,
  testingEntries = TESTING_ENTRY_PROJECTS,
) {
  const dependencies = workspaceDependencies([
    "@platos/kernel",
    ...CONTEXT_DEPENDS_ON[name].map((dependency) => `@platos/context-${dependency}`),
  ]);
  const exports = {
    ".": { types: "./dist/contracts/index.d.ts", import: "./dist/contracts/index.js" },
    "./application/ports/index.js": {
      types: "./dist/application/ports/index.d.ts",
      import: "./dist/application/ports/index.js",
    },
  };
  if (applicationEntries.includes(`packages/contexts/${name}`)) {
    exports["./application/index.js"] = {
      types: "./dist/application/index.d.ts",
      import: "./dist/application/index.js",
    };
  }
  if (testingEntries.includes(`packages/contexts/${name}`)) {
    exports["./application/testing/index.js"] = {
      types: "./dist/application/testing/index.d.ts",
      import: "./dist/application/testing/index.js",
    };
  }
  return packageManifest({
    scripts: scriptsFor(`packages/contexts/${name}`, adopted),
    name: `@platos/context-${name}`,
    description: `ADR M0.3 bounded context: ${name}.`,
    main: "./dist/contracts/index.js",
    types: "./dist/contracts/index.d.ts",
    exports,
    dependencies,
  });
}

// The external runtime dependencies an adapter needs to BE the sole holder of
// its vendor client (WIN-256). They are declared HERE, in the generator, for the
// same reason apps/core-api's are: a project's manifest is SCAFFOLDING, adoption
// releases a project's source tree and never its package.json, so the only
// honest place to add a runtime dependency is the generator that owns the file.
//
// Specifiers are byte-identical to apps/agent's, so pnpm resolves them to the
// entries already in pnpm-lock.yaml instead of opening a new resolution. An
// adapter that forced a second copy of the inference framework into the lockfile
// would be a supply-chain change disguised as an extraction.
//
// `ai` and the four `@ai-sdk/*` bindings appear HERE and nowhere else:
// `inference-sdk-only` and `provider-sdk-only` in scripts/arch/boundary-rules.mjs
// name this one directory as their only home, and this table is what makes that
// permission real rather than theoretical. `ajv` is the JSON Schema validator the
// structured-output surface needs and `zod` is the framework's own peer.
const ADAPTER_RUNTIME_DEPENDENCIES = {
  // WIN-258. `@platos/tenancy-database` is the generated PostgreSQL client over
  // the canonical 93-model schema. It appears HERE and nowhere else, and
  // `tenancy-prisma-only` in scripts/arch/boundary-rules.mjs names this one
  // directory as its only home, so this table is what makes that permission real.
  // It is a workspace specifier rather than a version range because the client is
  // generated from a schema inside this repository; a range would pin a copy that
  // could disagree with the migrations the same commit ships.
  "postgres-tenancy": {
    "@platos/tenancy-database": "workspace:*",
  },
  "model-router-providers": {
    "@ai-sdk/anthropic": "^4.0.15",
    "@ai-sdk/google": "^4.0.16",
    "@ai-sdk/google-vertex": "^5.0.20",
    "@ai-sdk/openai": "^4.0.14",
    ai: "^7.0.28",
    ajv: "8.18.0",
    zod: "3.25.76",
  },
};

// What an adapter needs to TEST itself and must not ship with (WIN-258).
//
// `@testcontainers/postgresql` is the container harness the real-PostgreSQL
// integration suites start. It is declared as a DEV dependency because it is not
// part of the adapter at run time, and a container library in the runtime
// dependency set would follow the adapter into the production image and into the
// SBOM. The specifier is byte-identical to the one
// `internal-packages/tenancy-database` already uses for the same purpose, so it
// resolves to the entry already in pnpm-lock.yaml rather than opening a new
// resolution — the same rule ADAPTER_RUNTIME_DEPENDENCIES states above.
const ADAPTER_DEV_DEPENDENCIES = {
  "postgres-tenancy": {
    "@testcontainers/postgresql": "^10.28.0",
  },
};

/** "Implements the tenancy TenancyRepository port." — or both, when there are two. */
function describeAdapter(adapter) {
  const phrases = adapterBindings([adapter]).map(
    (binding) => `the ${binding.owner} ${binding.port} port`,
  );
  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  return `Implements ${list}.`;
}

/**
 * The adapter README.
 *
 * A directory with ONE binding reads exactly as it did before the §15
 * amendment. A directory with SEVERAL names each of them, and says which
 * sentence of ADR M0.3 §4 it is standing on, because "an adapter implements ONE
 * port" is the line a reader would otherwise measure it against and find it
 * wanting. The count is spelled from the bindings rather than written into the
 * sentence: this template said "TWO" while emitting three items the day
 * `cost-monitoring` was bound, which is the drift the whole file exists to stop.
 */
/**
 * The count, spelled.
 *
 * WIN-258 T5. This sentence used to read "Implements TWO owner-supplied ports"
 * with the word as a literal, which was true while two was the only value
 * `bindings.length > 1` could take. The day `postgres-tenancy` gained a third
 * binding the generated README said TWO and listed three, which is a
 * generator-owned file stating a number the generator itself could refute — the
 * exact failure `packages/**\/README.md` being generator-owned exists to
 * prevent. It is derived now.
 */
function countWord(count) {
  return (
    // WIN-258 T5 extended the list past TWELVE. Merged, this wave's three
    // canonical stores took the one shared directory to NINETEEN — `channels`'
    // one port, `governance`'s five and `secrets`' two on top of the eleven
    // already there — and the fallback would have rendered "Implements 19
    // owner-supplied ports" in a sentence whose other numbers are words: the
    // drift this helper was written to remove, arriving as a formatting
    // inconsistency instead of a wrong count.
    [
      "ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT",
      "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN",
      // WIN-258 T5 extended it again, and the fallback proved it needed to be:
      // `memory`'s two canonical stores took the shared directory to TWENTY-ONE,
      // one past the end of the list, and the README regenerated as "Implements
      // 21 owner-supplied ports" — the digit-in-a-sentence-of-words drift this
      // helper exists to remove, arriving exactly as the note above predicts.
      "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN", "TWENTY",
      "TWENTY-ONE", "TWENTY-TWO", "TWENTY-THREE", "TWENTY-FOUR", "TWENTY-FIVE",
    ][count] ?? String(count)
  );
}

function adapterReadme(adapter) {
  const bindings = adapterBindings([adapter]);
  const title = `# @platos/adapter-${adapter.dir}\n\n`;
  const trailer = `\n\nGenerated by \`scripts/arch/gen-v1-skeleton.mjs\`; M2 fills it in.\n`;
  if (bindings.length > 1) {
    const list = bindings.map((binding) => `- the ${binding.owner} \`${binding.port}\` port`).join("\n");
    return (
      `${title}Implements ${countWord(bindings.length)} owner-supplied ports — ${adapter.note}:\n\n${list}\n\n` +
      "ADR M0.3 §15 amendment: one vendor client is one adapter DIRECTORY, and a\n" +
      "directory may satisfy more than one port when the ports sit behind the same\n" +
      "client. §4's body already spells this directory \"per-context repositories,\n" +
      "owner-tagged\"; ownership is carried by the owner tag and enforced by\n" +
      "`CANONICAL_STORE_ADAPTERS`, not by the package boundary. It is still the sole\n" +
      "holder of its vendor client, only `apps/core-api` may import it\n" +
      "(`adapters-only-from-core`), and it may import no other adapter\n" +
      "(`adapter-is-self-contained`)." +
      trailer
    );
  }
  const only = bindings[0];
  if (only.owner === "kernel") {
    return (
      `${title}Implements the kernel \`${only.port}\` port — ${adapter.note}.\n\n` +
      "ADR M0.3 §4: an adapter implements ONE port and is the sole holder of its vendor\n" +
      "client. Only `apps/core-api` may import it (`adapters-only-from-core`), and it\n" +
      "may import no other adapter (`adapter-is-self-contained`)." +
      trailer
    );
  }
  return (
    `${title}Implements the ${only.owner} \`${only.port}\` port — ${adapter.note}.\n\n` +
    "ADR M0.3 §4/§13: an adapter implements ONE owner-supplied port and is the sole\n" +
    "holder of its vendor client. Only `apps/core-api` may import it, and it may\n" +
    "import no other adapter." +
    trailer
  );
}

function adapterManifest(adapter, adopted) {
  const isAdopted = adoptedSet(adopted).has(`packages/adapters/${adapter.dir}`);
  // One workspace dependency per DISTINCT owner it serves. A directory that
  // satisfies two contexts' ports needs both their type surfaces, and declaring
  // only the primary would leave the second binding resolving through a
  // transitive edge that nothing pins.
  const dependencies = adapterOwnerPackages(adapter);
  return packageManifest({
    scripts: scriptsFor(`packages/adapters/${adapter.dir}`, adopted),
    name: `@platos/adapter-${adapter.dir}`,
    description: describeAdapter(adapter),
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    dependencies: {
      ...workspaceDependencies(dependencies),
      ...(ADAPTER_RUNTIME_DEPENDENCIES[adapter.dir] ?? {}),
    },
    // An unadopted adapter has no source of its own, so it has nothing to test
    // and gets no test-only dependency.
    devDependencies: isAdopted ? (ADAPTER_DEV_DEPENDENCIES[adapter.dir] ?? {}) : {},
  });
}

// The external runtime dependencies apps/core-api needs to BE a process
// (WIN-297). They are declared here, in the generator, because a project's
// manifest is SCAFFOLDING: adoption releases a project's source tree and never
// its package.json, so the only honest place to add a runtime dependency is the
// generator that owns the file.
//
// Specifiers are byte-identical to apps/agent's, so pnpm resolves them to the
// entries already in pnpm-lock.yaml (@nestjs 11.1.18) instead of opening a new
// resolution. A composition root that forced a second major of the framework
// into the lockfile would be a supply-chain change disguised as a bootstrap.
//
// ADR M0.3 §4 names Nest as the composition-root framework. It appears HERE and
// in apps/core-api only: `no-infra-in-core` (rule (a)) keeps it out of every
// context's domain/ and application/, and WIN-297 adds the negative control that
// proves that rule can still fail.
const CORE_API_RUNTIME_DEPENDENCIES = {
  "@nestjs/common": "^11.0.0",
  "@nestjs/core": "^11.0.0",
  "@nestjs/platform-express": "^11.0.0",
  "reflect-metadata": "^0.2.2",
  rxjs: "^7.8.1",
};

function appManifest({ name, description, dependencies, scripts, externalDependencies = {} }) {
  return packageManifest({
    scripts,
    name,
    description,
    main: "./dist/main.js",
    types: "./dist/main.d.ts",
    dependencies: { ...workspaceDependencies(dependencies), ...externalDependencies },
  });
}

export function projectPaths() {
  return [
    "packages/kernel",
    ...CONTEXT_NAMES.map((name) => `packages/contexts/${name}`),
    ...ADAPTERS.map((adapter) => `packages/adapters/${adapter.dir}`),
    "apps/core-api",
    "apps/mcp-stdio",
  ];
}

export function projectReferences() {
  const references = new Map();
  references.set("packages/kernel", []);
  for (const name of CONTEXT_NAMES) {
    references.set(`packages/contexts/${name}`, [
      "packages/kernel",
      ...CONTEXT_DEPENDS_ON[name].map((dependency) => `packages/contexts/${dependency}`),
    ]);
  }
  for (const adapter of ADAPTERS) {
    references.set(`packages/adapters/${adapter.dir}`, adapterOwnerProjects(adapter));
  }
  references.set("apps/core-api", [
    "packages/kernel",
    ...CONTEXT_NAMES.map((name) => `packages/contexts/${name}`),
    ...ADAPTERS.map((adapter) => `packages/adapters/${adapter.dir}`),
  ]);
  references.set("apps/mcp-stdio", ["packages/contexts/tools"]);
  return references;
}

function relativeReference(fromProject, toProject) {
  const path = relative(fromProject, toProject).split("\\").join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

// apps/core-api hosts Nest, and Nest 11's dependency injection reads metadata
// that only the LEGACY decorator transform emits. `.configs/tsconfig.base.json`
// sets `experimentalDecorators: false` repository-wide, which selects the TC39
// standard decorators Nest does not support, so the composition root overrides
// both flags for its own project and nothing else.
//
// This is deliberately the narrowest possible blast radius: no context, no
// adapter and no other app can see these options, so `@nestjs/*` cannot become
// compilable inside a layer that ADR M0.3 §2 bans it from. Flipping them in the
// base config instead would have made the framework legal everywhere in order to
// make it legal in one place.
const PROJECT_COMPILER_OPTION_OVERRIDES = {
  "apps/core-api": { experimentalDecorators: true, emitDecoratorMetadata: true },
};

function projectTsconfig(project, include, references, rootDir) {
  const extendsPath = relative(project, ROOT_SOLUTION_PATH).split("\\").join("/");
  return `${JSON.stringify({
    extends: extendsPath,
    compilerOptions: {
      composite: true,
      declaration: true,
      declarationMap: true,
      rootDir,
      outDir: "dist",
      tsBuildInfoFile: "dist/.tsbuildinfo",
      ...(PROJECT_COMPILER_OPTION_OVERRIDES[project] ?? {}),
    },
    include,
    exclude: ["dist", "node_modules"],
    references: references.map((dependency) => ({ path: relativeReference(project, dependency) })),
  }, null, 2)}\n`;
}

function rootSolutionTsconfig() {
  return `${JSON.stringify({
    extends: "./.configs/tsconfig.base.json",
    files: [],
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@platos/kernel": ["packages/kernel/src/index.ts"],
        "@platos/kernel/*": ["packages/kernel/src/*"],
        "@platos/context-*": ["packages/contexts/*"],
        "@platos/adapter-*": ["packages/adapters/*"],
      },
    },
    references: projectPaths().map((path) => ({ path: `./${path}` })),
  }, null, 2)}\n`;
}

function contextAdapterPorts(name) {
  const ports = [];
  for (const adapter of ADAPTERS) {
    if (adapter.owner === name && adapter.port !== `${pascal(name)}Repository` && !ports.includes(adapter.port)) {
      ports.push(adapter.port);
    }
  }
  return ports;
}

export function renderSkeleton(
  adopted,
  applicationEntries = APPLICATION_ENTRY_PROJECTS,
  testingEntries = TESTING_ENTRY_PROJECTS,
) {
  const files = new Map();
  const references = projectReferences();
  const put = (path, text) => {
    if (files.has(path)) throw new Error(`duplicate emitted path ${path}`);
    // An adopted project's source tree belongs to real implementation code.
    // Its scaffolding still flows through unchanged.
    if (isAdoptedSourcePath(path, adopted)) return;
    files.set(path, text);
  };

  put(ROOT_SOLUTION_PATH, rootSolutionTsconfig());

  put("packages/kernel/package.json", kernelManifest(adopted));
  put("packages/kernel/tsconfig.json", projectTsconfig("packages/kernel", ["src/**/*.ts"], references.get("packages/kernel"), "src"));
  put(
    "packages/kernel/README.md",
    `# @platos/kernel\n\nADR M0.3 §4 \`packages/kernel\`: the ONLY cross-cutting package. It holds port\ninterfaces and pure value objects and nothing else — no service, no adapter, no\nvendor client, no business rule. \`kernel-is-leaf\` in\n\`scripts/arch/boundary-rules.mjs\` enforces that it imports no context, no\nadapter and no infrastructure client.\n\nGenerated by \`scripts/arch/gen-v1-skeleton.mjs\`; M2 fills it in.\n`
  );
  put("packages/kernel/src/index.ts", `${HEADER}export type * from "./ports/index.js";\nexport type * from "./vo/index.js";\n`);
  put(
    "packages/kernel/src/ports/index.ts",
    `${HEADER}// ADR M0.3 §4 kernel-hosted decoupling ports. Declarations only.\n` +
      KERNEL_PORTS.map((port) => `export interface ${port} {\n  readonly __port: "${port}";\n}\n`).join("\n")
  );
  put(
    "packages/kernel/src/vo/index.ts",
    `${HEADER}// ADR M0.3 §4 pure value objects. Declarations only.\n` +
      `export interface TenantScope {\n  readonly organizationId: string;\n}\n\n` +
      `export interface RequestScope {\n  readonly tenant: TenantScope;\n  readonly requestId: string;\n}\n\n` +
      `export interface Money {\n  readonly cents: number;\n  readonly currency: string;\n}\n\n` +
      `export interface DomainEvent {\n  readonly name: string;\n  readonly occurredAt: string;\n}\n`
  );

  for (const name of CONTEXT_NAMES) {
    const base = `packages/contexts/${name}`;
    const dependencies = CONTEXT_DEPENDS_ON[name];
    const Type = pascal(name);
    const adapterPorts = contextAdapterPorts(name);

    put(`${base}/package.json`, contextManifest(name, adopted, applicationEntries, testingEntries));
    put(`${base}/tsconfig.json`, projectTsconfig(base, ["domain/**/*.ts", "application/**/*.ts", "contracts/**/*.ts"], references.get(base), "."));
    put(
      `${base}/README.md`,
      `# @platos/context-${name}\n\nADR M0.3 bounded context. Layers: \`domain/\`, \`application/\`,\n\`application/ports/\`, \`contracts/\`. Other contexts may import \`contracts/\` and\nnothing else (\`cross-context-contracts-only\`).\n\nMay depend on: ${dependencies.length ? dependencies.join(", ") : "nothing (leaf)"}.\n\nGenerated by \`scripts/arch/gen-v1-skeleton.mjs\`; M2 fills it in.\n`
    );
    put(
      `${base}/domain/index.ts`,
      `${HEADER}// Pure domain. May import its own domain and @platos/kernel only.\n` +
        `import type { TenantScope } from "@platos/kernel";\n\n` +
        `export interface ${Type}Aggregate {\n  readonly scope: TenantScope;\n  readonly id: string;\n}\n`
    );
    put(
      `${base}/application/ports/index.ts`,
      `${HEADER}// Driven ports this context needs. Implemented by packages/adapters/*,\n` +
        `// wired in apps/core-api. Never imported by domain/.\n` +
        `import type { ${Type}Aggregate } from "../../domain/index.js";\n\n` +
        `export interface ${Type}Repository {\n  load(id: string): Promise<${Type}Aggregate | null>;\n}\n` +
        adapterPorts.map((port) => `\nexport interface ${port} {\n  readonly __port: "${port}";\n}\n`).join("")
    );
    put(
      `${base}/application/index.ts`,
      `${HEADER}// Use-cases. May import this context's domain and ports, and any allowed\n` +
        `// peer context's contracts/ (ADR M0.3 §1 domainDeps).\n` +
        `import type { ${Type}Repository } from "./ports/index.js";\n` +
        dependencies.map((dependency) => `import type { ${pascal(dependency)}Contract } from "@platos/context-${dependency}";`).join("\n") +
        (dependencies.length ? "\n" : "") +
        `\nexport interface ${Type}UseCases {\n  readonly repository: ${Type}Repository;\n` +
        dependencies.map((dependency) => `  readonly ${camel(dependency)}: ${pascal(dependency)}Contract;`).join("\n") +
        (dependencies.length ? "\n" : "") +
        `}\n`
    );
    put(
      `${base}/contracts/index.ts`,
      `${HEADER}// The ONLY surface other contexts and apps/core-api may import.\n` +
        `import type { ${Type}Aggregate } from "../domain/index.js";\n\n` +
        `export interface ${Type}Contract {\n  readonly name: "${name}";\n  describe(id: string): Promise<${Type}Aggregate | null>;\n}\n`
    );
  }

  for (const adapter of ADAPTERS) {
    const base = `packages/adapters/${adapter.dir}`;
    const Type = pascal(adapter.dir);
    const portModule = adapter.owner === "kernel"
      ? "@platos/kernel"
      : `@platos/context-${adapter.owner}/application/ports/index.js`;
    put(`${base}/package.json`, adapterManifest(adapter, adopted));
    put(`${base}/tsconfig.json`, projectTsconfig(base, ["src/**/*.ts"], references.get(base), "src"));
    put(`${base}/README.md`, adapterReadme(adapter));
    put(`${base}/src/index.ts`, `${HEADER}export type { ${Type}Adapter } from "./adapter.js";\n`);
    put(
      `${base}/src/adapter.ts`,
      `${HEADER}// The single ${adapter.port} implementation. The vendor client is imported\n` +
        `// HERE and nowhere else in the repository.\n` +
        `import type { ${adapter.port} } from "${portModule}";\n\n` +
        `export interface ${Type}Adapter extends ${adapter.port} {\n  readonly adapterName: "${adapter.dir}";\n}\n`
    );
  }

  const coreDependencies = [
    "@platos/kernel",
    ...CONTEXT_NAMES.map((name) => `@platos/context-${name}`),
    ...ADAPTERS.map((adapter) => `@platos/adapter-${adapter.dir}`),
  ];
  put("apps/core-api/package.json", appManifest({
    scripts: scriptsFor("apps/core-api", adopted),
    name: "@platos/core-api",
    description: "THE single V1 deployable: the composition root and every transport.",
    dependencies: coreDependencies,
    externalDependencies: CORE_API_RUNTIME_DEPENDENCIES,
  }));
  put("apps/core-api/tsconfig.json", projectTsconfig("apps/core-api", ["src/**/*.ts"], references.get("apps/core-api"), "src"));
  put(
    "apps/core-api/README.md",
    `# @platos/core-api\n\nADR M0.3 §4: THE single V1 deployable. It is the composition root — the ONLY\nplace that may import \`packages/adapters/*\` — and it hosts every transport.\nTransports are thin: they call context use-cases and hold no business rule.\n\nThis project's SOURCE tree is adopted (WIN-297): \`src/\` is hand-written, and\n\`scripts/arch/composition-root.mjs\` narrows \`adapters-only-from-core\` further,\nto the one composition module inside it. Its \`package.json\`, \`tsconfig.json\` and\nthis README stay generated by \`scripts/arch/gen-v1-skeleton.mjs\`.\n\nRun it with \`pnpm --filter @platos/core-api start\` after \`pnpm build:v1\`.\n`
  );
  // The source placeholders below are still rendered for an UNADOPTED
  // apps/core-api — `put()` drops them once the project is adopted. Deleting the
  // emitters instead of letting adoption release them would break the
  // EXPECTED_PLACEHOLDER_FILE_COUNT invariant and, worse, silently disarm the
  // monotonicity lock: un-adopting would then produce no MISSING placeholder to
  // fail on.
  put(
    "apps/core-api/src/main.ts",
    `${HEADER}// Process entry point. Boots the composition root and nothing else.\n` +
      `import type { AppModule } from "./app.module.js";\n\n` +
      `export type Bootstrap = () => Promise<AppModule>;\n`
  );
  put(
    "apps/core-api/src/app.module.ts",
    `${HEADER}// THE composition root: the one place adapters are bound to context ports.\n` +
      CONTEXT_NAMES.map((name) => `import type { ${pascal(name)}Contract } from "@platos/context-${name}";`).join("\n") +
      "\n" +
      ADAPTERS.map((adapter) => `import type { ${pascal(adapter.dir)}Adapter } from "@platos/adapter-${adapter.dir}";`).join("\n") +
      "\n\nexport interface AppModule {\n" +
      CONTEXT_NAMES.map((name) => `  readonly ${camel(name)}: ${pascal(name)}Contract;`).join("\n") +
      "\n" +
      ADAPTERS.map((adapter) => `  readonly ${camel(adapter.dir)}: ${pascal(adapter.dir)}Adapter;`).join("\n") +
      "\n}\n"
  );
  for (const transport of TRANSPORTS) {
    put(
      `apps/core-api/src/transports/${transport}/index.ts`,
      `${HEADER}// Thin ${transport} transport. Calls context use-cases only.\n` +
        `import type { AppModule } from "../../app.module.js";\n\n` +
        `export interface ${pascal(transport)}Transport {\n  readonly kind: "${transport}";\n  readonly app: AppModule;\n}\n`
    );
  }

  put("apps/mcp-stdio/package.json", appManifest({
    scripts: scriptsFor("apps/mcp-stdio", adopted),
    name: "@platos/mcp-stdio",
    description: "Thin stdio binary; reuses the tools context transport.",
    dependencies: ["@platos/context-tools"],
  }));
  put("apps/mcp-stdio/tsconfig.json", projectTsconfig("apps/mcp-stdio", ["src/**/*.ts"], references.get("apps/mcp-stdio"), "src"));
  put(
    "apps/mcp-stdio/README.md",
    `# @platos/mcp-stdio\n\nADR M0.3 §4: a thin stdio binary. It owns no business logic; it reuses the\n\`tools\` context transport surface published through that context's\n\`contracts/\`.\n\nThis project's SOURCE tree is adopted (WIN-297). It is a real process with a\nfail-closed startup, but it holds no adapter: \`adapters-only-from-core\`\n(rule (j)) names \`apps/core-api\` alone, so this binary receives its\n\`ToolsContract\` from a host-supplied runtime module and refuses to start\nwithout one. Its \`package.json\`, \`tsconfig.json\` and this README stay generated\nby \`scripts/arch/gen-v1-skeleton.mjs\`.\n`
  );
  put(
    "apps/mcp-stdio/src/main.ts",
    `${HEADER}// Stdio entry point. Reuses the tools context contract surface.\n` +
      `import type { ToolsContract } from "@platos/context-tools";\n\n` +
      `export type StdioBootstrap = () => Promise<ToolsContract>;\n`
  );

  return files;
}

/**
 * Everything the ADAPTERS table has to satisfy, over a table the caller SUPPLIES.
 *
 * Injectable so `gen-v1-skeleton.test.mjs` can hand it a mutated table and watch
 * each refusal happen, rather than editing the module and running the CLI. A
 * gate widened to permit many ports per directory has to be shown still refusing
 * everything it refused before, and a refusal nobody has watched fail is not
 * evidence.
 */
export function checkAdapterTable(adapters = ADAPTERS, contextNames = CONTEXT_NAMES) {
  const errors = [];

  // TWO pins, not one. Before the §15 amendment a single `ADAPTERS.length`
  // check said both "twelve directories" and "twelve bindings" at once, because
  // the two were the same number. They are no longer the same number and the
  // check is therefore split rather than loosened: a thirteenth DIRECTORY and a
  // fourteenth BINDING each fail on their own line, so widening one cannot
  // silently widen the other.
  if (adapters.length !== EXPECTED_ADAPTER_COUNT) {
    errors.push(
      `ADR M0.3 §4 names ${EXPECTED_ADAPTER_COUNT} concrete adapter directories; ADAPTERS has ${adapters.length}`,
    );
  }
  const bindings = adapterBindings(adapters);
  if (bindings.length !== EXPECTED_BINDING_COUNT) {
    errors.push(
      `ADR M0.3 §4/§15 declares ${EXPECTED_BINDING_COUNT} adapter bindings; ADAPTERS flattens to ${bindings.length}`,
    );
  }

  // Every BINDING's owner must be a real context or the kernel — the extra
  // bindings of a multi-port directory are held to exactly the check the
  // primary one always was, so a second binding cannot smuggle in an owner the
  // ADR does not name.
  for (const binding of bindings) {
    if (binding.owner !== "kernel" && !contextNames.includes(binding.owner)) {
      errors.push(`${binding.adapter} assigns ${binding.port} to unknown owner ${binding.owner}`);
    }
  }

  // A PORT is satisfied by at most one directory, and a directory declares a
  // port at most once. Without these two, "many ports per adapter" would also
  // permit the same port claimed twice — by one directory listing it in both
  // halves of its own entry, or by two directories both claiming it — and the
  // composition root's set comparison would then pass on an ambiguous binding.
  //
  // `Notifier` is the ONE port two directories legitimately satisfy
  // (`notifier-email` and `notifier-webhook`, ADR M0.3 §4), so the uniqueness
  // that binds is (owner, port, adapter) as a triple plus an explicit
  // allow-list of ports with more than one home. Nothing else may be shared.
  const seenBindings = new Set();
  const portHomes = new Map();
  for (const binding of bindings) {
    const key = `${binding.adapter}:${binding.owner}:${binding.port}`;
    if (seenBindings.has(key)) errors.push(`${binding.adapter} declares ${binding.port} more than once`);
    seenBindings.add(key);
    const homes = portHomes.get(`${binding.owner}:${binding.port}`) ?? [];
    homes.push(binding.adapter);
    portHomes.set(`${binding.owner}:${binding.port}`, homes);
  }
  for (const [port, homes] of portHomes) {
    if (homes.length > 1 && !MULTI_HOME_PORTS.includes(port)) {
      errors.push(`${port} is satisfied by ${homes.join(" and ")}; only ${MULTI_HOME_PORTS.join(", ")} may have more than one home`);
    }
  }
  for (const port of MULTI_HOME_PORTS) {
    const homes = portHomes.get(port) ?? [];
    if (homes.length < 2) {
      errors.push(`${port} is declared as a multi-home port but has ${homes.length} home(s); drop it from MULTI_HOME_PORTS`);
    }
  }
  return errors;
}

export function selfCheck(
  adopted = ADOPTED_PROJECTS,
  applicationEntries = APPLICATION_ENTRY_PROJECTS,
  testingEntries = TESTING_ENTRY_PROJECTS,
) {
  const errors = [];
  const adapterDirectories = new Set(ADAPTERS.map((adapter) => adapter.dir));
  const references = projectReferences();
  const edgeCount = [...references.values()].reduce((count, dependencies) => count + dependencies.length, 0);

  for (const sdk of SDK_CONTAINMENT) {
    const match = /\^packages\/adapters\/([^/]+)\//u.exec(sdk.home);
    if (match && !adapterDirectories.has(match[1])) {
      errors.push(`SDK_CONTAINMENT ${sdk.id} names packages/adapters/${match[1]}/, which the skeleton does not create`);
    }
  }
  if (CONTEXT_NAMES.length !== 17) errors.push(`ADR M0.3 §4 names 17 contexts; CONTEXT_DEPENDS_ON has ${CONTEXT_NAMES.length}`);
  errors.push(...checkAdapterTable());

  if (projectPaths().length !== EXPECTED_PROJECT_COUNT) errors.push(`V1 project count is ${projectPaths().length}, expected ${EXPECTED_PROJECT_COUNT}`);
  if (edgeCount !== EXPECTED_EDGE_COUNT) errors.push(`V1 project edge count is ${edgeCount}, expected ${EXPECTED_EDGE_COUNT}`);
  for (const name of CONTEXT_NAMES) {
    for (const dependency of CONTEXT_DEPENDS_ON[name]) {
      if (!CONTEXT_NAMES.includes(dependency)) errors.push(`${name} depends on unknown context ${dependency}`);
    }
  }

  // The adoption registry may name only real V1 projects, and may name each once.
  const knownProjects = new Set(projectPaths());
  const seenAdoptions = new Set();
  for (const project of adopted) {
    if (!knownProjects.has(project)) errors.push(`ADOPTED_PROJECTS names ${project}, which is not a V1 project`);
    if (seenAdoptions.has(project)) errors.push(`ADOPTED_PROJECTS names ${project} more than once`);
    seenAdoptions.add(project);
  }

  // A context may publish its use cases only if it is a context AND is adopted.
  // An unadopted project's whole source tree is generated placeholders, so its
  // `application/index.ts` would be one too, and the export would name a file
  // nothing wrote.
  const seenEntries = new Set();
  for (const project of applicationEntries) {
    if (!project.startsWith("packages/contexts/")) {
      errors.push(`APPLICATION_ENTRY_PROJECTS names ${project}, which is not a context`);
    } else if (!knownProjects.has(project)) {
      errors.push(`APPLICATION_ENTRY_PROJECTS names ${project}, which is not a V1 project`);
    }
    if (!seenAdoptions.has(project)) {
      errors.push(`APPLICATION_ENTRY_PROJECTS names ${project}, which is not adopted`);
    }
    if (seenEntries.has(project)) {
      errors.push(`APPLICATION_ENTRY_PROJECTS names ${project} more than once`);
    }
    seenEntries.add(project);
  }

  // The same three rules for the doubles barrel, judged separately rather than
  // folded into the loop above: the two lists answer different questions — one
  // publishes a context's use cases to the composition root, the other publishes
  // its in-memory doubles to the adapter measured against them — and a shared
  // loop would report a mistake in either under the other's name.
  const seenTestingEntries = new Set();
  for (const project of testingEntries) {
    if (!project.startsWith("packages/contexts/")) {
      errors.push(`TESTING_ENTRY_PROJECTS names ${project}, which is not a context`);
    } else if (!knownProjects.has(project)) {
      errors.push(`TESTING_ENTRY_PROJECTS names ${project}, which is not a V1 project`);
    }
    if (!seenAdoptions.has(project)) {
      errors.push(`TESTING_ENTRY_PROJECTS names ${project}, which is not adopted`);
    }
    if (seenTestingEntries.has(project)) {
      errors.push(`TESTING_ENTRY_PROJECTS names ${project} more than once`);
    }
    seenTestingEntries.add(project);
  }

  // The two tiers must still account for the whole skeleton. Scaffolding is
  // invariant; placeholders shrink by exactly what adoption released.
  const { scaffolding, placeholders } = tierCounts(
    renderSkeleton(adopted, applicationEntries, testingEntries),
  );
  if (scaffolding !== EXPECTED_SCAFFOLDING_FILE_COUNT) {
    errors.push(`scaffolding file count is ${scaffolding}, expected ${EXPECTED_SCAFFOLDING_FILE_COUNT}`);
  }
  if (placeholders > EXPECTED_PLACEHOLDER_FILE_COUNT) {
    errors.push(`placeholder file count is ${placeholders}, which exceeds the unadopted maximum ${EXPECTED_PLACEHOLDER_FILE_COUNT}`);
  }
  return errors;
}

// Build output, never source. `.turbo` joins `dist` and `node_modules` here:
// all three are gitignored artifacts, and without `.turbo` a plain
// `turbo run build` leaves a turbo-build.log in every project and `--check`
// reports 30 phantom EXTRA files (WIN-256 finding; pre-existing since M1).
const ARTIFACT_DIRECTORIES = ["dist", "node_modules", ".turbo"];

export function listExistingOwnedFiles(root) {
  const found = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && ARTIFACT_DIRECTORIES.includes(entry.name)) continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (!entry.name.endsWith(".tsbuildinfo")) found.push(relative(root, child).split("\\").join("/"));
    }
  };
  for (const owned of OWNED_ROOTS) {
    const absolute = join(root, owned);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) walk(absolute);
  }
  if (existsSync(join(root, ROOT_SOLUTION_PATH))) found.push(ROOT_SOLUTION_PATH);
  return found.sort();
}

export function checkSkeleton(root = repositoryRoot, adopted) {
  const problems = [];
  const files = renderSkeleton(adopted);
  for (const [path, text] of files) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) problems.push(`MISSING ${path}`);
    else if (readFileSync(absolute, "utf8") !== text) problems.push(`STALE   ${path}`);
  }
  for (const path of listExistingOwnedFiles(root)) {
    if (files.has(path) || isAdoptedSourcePath(path, adopted)) continue;
    problems.push(`EXTRA   ${path}`);
  }
  return problems;
}

export function writeSkeleton(root = repositoryRoot, adopted) {
  const files = renderSkeleton(adopted);
  for (const [path, text] of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  }
  return files;
}

function main() {
  const root = repositoryRoot;
  const check = process.argv.includes("--check");
  const list = process.argv.includes("--list");

  const selfErrors = selfCheck();
  if (selfErrors.length) {
    for (const error of selfErrors) process.stderr.write(`FAIL ${error}\n`);
    process.exitCode = 1;
    return;
  }

  const files = renderSkeleton();
  const { scaffolding, placeholders } = tierCounts(files);
  const tiers =
    `${scaffolding} scaffolding + ${placeholders} placeholder = ${files.size} generated file(s)` +
    ` for ${EXPECTED_PROJECT_COUNT} V1 projects and ${EXPECTED_EDGE_COUNT} project edges` +
    ` (${ADOPTED_PROJECTS.length} project(s) adopted, ${EXPECTED_PLACEHOLDER_FILE_COUNT - placeholders} placeholder(s) released)`;

  if (list) {
    for (const path of [...files.keys()].sort()) process.stdout.write(`${path}\n`);
    return;
  }

  if (check) {
    const problems = checkSkeleton(root);
    if (problems.length) {
      for (const problem of problems) process.stdout.write(`${problem}\n`);
      process.stdout.write(`\n${problems.length} generated drift(s). Run: node scripts/arch/gen-v1-skeleton.mjs\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`ok: ${tiers}\n`);
    return;
  }

  writeSkeleton(root);
  process.stdout.write(`wrote ${tiers}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("gen-v1-skeleton.mjs")) main();
