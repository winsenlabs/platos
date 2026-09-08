// WIN-267 T3 — what an install actually wires, and what readiness says about it.
//
// The suite that stops `/readyz` being 0/49 by construction. Every case here
// drives the REAL `constructAdapters`, which opens a real Prisma client and a
// real ioredis socket; none of them needs a server to be listening, because the
// question is what the composition root BUILT, not what the server answered.
//
// THE HOSTS ARE UNROUTABLE ON PURPOSE. `redis://127.0.0.1:1` refuses instantly
// and `db.internal` does not resolve, so these cases also exercise the path an
// operator hits when a store is down at boot — which is the path that used to
// kill the process, and which two of the cases below now pin.

import { afterEach, describe, expect, it } from "vitest";

import { composeApplication } from "../app.module.js";
import { loadPlatformConfiguration } from "../config/platform.js";
import { evaluateReadiness } from "../health/readiness.js";
import { PLATFORM_SECTIONS } from "../config/platform.js";
import { createProcessDefaults } from "../runtime/lifecycle.js";
import {
  ADAPTER_BINDINGS,
  UNIMPLEMENTED_ADAPTERS,
  constructAdapters,
  type AdapterConstruction,
  type AdapterName,
} from "./adapter-bindings.js";
import { IDENTITY_ACCESS_UNASSEMBLED, assembleContextPorts } from "./context-ports.js";

/**
 * A platform an install could really set, with every group this tranche can
 * construct declared.
 *
 * The four ClickHouse/object-store/channel/durable groups are deliberately NOT
 * here: their directories have no constructor, so declaring them would prove
 * nothing and would only make the case read as though it had.
 */
const FULLY_DECLARED = Object.freeze({
  PLATOS_ENVIRONMENT: "test",
  PLATOS_CORE_API_PORT: "0",
  PLATOS_STORE_POSTGRES_URL: "postgresql://platos:password-here@db.internal:5432/platos_control",
  PLATOS_STORE_REDIS_URL: "redis://127.0.0.1:1",
  PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
  PLATOS_SECURITY_ENCRYPTION_KEY: "b".repeat(64),
  PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "3",
});

/** Nothing wired at all — the install part-way through setup that must boot. */
const NOTHING_DECLARED = Object.freeze({ PLATOS_ENVIRONMENT: "test", PLATOS_CORE_API_PORT: "0" });

/**
 * Which adapter DIRECTORY each declared configuration group is supposed to
 * produce, spelled out here rather than read off the thing under test.
 *
 * THIS IS THE JOIN THAT MAKES THE SUITE FALSIFIABLE. Deriving the expectation
 * from `construction.adapters` would compare `constructAdapters` to itself and
 * could not fail — the mistake this programme has already paid for once. The
 * left-hand side is the CONFIGURATION CONTRACT (`section.group`, checked below
 * against `PLATFORM_SECTIONS`, which `constructAdapters` does not own) and the
 * right-hand side is the directory ADR M0.3 §4 says that store belongs to. Drop
 * `postgres-tenancy` from the constructor and this table still says a declared
 * `stores.postgres` must produce one.
 */
const GROUP_BUILDS: Readonly<Record<string, AdapterName>> = Object.freeze({
  "stores.postgres": "postgres-tenancy",
  "stores.redis": "redis-cache",
  "security.encryption": "keyring-envelope",
  "providers.modelRouter": "model-router-providers",
});

/**
 * The one directory NO group declares, and the one that is built from another
 * adapter instead of from configuration. ADR M0.3 §15 gives the ORM one home, so
 * the canonical `Event` row is written through `postgres-tenancy`.
 */
const BUILT_FROM_ANOTHER_ADAPTER: Readonly<Record<string, AdapterName>> = Object.freeze({
  outbox: "postgres-tenancy",
});

/**
 * The directories built from NOTHING — no group, no other adapter.
 *
 * WIN-267 A1 creates this category and `node-crypto-digest` is its only member.
 * It reads no configuration because there is none to read: a SHA-256 has no key,
 * no endpoint and no connection, so there is no state an operator could set
 * wrongly and none they could forget. Naming it here rather than letting it fall
 * out of `constructAdapters` is what makes "it is always wired" a claim this
 * suite checks in both directions — it must be absent from `unwired` in EVERY
 * configuration, including the one where nothing at all is declared.
 */
const BUILT_UNCONDITIONALLY: readonly AdapterName[] = Object.freeze(["node-crypto-digest"]);

const opened: AdapterConstruction[] = [];

afterEach(async () => {
  // Every construction releases, or a refused ioredis socket keeps its reconnect
  // timer and the runner never exits. That is not incidental tidiness: it is the
  // property `release()` exists for, exercised on every case rather than in one.
  for (const construction of opened.splice(0)) await construction.release();
});

function platform(env: Readonly<Record<string, string>>) {
  const outcome = loadPlatformConfiguration(env);
  if (!outcome.ok) {
    throw new Error(`fixture platform must be valid: ${outcome.diagnostics.map((d) => d.field).join(", ")}`);
  }
  return outcome.value;
}

function construct(env: Readonly<Record<string, string>>): AdapterConstruction {
  const value = platform(env);
  const defaults = createProcessDefaults(value.core);
  const construction = constructAdapters({
    stores: value.stores,
    security: value.security,
    providers: value.providers,
    clock: defaults.clock,
    correlation: null,
  });
  opened.push(construction);
  return construction;
}

/** Compose and evaluate exactly as `main.ts` does, over a real construction. */
function readiness(env: Readonly<Record<string, string>>) {
  const value = platform(env);
  const defaults = createProcessDefaults(value.core);
  const construction = construct(env);
  const assembly = assembleContextPorts(construction.adapters, defaults);
  const app = composeApplication({
    configuration: value.core,
    clock: defaults.clock,
    ids: defaults.ids,
    logger: defaults.logger,
    adapters: construction.adapters,
    ports: assembly.ports,
    unwired: construction.unwired,
  });
  return { app, verdict: evaluateReadiness(app, { phase: "serving" }), construction, assembly };
}

describe("constructing the adapters an install declared", () => {
  it("builds the directory every declared configuration group configures", () => {
    const declared = platform(FULLY_DECLARED).declaredGroups;
    // The left-hand column is a claim about the CONFIGURATION CONTRACT, so it is
    // checked against that contract first. A group id nobody declares is a table
    // row that can never fail.
    expect([...declared].sort()).toEqual(Object.keys(GROUP_BUILDS).sort());

    const built = new Set(Object.keys(construct(FULLY_DECLARED).adapters));
    for (const [group, adapter] of Object.entries(GROUP_BUILDS)) {
      expect(built, `${group} is declared, so ${adapter} must be constructed`).toContain(adapter);
    }
  });

  it("declares every group id in that table, so none of its rows is unreachable", () => {
    // The other half of the join. `GROUP_BUILDS` is only worth anything if its
    // keys are real `section.group` identifiers; a typo would silently turn the
    // case above into an assertion about nothing.
    const real = new Set(
      PLATFORM_SECTIONS.flatMap((section) => section.groups.map((group) => `${section.id}.${group.id}`)),
    );
    for (const group of Object.keys(GROUP_BUILDS)) expect(real).toContain(group);
  });

  it("leaves the outbox unbuilt when there is no database, because the ORM has one home", () => {
    // ADR M0.3 §15: the canonical `Event` row is written through
    // `postgres-tenancy`, so the outbox is built OVER it rather than from a
    // group of its own. An install with no database gets neither, and the reason
    // says so instead of naming a variable that would not have helped.
    const withoutDatabase = construct({ ...NOTHING_DECLARED, PLATOS_STORE_REDIS_URL: "redis://127.0.0.1:1" });
    // `node-crypto-digest` is here beside `redis-cache` and is not a Redis
    // directory: it is the one built unconditionally, so it appears under every
    // configuration including this one.
    expect([...Object.keys(withoutDatabase.adapters)].sort()).toEqual(
      ["node-crypto-digest", "redis-cache"].sort(),
    );
    const declined = withoutDatabase.unwired.find((row) => row.adapter === "outbox");
    expect(declined?.cause).toBe("configuration");
    expect(declined?.reason).toContain(BUILT_FROM_ANOTHER_ADAPTER["outbox"]);

    // And it IS built the moment that one dependency exists — without which the
    // case above would pass on an outbox nothing could ever construct.
    expect(Object.keys(construct(FULLY_DECLARED).adapters)).toContain("outbox");
  });

  it("separates a directory an operator can wire from one nobody can", () => {
    const construction = construct(NOTHING_DECLARED);
    const byCause = new Map(construction.unwired.map((row) => [row.adapter, row.cause]));

    // Nothing is configured, so THIRTEEN OF THE FOURTEEN are unwired — and the
    // thirteen split by a reason that is not this file's opinion:
    // `UNIMPLEMENTED_ADAPTERS` is joined to the adapter packages' own source by
    // composition-root.mjs (C7). The fourteenth is `node-crypto-digest`, which
    // reads no configuration and is therefore wired even here; asserting its
    // ABSENCE from `unwired` is what makes "built unconditionally" falsifiable
    // rather than a comment.
    expect(construction.unwired).toHaveLength(13);
    for (const adapter of BUILT_UNCONDITIONALLY) {
      expect(byCause.get(adapter)).toBeUndefined();
      expect(construction.adapters[adapter]).toBeDefined();
    }
    for (const adapter of UNIMPLEMENTED_ADAPTERS) expect(byCause.get(adapter)).toBe("implementation");
    for (const adapter of Object.values(GROUP_BUILDS)) expect(byCause.get(adapter)).toBe("configuration");
    // An operator reading `/readyz` has to be able to act on the reason, so it
    // names the variable or the file and never a value.
    for (const row of construction.unwired) {
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.reason).toMatch(/PLATOS_[A-Z_]+|packages\/adapters\/|postgres-tenancy/u);
    }
  });

  it("refuses a root key ring that will not parse rather than degrading readiness", () => {
    // The key material was SUPPLIED and is unusable, so every credential in the
    // vault is unreadable and no restart changes that: `main.ts` answers EX_CONFIG
    // rather than serving a process whose vault cannot open.
    //
    // THE INPUT IS HAND-BUILT AND THAT IS THE FINDING. `constructAdapters` takes
    // the ASSEMBLED sections, so this case can hand it a `SecurityConfiguration`
    // the environment loader would never produce — and it has to, because NO
    // environment can reach this branch: `config/security.ts` already refuses
    // every ring `createRootKeyRing` would. Its anchor pins the key to
    // `[0-9a-fA-F]{64}` and its `requiredWithAnchor` version to 1..1000000, and
    // `constructAdapters` keys the ring BY the active version, so the parse has
    // nothing left to reject. The branch is here because the constructor returns
    // a `Result` and an unhandled error arm would be strictly worse than a
    // handled one — see `declaredUnfalsifiable` E01 in mutations-win267-t3.json,
    // which measures that claim rather than asserting it.
    const construction = constructAdapters({
      stores: platform(NOTHING_DECLARED).stores,
      security: { session: null, encryption: { rootKey: "not-hexadecimal", rootKeyVersion: 3 } },
      providers: platform(NOTHING_DECLARED).providers,
      clock: createProcessDefaults(platform(NOTHING_DECLARED).core).clock,
      correlation: null,
    });
    opened.push(construction);
    expect(construction.faults).toHaveLength(1);
    expect(construction.faults[0]).toContain("keyring-envelope");
    expect(construction.faults[0]).toContain("INVALID_KEY_RING");
    expect(construction.adapters["keyring-envelope"]).toBeUndefined();
    // A FAULT IS NOT AN OMISSION. The group was declared, so it must not ALSO be
    // reported as something an operator forgot to set: the two have opposite
    // responses and `/readyz` must not offer the wrong one.
    expect(construction.unwired.map((row) => row.adapter)).not.toContain("keyring-envelope");
  });

  it("survives a store that is unreachable at construction, and releases it", async () => {
    // BOTH HALVES OF THE DEFECT WIRING THIS ADAPTER EXPOSED. `createRedisConnection`
    // rejects its readiness promise on a server it cannot reach; with nobody
    // constructing the adapter that rejection had never been raised, and once
    // `main.ts` began constructing it, Node killed the process on the unhandled
    // rejection — before any caller could turn it into MEMORY_CACHE_UNAVAILABLE.
    // Then `close()` could not send QUIT down a stream that was never writable,
    // so it threw and left the reconnect timer running.
    const rejections: unknown[] = [];
    const watch = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", watch);
    try {
      const construction = constructAdapters({
        stores: platform(FULLY_DECLARED).stores,
        security: platform(NOTHING_DECLARED).security,
        providers: platform(NOTHING_DECLARED).providers,
        clock: createProcessDefaults(platform(NOTHING_DECLARED).core).clock,
        correlation: null,
      });
      expect(construction.adapters["redis-cache"]).toBeDefined();
      // Long enough for the refused connection to have produced its error event.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(construction.release()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", watch);
    }
  });
});

describe("readiness over what was actually constructed", () => {
  it("counts the satisfied bindings off the declared table, so the figure moves with what is wired", () => {
    // WHAT THIS CASE GUARDS, STATED EXACTLY, because the sweep corrected a
    // sentence that used to stand here. It claimed "drop any directory from
    // `constructAdapters` and the two sides disagree", and T01 proved that
    // FALSE: both sides read `construction.adapters`, so dropping a directory
    // moves them together and this case stays green.
    //
    // What it does guard is the ARITHMETIC BETWEEN the supply and the report —
    // that `reportAdapterSupply` and readiness expand a directory into exactly
    // the bindings ADAPTER_BINDINGS puts on it, all thirty-three of
    // `postgres-tenancy`'s included, and that the reason line is built from
    // those counts rather than from a constant. T07 kills it.
    //
    // The case that catches a DROPPED adapter is "reports 41 of 49" below, whose
    // expectation comes from the binding table and `UNIMPLEMENTED_ADAPTERS`
    // rather than from the construction, and "builds the directory every
    // declared configuration group configures" above, whose expectation comes
    // from the configuration contract.
    const { verdict, construction } = readiness(FULLY_DECLARED);
    const built = new Set<string>(Object.keys(construction.adapters));
    const expected = ADAPTER_BINDINGS.filter((binding) => built.has(binding.adapter));

    expect(verdict.detail.satisfiedBindings).toHaveLength(expected.length);
    expect([...verdict.detail.satisfiedBindings].sort()).toEqual(
      expected.map((binding) => `${binding.adapter}:${binding.port}`).sort(),
    );
    expect(verdict.detail.declaredBindings).toBe(ADAPTER_BINDINGS.length);
    // The figure an operator reads, and the one that used to be a constant.
    expect(verdict.reason).toBe(
      `${expected.length} of ${ADAPTER_BINDINGS.length} adapter bindings are satisfied;` +
        ` ${ADAPTER_BINDINGS.length - expected.length} are not`,
    );
  });

  it("reports 43 of 51, and the 8 that remain are exactly the bindings with no implementation", () => {
    // THE ARITHMETIC, PINNED AND DERIVED. The literal catches drift in either
    // direction; the identity beside it says WHY the number is that number, so a
    // future tranche that implements one of the eight directories sees both
    // move together and knows which it changed.
    const { verdict } = readiness(FULLY_DECLARED);
    const unimplementable = ADAPTER_BINDINGS.filter((binding) =>
      UNIMPLEMENTED_ADAPTERS.includes(binding.adapter),
    );
    expect(unimplementable).toHaveLength(8);
    expect(verdict.detail.satisfiedBindings).toHaveLength(43);
    expect(verdict.detail.satisfiedBindings).toHaveLength(ADAPTER_BINDINGS.length - unimplementable.length);
    expect(verdict.detail.unsatisfiedBindings).toHaveLength(8);
    // STILL RED, AND HONESTLY SO. Eight ports have no implementation in this
    // build, so this process cannot serve the routes that need them. Going green
    // on "everything this install could have wired" would be comparing the
    // supply to itself.
    expect(verdict.ready).toBe(false);
  });

  it("is 1 of 51 with nothing wired, and says which kind of nothing the other 50 are", () => {
    // IT USED TO BE 0, AND THE CHANGE IS THE POINT RATHER THAN AN ADJUSTMENT.
    // WIN-267 A1 added the one directory an install cannot fail to provide, so
    // an unconfigured process is no longer red BY CONSTRUCTION on every single
    // binding — it is red on the fifty that need something an operator has not
    // set or that nobody has written yet.
    const { verdict } = readiness(NOTHING_DECLARED);
    expect(verdict.detail.satisfiedBindings).toEqual(["node-crypto-digest:SecretHasher"]);
    expect(verdict.detail.unsatisfiedBindings).toHaveLength(ADAPTER_BINDINGS.length - 1);
    expect(verdict.reason).toContain(`1 of ${ADAPTER_BINDINGS.length}`);
    // The half that was missing before: an unsatisfied binding list alone cannot
    // tell an unset variable from a package that was never written.
    const causes = new Set(verdict.detail.unwiredAdapters.map((row) => row.cause));
    expect(causes).toEqual(new Set(["configuration", "implementation"]));
  });

  it("carries every unwired reason from the construction through to the detail body", () => {
    // The PLUMBING, end to end. Asserting only `app.unwired` left the readiness
    // half unguarded, which the sweep found: T08 blanks `detail.unwiredAdapters`
    // and this case stayed green. Both ends are compared now, and to each other
    // rather than to a literal, so a row dropped anywhere between them shows up.
    const { app, verdict, construction } = readiness(FULLY_DECLARED);
    expect(construction.unwired).toHaveLength(8);
    expect(app.unwired).toEqual(construction.unwired);
    expect(verdict.detail.unwiredAdapters).toEqual(construction.unwired);
  });
});

describe("the context bundles those adapters can satisfy", () => {
  it("composes tenancy from the adapter, with every port under its own name", () => {
    const { app, assembly, construction } = readiness(FULLY_DECLARED);
    const postgres = construction.adapters["postgres-tenancy"];
    expect(postgres).toBeDefined();
    expect(app.contexts.tenancy).toBeDefined();

    // IDENTITY, NOT SHAPE. `sessionRevoker` and `operators` are both edges into
    // identity-access off the same object, so a bundle assembled positionally
    // would type-check with two ports transposed and fail only at the first
    // owner demotion. Comparing the references is what makes that impossible.
    const bundle = assembly.ports.tenancy;
    expect(bundle?.repository).toBe(postgres);
    expect(bundle?.locks).toBe(postgres?.locks);
    expect(bundle?.sessionRevoker).toBe(postgres?.sessionRevoker);
    expect(bundle?.accessKeyRevocation).toBe(postgres?.accessKeyRevocation);
    expect(bundle?.invitationTokens).toBe(postgres?.invitationTokens);
    expect(bundle?.operators).toBe(postgres?.operators);
    expect(bundle?.unitOfWork).toBe(postgres?.unitOfWork);
  });

  it("composes no context at all when the database is absent", () => {
    const { app } = readiness(NOTHING_DECLARED);
    expect(app.contexts).toEqual({});
  });

  it("does not compose identity-access, and its reason holds against the binding table", () => {
    const { assembly, app } = readiness(FULLY_DECLARED);
    expect(app.contexts.identityAccess).toBeUndefined();
    const declined = assembly.unassembled.find((row) => row.context === "identity-access");
    expect(declined?.reason).toBe(IDENTITY_ACCESS_UNASSEMBLED);

    // THE REASON IS CHECKED, NOT TAKEN ON TRUST. `RateLimiter` is a declared
    // binding on a directory with no implementation, and the two ports beside it
    // appear on no row of the table at all — so no adapter in this tree could
    // satisfy them however an install were configured.
    const rateLimiter = ADAPTER_BINDINGS.filter((binding) => binding.port === "RateLimiter");
    expect(rateLimiter.map((binding) => binding.adapter)).toEqual(["redis-ratelimit"]);
    expect(UNIMPLEMENTED_ADAPTERS).toContain("redis-ratelimit");
    const ports = new Set(ADAPTER_BINDINGS.map((binding) => binding.port));
    for (const port of ["TokenMinter", "TotpCodeVerifier"]) {
      expect(ports, `${port} must be bound to no adapter`).not.toContain(port);
      expect(declined?.reason).toContain(port);
    }

    // AND THE OTHER DIRECTION, WHICH IS THE HALF WIN-267 A1 ADDED. Two ports
    // LEFT this sentence, and a sentence that merely stopped naming them would
    // be an unchecked claim. Each is joined to the directory that satisfies it
    // and to the constructed adapter that carries it, so the reason cannot shed
    // a port the tree has not actually gained.
    const landed: Readonly<Record<string, AdapterName>> = {
      SecretHasher: "node-crypto-digest",
      MfaSecretCipher: "keyring-envelope",
    };
    const { construction } = readiness(FULLY_DECLARED);
    for (const [port, adapter] of Object.entries(landed)) {
      expect(ADAPTER_BINDINGS.filter((binding) => binding.port === port).map((b) => b.adapter)).toEqual([
        adapter,
      ]);
      expect(UNIMPLEMENTED_ADAPTERS).not.toContain(adapter);
      expect(construction.adapters[adapter as AdapterName]).toBeDefined();
      expect(declined?.reason, `${port} is satisfied and must not be named`).not.toContain(port);
    }
  });
});
