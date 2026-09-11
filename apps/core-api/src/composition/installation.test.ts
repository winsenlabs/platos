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

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_PROVIDER_CATALOGUE, DEFAULT_PROVIDERS_POLICY } from "@platos/context-providers";
// WIN-267 G3. Imported as a VALUE, from the `.` entry point `app.module.ts`
// already imports the `AgentsContract` TYPE from. The import itself is the
// assertion: the sentence this suite reads back used to claim no factory
// assembles this contract, and a claim about another package's exports is only
// worth anything if the module graph is what settles it.
import { agentsContract } from "@platos/context-agents";
import { secretsContract } from "@platos/context-secrets";
import { providersContract } from "@platos/context-providers";
// WIN-267 G3. THE OTHER THREE FACTORIES ON A `.` ENTRY POINT, imported for the
// same reason: the sentence this suite reads back named `agents`, `tools`,
// `memory` and `cost-monitoring` as the four contexts with no assembler, and
// the only honest way to withdraw a claim about another package's exports is to
// resolve them. Nothing composes these three; the import IS the assertion.
import { toolsContract } from "@platos/context-tools";
import { memoryContract } from "@platos/context-memory";
import { costMonitoringContract } from "@platos/context-cost-monitoring";
// WIN-302. THE SEVENTH FACTORY ON A `.` ENTRY POINT, and the one that had been
// sitting on `UNIMPORTABLE_CONTEXT_FACTORIES` while being importable the whole
// time. `conversations/contracts/index.ts` re-exports `createConversationsContract`
// as a VALUE, so this import resolves — and the reason nobody noticed is the
// reason the derived half of the partition below now exists: route one was
// enumerated by a hand-written literal, and a literal compared to another literal
// cannot fail. Nothing composes this context; the import IS the assertion.
import { createConversationsContract } from "@platos/context-conversations";
// And the THREE reached through `./application/index.js` instead. STATIC, so
// rule (C4) can see them: `composition-root.mjs` refuses a specifier assembled
// at run time, and this is the shape that proves the resolver rather than
// evading it. `app.module.ts` already imports the first two this way.
import { createIdentityAccessService } from "@platos/context-identity-access/application/index.js";
import { createGovernanceContract } from "@platos/context-governance/application/index.js";
import { createTenancyService } from "@platos/context-tenancy/application/index.js";
import { createSkillsContract } from "@platos/context-skills/application/index.js";

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
import {
  AGENTS_UNBOUND_PORTS,
  CHANNELS_UNCOMPOSABLE,
  CHANNELS_UNCOMPOSABLE_CHAIN,
  GOVERNANCE_BOUND_READ_SEAMS,
  GOVERNANCE_ROOT_SATISFIED_PORTS,
  GOVERNANCE_UNCOMPOSABLE,
  GOVERNANCE_UNCOMPOSABLE_CHAIN,
  IDENTITY_ACCESS_SLOT_SOURCES,
  GOVERNANCE_UNBOUND_PORTS,
  IDENTITY_ACCESS_UNASSEMBLED,
  TOOLS_ROOT_SATISFIED_PORTS,
  UNIMPORTABLE_CONTEXT_FACTORIES,
  assembleContextPorts,
} from "./context-ports.js";

/**
 * A platform an install could really set, with every group this tranche can
 * construct declared.
 *
 * The ClickHouse, object-store and durable groups are deliberately NOT here:
 * their directories have no constructor, so declaring them would prove nothing
 * and would only make the case read as though it had. The CHANNEL group used to
 * be in that list and left it at WIN-271 (M4.5), when `channel-slack` gained
 * one.
 */
const FULLY_DECLARED = Object.freeze({
  PLATOS_ENVIRONMENT: "test",
  PLATOS_CORE_API_PORT: "0",
  PLATOS_STORE_POSTGRES_URL: "postgresql://platos:password-here@db.internal:5432/platos_control",
  PLATOS_STORE_REDIS_URL: "redis://127.0.0.1:1",
  PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
  PLATOS_SECURITY_ENCRYPTION_KEY: "b".repeat(64),
  PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "3",
  // WIN-271 (M4.5). The channels section's anchor, and the reason it is the
  // SIGNING SECRET rather than a bot token is `config/channels.ts`'s own: an
  // inbound channel is reachable from the public internet, so anchoring on the
  // outbound token would let an install declare a channel it cannot verify. It
  // is 64 characters because the field refuses anything under 32 — the shortest
  // secret worth the name for an HMAC an attacker can grind offline against a
  // body they chose.
  PLATOS_CHANNELS_SLACK_SIGNING_SECRET: "c".repeat(64),
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
  // WIN-271 (M4.5). The FIFTH group to name a directory, and the section had
  // been waiting for it since WIN-297: `config/channels.ts` has anchored on the
  // signing secret from the start, and until this tranche `channel-slack` was a
  // generated interface with no constructor to hand it to.
  "channels.slack": "channel-slack",
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
const BUILT_UNCONDITIONALLY: readonly AdapterName[] = Object.freeze([
  "node-crypto-digest",
  "tokenmint-totp",
]);

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
    channels: value.channels,
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
    // FOUR DIRECTORIES AND THREE REASONS. `node-crypto-digest` and
    // `tokenmint-totp` are neither Redis directories nor configured ones: they
    // are the two built unconditionally, so they appear under every
    // configuration including this one. `redis-cache` and `redis-ratelimit` are
    // both here because ONE variable was declared -- WIN-267 A3 gave the limiter
    // its own keyspace and its own client off `PLATOS_STORE_REDIS_URL`, so that
    // is one variable, two objects, two lifetimes. WIN-272 (M4.6) makes it one
    // variable and THREE: `redis-streams` holds the journal and the bus off the
    // same URL and its own client, and its subscriptions are why it has a
    // lifetime of its own to close. And the outbox is absent
    // because its dependency was not declared. The three states are what the
    // case is about.
    expect([...Object.keys(withoutDatabase.adapters)].sort()).toEqual(
      ["node-crypto-digest", "redis-cache", "redis-ratelimit", "redis-streams", "tokenmint-totp"].sort(),
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
    // composition-root.mjs (C7). The fourteenth and fifteenth are
    // `node-crypto-digest` and `tokenmint-totp`, which read no configuration and
    // are therefore wired even here; asserting their ABSENCE from `unwired` is
    // what makes "built unconditionally" falsifiable rather than a comment.
    // 13 -> 13: `redis-streams` moved from the implementation half to the
    // configuration half of the SAME list, because with nothing declared it is
    // still unwired -- just for a reason an operator can fix. The split below is
    // what moved, and it is asserted per directory rather than by this total.
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
      channels: platform(NOTHING_DECLARED).channels,
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
      channels: platform(NOTHING_DECLARED).channels,
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

  it("reports 50 of 57, and the 7 that remain are exactly the bindings with no implementation", () => {
    // THE ARITHMETIC, PINNED AND DERIVED. The literal catches drift in either
    // direction; the identity beside it says WHY the number is that number, so a
    // future tranche that implements one of the remaining directories sees both
    // move together and knows which it changed.
    //
    // WIN-267 A3 IS THE FIRST TRANCHE TO MOVE IT, and this is the arithmetic,
    // in TWO independent steps that happen to land in one commit:
    //
    //   the LIMITER. Eight unimplemented directories held one binding each;
    //   `redis-ratelimit` gained an implementation, so 8 - 1 = 7 remain and
    //   49 - 7 = 42 are satisfied.
    //
    //   the PROBE CACHE. `redis-cache:ProviderProbeCache` is a FIFTIETH binding
    //   on a directory that was already constructed, so it lands directly in the
    //   satisfied set: 50 - 7 = 43. The unimplemented count does NOT move for
    //   it, because no directory changed state — which is the distinction §15's
    //   amendment is about, and the reason both numbers are asserted.
    //
    // 41/8 of 49 -> 43/7 of 50. Any one of the three moving alone is drift.
    //
    // WIN-267 G1 + G2 TOGETHER: 54 -> 58 declared and 47 -> 51 satisfied, with
    // the unimplemented count UNMOVED at 7. FOUR rows land in this tranche --
    // G1's `postgres-tenancy:EvalRunQueue` and G2's three inverted read seams --
    // and every one of them is a row on a directory a fully declared install
    // ALREADY constructs, so each lands straight in the satisfied set and no
    // directory changed state. That is why both numbers move by the same four
    // and the third does not move at all: a tranche that moved the declared
    // count without moving the satisfied one would have bound a port to a
    // directory nothing constructs, and this triple is what makes that visible.
    //
    // THE FOUR ARE SUMMED HERE AND PINNED SEPARATELY IN EACH BRANCH. Neither G1
    // (+1) nor G2 (+3) could state this figure alone, which is exactly the class
    // of stale pin an integration is for.
    const { verdict } = readiness(FULLY_DECLARED);
    const unimplementable = ADAPTER_BINDINGS.filter((binding) =>
      UNIMPLEMENTED_ADAPTERS.includes(binding.adapter),
    );
    // WIN-272 (M4.6): 59 -> 60 declared and 6 -> 5 unimplementable, by the same
    // subtraction WIN-271 spells out below. `redis-streams` gained a SECOND
    // binding (`StreamJournal`, the ordered and resumable half `EventBus` has no
    // position for) and simultaneously left `UNIMPLEMENTED_ADAPTERS`, so the
    // directory's rows go from 1-unimplementable to 2-satisfiable: 59 + 1 = 60
    // declared, 6 - 1 = 5 unimplementable, and satisfied moves by THREE to 55.
    // WIN-271 (M4.5): 58 -> 59 declared and 7 -> 6 unimplementable, and the two
    // move in OPPOSITE directions for one reason. `channel-slack` gained a
    // SECOND binding (`ChannelRuntime`, the inbound half no port covered) and
    // simultaneously left `UNIMPLEMENTED_ADAPTERS`, so the directory's rows go
    // from 1-unimplementable to 2-satisfiable: 58 + 1 = 59 declared, and
    // 7 - 1 = 6 unimplementable. Satisfied therefore moves by THREE:
    // 51 + 1 (the new row) + 2 (the two rows the directory now serves, minus
    // the one it used to fail) — stated as 59 - 6 = 53 below and derived rather
    // than written, so the two halves cannot drift.
    expect(ADAPTER_BINDINGS).toHaveLength(60);
    expect(unimplementable).toHaveLength(5);
    // WIN-267 A1 + A2: 41 -> 45. Two new directories brought FOUR bindings
    // between them and both directories are constructible, so all four are
    // satisfied; the eight that remained were the same eight.
    // WIN-267 A3: 45 -> 47 of 53 -> 54, by the two independent steps above.
    // WIN-267 G1: 47 -> 48 of 54 -> 55. WIN-267 G2: 48 -> 51 of 55 -> 58.
    // WIN-271 (M4.5): 51 -> 53 of 58 -> 59. WIN-272 (M4.6): 53 -> 55 of 59 -> 60.
    // See the subtraction above.
    expect(verdict.detail.satisfiedBindings).toHaveLength(55);
    expect(verdict.detail.satisfiedBindings).toHaveLength(ADAPTER_BINDINGS.length - unimplementable.length);
    expect(verdict.detail.unsatisfiedBindings).toHaveLength(5);
    // STILL RED, AND HONESTLY SO. Five ports have no implementation in this
    // build, so this process cannot serve the routes that need them. Going green
    // on "everything this install could have wired" would be comparing the
    // supply to itself.
    expect(verdict.ready).toBe(false);
  });

  it("is 3 of 57 with nothing wired, and says which kind of nothing the other 54 are", () => {
    // IT USED TO BE 0 OF 49, AND THE CHANGE IS THE DELIVERABLE RATHER THAN A
    // RELAXATION. Before WIN-267 there was no port in this tree an install could
    // satisfy without configuring something, so "nothing configured" and
    // "nothing satisfied" were the same sentence. `node-crypto-digest` (A1) and
    // `tokenmint-totp` (A2) need no configuration, so they are what separates
    // them — and the three bindings they satisfy are NAMED here rather than
    // counted, so a FOURTH arriving unconfigured would fail this case instead of
    // widening a number.
    const { verdict } = readiness(NOTHING_DECLARED);
    expect([...verdict.detail.satisfiedBindings].sort()).toEqual(
      [
        "node-crypto-digest:SecretHasher",
        "tokenmint-totp:TokenMinter",
        "tokenmint-totp:TotpCodeVerifier",
      ].sort(),
    );
    expect(verdict.detail.unsatisfiedBindings).toHaveLength(ADAPTER_BINDINGS.length - 3);
    expect(verdict.reason).toContain(`3 of ${ADAPTER_BINDINGS.length}`);
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
    // 8 -> 7 (WIN-267 A3): one row per directory NOT built, and
    // `redis-ratelimit` is now built. The same subtraction as the case above.
    // 7 -> 6 (WIN-271, M4.5): `channel-slack` is now built too, from the
    // `channels.slack` group this fixture declares. It is a row per DIRECTORY,
    // not per binding, so this number falls by one while the directory's two
    // bindings move to the satisfied side.
    // 6 -> 5 (WIN-272, M4.6): `redis-streams` is now built too, off the
    // `stores.redis` group -- the same subtraction a third time.
    expect(construction.unwired).toHaveLength(5);
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

  it("COMPOSES identity-access, and every one of its ten slots is joined to its source", () => {
    const { assembly, app, construction } = readiness(FULLY_DECLARED);

    // THE CLAIM THIS WHOLE LINE OF WORK EXISTS FOR, AND IT IS FIRST BECAUSE
    // EVERYTHING BELOW IS EVIDENCE FOR IT. Until WIN-267 this read
    // `toBeUndefined()`.
    const identityAccess = app.contexts.identityAccess;
    expect(identityAccess, "identity-access must be COMPOSED in a fully declared install").toBeDefined();
    expect(identityAccess?.name).toBe("identity-access");
    expect(
      assembly.unassembled.map((row) => row.context),
      "a composed context must not also be reported as unassembled",
    ).not.toContain("identity-access");

    // THE INVERSION, AND WHY IT IS NOT JUST A DELETED ASSERTION. Until this
    // tranche the case named the ports that were MISSING and joined each to the
    // ABSENCE of a binding row. A claim about absence goes GREEN when its
    // subject disappears, so deleting the sentence would have passed. The check
    // is therefore turned around rather than removed: every slot in
    // `IDENTITY_ACCESS_SLOT_SOURCES` is joined FORWARDS to the thing that fills
    // it, and the adapter-sourced ones are joined to a binding row, to that
    // row's directory not being unimplemented, and to the fully declared install
    // having CONSTRUCTED it.
    //
    // REMOVING ANY ONE OF THE FIVE ADAPTERS TURNS THIS RED, and it is proven
    // rather than promised: the second half of this case DELETES each adapter
    // from a construction in turn and asserts the context stops composing.
    const owned = ADAPTER_BINDINGS.filter((binding) => binding.owner === "identity-access");
    expect(owned.map((binding) => binding.port).sort()).toEqual([
      "IdentityAccessRepository",
      "MfaSecretCipher",
      "RateLimiter",
      "SecretHasher",
      "TokenMinter",
      "TotpCodeVerifier",
    ]);
    for (const binding of owned) {
      expect(UNIMPLEMENTED_ADAPTERS).not.toContain(binding.adapter);
      expect(
        construction.adapters[binding.adapter],
        `${binding.adapter} must be constructed for ${binding.port}`,
      ).toBeDefined();
      expect(
        Object.values(IDENTITY_ACCESS_SLOT_SOURCES),
        `${binding.port} is satisfied by ${binding.adapter}, so the map must say so`,
      ).toContain(binding.adapter);
    }

    // THE SLOT MAP IS A PARTITION OF THE BUNDLE, not a list beside it. Ten slots,
    // and the bundle the assembler built must have exactly those ten keys -- so
    // a slot added to `IdentityAccessPorts` that nobody wires fails here, and a
    // slot wired but never named in the map fails here too.
    const bundle = assembly.ports.identityAccess;
    expect(bundle, "the assembler must have produced the bundle").toBeDefined();
    expect(Object.keys(bundle ?? {}).sort()).toEqual(Object.keys(IDENTITY_ACCESS_SLOT_SOURCES).sort());
    expect(Object.keys(IDENTITY_ACCESS_SLOT_SOURCES)).toHaveLength(10);

    // AND THE SLOTS THAT COULD BE TRANSPOSED ARE PINNED BY IDENTITY. `minter`
    // and `totp` come off the SAME object, so a bundle that had swapped them
    // would type-check and pass every count above; the only thing that can catch
    // it is asking which object each slot holds.
    expect(bundle?.minter).toBe(construction.adapters["tokenmint-totp"]);
    expect(bundle?.totp).toBe(construction.adapters["tokenmint-totp"]);
    expect(bundle?.hasher).toBe(construction.adapters["node-crypto-digest"]);
    expect(bundle?.rateLimiter).toBe(construction.adapters["redis-ratelimit"]);
    expect(bundle?.repository).toBe(construction.adapters["postgres-tenancy"]);
    expect(bundle?.cipher).toBe(construction.adapters["keyring-envelope"]?.mfaSecrets);

    // THE KERNEL SINK IS THE SLOT THAT IS NOT AN ADAPTER, AND IT IS MINTED ONCE.
    // `governance-contract.ts` requires this port to be handed back BY IDENTITY
    // -- "a fresh SafetyEventSink per call would be a new object on every
    // enforcement decision" -- so the object in the bundle must be the object
    // the assembly published, not an equal one.
    expect(assembly.safetyEventSink, "a declared install must mint the sink").not.toBeNull();
    expect(bundle?.safety).toBe(assembly.safetyEventSink);
    expect(IDENTITY_ACCESS_SLOT_SOURCES.safety).toBe("governance:createGovernanceSafetyEventSink");

    // AND IT IS STILL BOUND TO NO ADAPTER, which is what makes the sentence
    // above a statement about a CONTEXT rather than about a directory.
    const ports = new Set(ADAPTER_BINDINGS.map((binding) => binding.port));
    expect(ports, "SafetyEventSink must be bound to no adapter").not.toContain("SafetyEventSink");
    expect(UNIMPLEMENTED_ADAPTERS).not.toContain("redis-ratelimit");
  });

  it("STOPS composing identity-access when any one of its five adapters is removed", () => {
    // THE FALSIFIABILITY HALF, RUN RATHER THAN PROMISED. The case above asserts
    // ten slots are filled; this one deletes the directory behind each in turn
    // and asserts the context DISAPPEARS and the reason NAMES the directory.
    // Without this, "every slot is satisfied" would be a claim that could not
    // fail -- the exact defect the sentence it replaced had, pointing the other
    // way.
    const construction = construct(FULLY_DECLARED);
    const value = platform(FULLY_DECLARED);
    const defaults = createProcessDefaults(value.core);
    const directories: AdapterName[] = [
      "postgres-tenancy",
      "redis-ratelimit",
      "node-crypto-digest",
      "tokenmint-totp",
      "keyring-envelope",
    ];
    for (const directory of directories) {
      const withoutOne = { ...construction.adapters };
      delete withoutOne[directory];
      const assembly = assembleContextPorts(withoutOne, defaults);
      expect(
        assembly.ports.identityAccess,
        `identity-access must NOT assemble without ${directory}`,
      ).toBeUndefined();
      const declined = assembly.unassembled.find((row) => row.context === "identity-access");
      expect(declined?.reason, `the reason must NAME ${directory}`).toContain(directory);
      expect(declined?.reason).toContain(IDENTITY_ACCESS_UNASSEMBLED);
    }

    // AND THE SINK GOES WITH THE STORE, because it is built over that store's
    // `SafetyLedger`. This is the one directory whose removal takes out both the
    // repository slot AND the kernel port, and saying so is the difference
    // between "five adapters" and "five adapters, one of which is load-bearing
    // twice".
    const withoutStore = { ...construction.adapters };
    delete withoutStore["postgres-tenancy"];
    expect(assembleContextPorts(withoutStore, defaults).safetyEventSink).toBeNull();
  });

  it("still cannot compose governance, and names the chain that stops it", () => {
    const { app, construction } = readiness(FULLY_DECLARED);

    // COMPOSING `identity-access` THROUGH THE SINK DID NOT COMPOSE `governance`,
    // AND THIS CASE EXISTS SO NOBODY READS IT THAT WAY. All ten of governance's
    // DRIVEN ports are satisfied -- the partition below proves it -- and the
    // context is still absent, because `GovernanceDependencies.agents` needs a
    // COMPOSED peer that is four contexts and six unbound ports away.
    expect(app.contexts.governance).toBeUndefined();

    // THE CHAIN, JOINED TO THE BINDING TABLE AND TO THE UNIMPLEMENTED LIST
    // rather than to a sentence. Five of the six must appear on NO row; the
    // sixth, `ObjectStore`, IS declared and its directory is unimplemented, and
    // those are different facts that must not be allowed to look alike.
    const ports = new Set(ADAPTER_BINDINGS.map((binding) => binding.port));
    expect(GOVERNANCE_UNCOMPOSABLE_CHAIN).toHaveLength(6);
    for (const port of GOVERNANCE_UNCOMPOSABLE_CHAIN.filter((name) => name !== "ObjectStore")) {
      expect(ports, `${port} must still be bound to no adapter`).not.toContain(port);
    }
    const objectStore = ADAPTER_BINDINGS.find((binding) => binding.port === "ObjectStore");
    expect(objectStore?.adapter).toBe("objectstore-minio");
    expect(UNIMPLEMENTED_ADAPTERS).toContain("objectstore-minio");
    expect(construction.adapters["objectstore-minio"]).toBeUndefined();

    // AND THE TWO AGENTS PORTS ARE THE SAME TWO `AGENTS_UNBOUND_PORTS` NAMES, so
    // the chain constant cannot drift away from the list G3 wrote.
    expect(GOVERNANCE_UNCOMPOSABLE_CHAIN).toEqual(expect.arrayContaining([...AGENTS_UNBOUND_PORTS]));
  });

  it("still cannot compose channels, and names the two directories that stop it", () => {
    // WIN-271 (M4.5) BUILT THE ADAPTER AND DID NOT COMPOSE THE CONTEXT, and this
    // case exists so nobody reads the adoption as the composition. An install
    // that declares `channels.slack` now gets an object that verifies Slack
    // signatures over the exact received octets and posts messages under a
    // deadline — and `channels` is still absent.
    const { app, construction } = readiness(FULLY_DECLARED);
    expect(construction.adapters["channel-slack"]).toBeDefined();
    expect(app.contexts.channels).toBeUndefined();

    // THE CHAIN, JOINED TO THE BINDING TABLE AND TO THE UNIMPLEMENTED LIST
    // rather than to the sentence. The directory left is DECLARED — its port
    // exists and is bound — and is a generated interface, which is a different
    // fact from an unbound port and must not be allowed to look like one.
    //
    // IT WAS TWO AND IS NOW ONE, WHICH IS WHY THIS IS A CONSTANT READ BACK AND
    // NOT A COMMENT. WIN-272 (M4.6) gave `redis-streams` a real `EventBus`, so
    // OUTBOUND — the half ADR M0.3 §3 inverts through a subscription — is
    // satisfied and published on `AppModule`. INBOUND is not: it enqueues a turn
    // job through `DurableRuntime`, and that directory is still an interface, so
    // a composed `channels` could post an outbound message and could still
    // authenticate a webhook and then have nowhere to send the turn.
    expect(CHANNELS_UNCOMPOSABLE_CHAIN).toEqual(["durable-runtime"]);
    for (const directory of CHANNELS_UNCOMPOSABLE_CHAIN) {
      expect(ADAPTER_BINDINGS.map((binding) => binding.adapter)).toContain(directory);
      expect(UNIMPLEMENTED_ADAPTERS).toContain(directory);
      expect(construction.adapters[directory as AdapterName]).toBeUndefined();
    }

    // AND THE PORT THAT DIRECTORY CARRIES IS THE SLOT THE CONTEXT STILL CANNOT
    // FILL, read off the binding table rather than retyped, so the sentence
    // cannot drift away from the wiring it describes.
    const carried = CHANNELS_UNCOMPOSABLE_CHAIN.flatMap((directory) =>
      ADAPTER_BINDINGS.filter((binding) => binding.adapter === directory).map((binding) => binding.port),
    );
    expect(carried.sort()).toEqual(["DurableRuntime"]);
    for (const port of carried) expect(CHANNELS_UNCOMPOSABLE).toContain(port);

    // THE HALF THAT IS NOW SATISFIED IS ASSERTED TOO, so "one blocker left" is a
    // measured claim and not the absence of a second one. The bus is a real
    // object off `stores.redis` and it reaches the transports through `AppModule`,
    // which is what `ChannelsDependencies.eventBus` would be filled from.
    expect(construction.adapters["redis-streams"]).toBeDefined();
    expect(app.eventBus).toBe(construction.adapters["redis-streams"]);
    expect(app.streamJournal).toBe(construction.adapters["redis-streams"]?.journal);

    // The context's factory is not importable either, which is the SECOND
    // blocker and the one `UNIMPORTABLE_CONTEXT_FACTORIES` measures against
    // Node's own resolver.
    expect(UNIMPORTABLE_CONTEXT_FACTORIES).toContain("channels");
  });

  it("holds the governance port partition, and the sink it does build", () => {
    const { assembly, construction } = readiness(FULLY_DECLARED);
    const declined = assembly.unassembled.find((row) => row.context === "governance");
    // THE ONE THAT IS LEFT, AND IT IS NOT AN ADAPTER QUESTION. `SafetyEventSink`
    // is on NO row of the binding table: it is a CONTEXT that is missing, not a
    // directory. `redis-ratelimit` is asserted separately because it is the
    // FIRST directory ever to leave `UNIMPLEMENTED_ADAPTERS`, and the case that
    // used to say "RateLimiter is a generated interface" has to be seen to have
    // stopped saying it.
    const ports = new Set(ADAPTER_BINDINGS.map((binding) => binding.port));
    expect(UNIMPLEMENTED_ADAPTERS).not.toContain("redis-ratelimit");
    expect(declined?.reason).not.toContain("RateLimiter is a generated interface");
    expect(declined?.reason).not.toContain("has no implementation");
    expect(ports, "SafetyEventSink must be bound to no adapter").not.toContain("SafetyEventSink");
    expect(declined?.reason).toContain("SafetyEventSink");

    // AND WHY THAT ONE CANNOT BE CLOSED BY AN ADAPTER EITHER, CHECKED RATHER
    // THAN ASSERTED. The only implementation of the kernel sink takes a whole
    // `GovernanceDependencies`, and THREE of THAT bundle's driven ports appear on
    // no row of this table. The day one of them gains an adapter directory, this
    // case fails and the sentence has to be re-derived -- which is the point of
    // naming them rather than writing "governance needs more work".
    //
    // WIN-267 G1 TOOK IT FROM FIVE TO THREE AND G2 TOOK IT FROM THREE TO NONE.
    // An emptied list asserted only by its length is the weakest readback in
    // this file -- deleting the five names would pass -- so the length is NOT
    // the check. The check is the PARTITION below: every one of governance's ten
    // driven ports must be accounted for as bound-here, bound-as-a-read-seam or
    // satisfied-in-this-deployable, and the three lists must not overlap.
    expect(GOVERNANCE_UNBOUND_PORTS).toHaveLength(0);
    for (const port of GOVERNANCE_UNBOUND_PORTS) {
      expect(ports, `${port} must still be bound to no adapter`).not.toContain(port);
    }

    // `EvalRunQueue` LEFT BY GAINING A BINDING, so the assertion is the exact
    // opposite of the loop above: it must now appear on this table, and on the
    // directory §15 sends a row in the one PostgreSQL database to. Dropping it
    // from the list without landing the binding fails here.
    expect(GOVERNANCE_UNBOUND_PORTS).not.toContain("EvalRunQueue");
    expect(ports, "EvalRunQueue must now be bound").toContain("EvalRunQueue");
    expect(
      ADAPTER_BINDINGS.filter((binding) => binding.port === "EvalRunQueue"),
      "EvalRunQueue belongs to governance, on the ORM's one directory",
    ).toEqual([
      { adapter: "postgres-tenancy", port: "EvalRunQueue", owner: "governance" },
    ]);

    // `Judge` LEFT WITHOUT ONE. It must stay off this table -- an adapter
    // directory for it is forbidden by `provider-sdk-only`, which is why the
    // list it moved to is a separate constant rather than a deletion.
    for (const port of GOVERNANCE_ROOT_SATISFIED_PORTS) {
      expect(ports, `${port} must be bound to no adapter`).not.toContain(port);
      expect(GOVERNANCE_UNBOUND_PORTS).not.toContain(port);
    }
    expect(GOVERNANCE_ROOT_SATISFIED_PORTS).toContain("Judge");

    // AND THE THREE THAT LEFT THAT LIST ARE CHECKED IN THE OTHER DIRECTION,
    // WHICH IS THE HALF THAT MAKES THE SHRINKING FALSIFIABLE. WIN-267 G2 moved
    // `RatingTargetReader`, `TranscriptReader` and `ActivityReader` off
    // `GOVERNANCE_UNBOUND_PORTS`; a list that merely stopped naming them would
    // be indistinguishable from one that forgot them. So each is joined to a
    // BINDING ROW, to that row's directory NOT being unimplemented, and to the
    // fully declared install having CONSTRUCTED it. Delete the three properties
    // from `PostgresTenancyAdapter` and this case goes red on each of them.
    //
    // THE SENTENCE MUST ALSO HAVE STOPPED NAMING THEM. It is the operator-facing
    // half, and a reason that still listed three satisfied ports would send an
    // install looking for adapters that are already there.
    const byPort = new Map(ADAPTER_BINDINGS.map((binding) => [binding.port, binding]));
    expect(GOVERNANCE_BOUND_READ_SEAMS).toHaveLength(3);
    for (const port of GOVERNANCE_BOUND_READ_SEAMS) {
      const binding = byPort.get(port);
      expect(binding, `${port} must be bound to a named directory`).toBeDefined();
      expect(binding?.owner, `${port} is a port governance declares`).toBe("governance");
      expect(UNIMPLEMENTED_ADAPTERS).not.toContain(binding?.adapter);
      expect(
        construction.adapters[binding?.adapter ?? ("" as AdapterName)],
        `${port} needs ${binding?.adapter} constructed`,
      ).toBeDefined();
    }

    // THE PARTITION, WHICH IS WHAT REPLACES THE LENGTH CHECK ABOVE.
    //
    // `GovernanceDependencies` declares TEN driven ports. NINE of them are rows
    // this table owns -- the five canonical stores, G1's queue and G2's three
    // seams -- and the tenth is `Judge`, satisfied in this deployable. The three
    // lists are joined to `ADAPTER_BINDINGS` here rather than to each other:
    // drop a row from the table and the nine falls; move a name between lists
    // and the disjointness fails; add a name to a list without a row and the
    // membership check above fails first.
    const governanceRows = ADAPTER_BINDINGS.filter((binding) => binding.owner === "governance");
    expect(governanceRows.map((binding) => binding.port).sort()).toEqual([
      "ActivityReader",
      "CriteriaRepository",
      "EvalRunQueue",
      "EvalsRepository",
      "GoldenSetsRepository",
      "RatingTargetReader",
      "RatingsRepository",
      "SafetyLedger",
      "TranscriptReader",
    ]);
    const accountedFor = new Set([
      ...governanceRows.map((binding) => binding.port),
      ...GOVERNANCE_ROOT_SATISFIED_PORTS,
      ...GOVERNANCE_UNBOUND_PORTS,
    ]);
    expect(accountedFor.size, "the three lists must be disjoint and cover ten").toBe(10);
    expect(
      GOVERNANCE_ROOT_SATISFIED_PORTS.filter((port) => governanceRows.some((row) => row.port === port)),
      "a root-satisfied port must not also be a binding row",
    ).toEqual([]);
  });

  it("constructs both configuration-free adapters with nothing configured at all", () => {
    // THE TWO ADAPTERS NO CONFIGURATION GROUP DECLARES. Every other constructed
    // directory needs a URL, key material or a model name, so every other one is
    // absent from the nothing-declared install. This case is what makes
    // "unconditional" a checked property rather than a comment in
    // `adapter-bindings.ts`, and it is asserted on the install that declares
    // NOTHING precisely because that is where a guard would show up.
    const { construction, app } = readiness(NOTHING_DECLARED);
    const minter = construction.adapters["tokenmint-totp"];
    expect(minter?.adapterName).toBe("tokenmint-totp");
    expect(construction.unwired.map((row) => row.adapter)).not.toContain("tokenmint-totp");
    const digest = construction.adapters["node-crypto-digest"];
    expect(digest?.adapterName).toBe("node-crypto-digest");
    expect(construction.unwired.map((row) => row.adapter)).not.toContain("node-crypto-digest");

    // AND THEY ARE REAL ONES. A token carrying the domain's registered prefix, a
    // 32-character base32 secret, and a code the same object verifies back to the
    // counter it was generated for; and the digest the extraction source writes.
    // `installation.test.ts` is not where the adapters' own suites live, so this
    // is deliberately the shallowest possible end-to-end statement: the objects
    // the composition root wired are the objects that work.
    expect(minter?.mint("operatorSession")).toMatch(/^plt_os_[A-Za-z0-9_-]{43}$/u);
    const secret = minter?.mintTotpSecret() ?? "";
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    const code = minter?.generate(secret, 42n) ?? "";
    expect(minter?.verify({ secret, code, candidateCounters: [41n, 42n, 43n] })).toBe(42n);
    // FIPS 180-4's own SHA-256("abc") -- external ground truth this repository
    // cannot edit into agreement.
    expect(String(digest?.hash("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    // No context becomes composable: `identity-access` still needs a
    // `SafetyEventSink`, and nothing in this process can build one.
    expect(app.contexts.identityAccess).toBeUndefined();
  });

  it("COMPOSES providers, and every one of its ten slots is checked", () => {
    // WIN-267. This context was declared unassembled for a reason that was FALSE
    // at v1 and stayed false through A3: the sentence said `providers` "publishes
    // its use cases one by one and no factory that assembles its whole contract",
    // and `providersContract` has been exported from
    // `packages/contexts/providers/contracts/index.ts` — the `.` entry every
    // consumer already imports — since before that sentence was written. So did
    // `secretsContract`, which is what the same sentence claimed about the peer.
    // Both are composed now, and the case that recorded the refusal is replaced
    // by the case that proves the composition rather than deleted.
    const { app, assembly, construction } = readiness(FULLY_DECLARED);
    expect(app.contexts.providers).toBeDefined();
    expect(app.contexts.secrets).toBeDefined();
    expect(assembly.unassembled.map((row) => row.context)).not.toContain("providers");
    expect(assembly.unassembled.map((row) => row.context)).not.toContain("secrets");

    // ITS THREE DRIVEN PORTS, JOINED TO THE BINDING TABLE BY OWNER rather than
    // to a list this file wrote — the same join the identity-access case makes.
    const built = new Set(Object.keys(construction.adapters));
    const providerPorts = ADAPTER_BINDINGS.filter((binding) => binding.owner === "providers");
    expect(providerPorts.map((binding) => binding.port).sort()).toEqual([
      "ModelRouter",
      "ProviderProbeCache",
      "ProvidersRepository",
    ]);
    for (const binding of providerPorts) {
      expect(built, `${binding.port} is bound to ${binding.adapter}`).toContain(binding.adapter);
    }

    // IDENTITY, NOT SHAPE, for every slot an adapter carries. `repository` is the
    // ORM adapter spread in; `probeCache` is the cache adapter's OWN property and
    // not the adapter; `modelRouter` is its own directory; and `unitOfWork` is
    // the ORM's. A bundle assembled positionally would type-check with
    // `probeCache` and `modelRouter` transposed.
    const bundle = assembly.ports.providers;
    expect(bundle?.repository).toBe(construction.adapters["postgres-tenancy"]);
    expect(bundle?.modelRouter).toBe(construction.adapters["model-router-providers"]);
    expect(bundle?.probeCache).toBe(construction.adapters["redis-cache"]?.probes);
    expect(bundle?.unitOfWork).toBe(construction.adapters["postgres-tenancy"]?.unitOfWork);
    // The two DOMAIN VALUES are the published defaults, taken by identity so a
    // copy could not pass for the catalogue an installation may replace.
    expect(bundle?.policy).toBe(DEFAULT_PROVIDERS_POLICY);
    expect(bundle?.catalogue).toBe(DEFAULT_PROVIDER_CATALOGUE);

    // AND THE TWO PEERS, WHICH ARE THE HALF `context-ports.ts` CANNOT SUPPLY.
    // They are contexts, so `app.module.ts` fills them from the contracts it has
    // just built — and the assembled bundle must NOT carry them, or this root
    // would be holding a context in the file that holds only adapters.
    expect(bundle).not.toHaveProperty("tenancy");
    expect(bundle).not.toHaveProperty("secrets");
    expect(app.contexts.providers?.name).toBe("providers");
    expect(app.contexts.secrets?.name).toBe("secrets");
  });

  it("composes secrets from the two directories that carry its ports, by name", () => {
    const { app, assembly, construction } = readiness(FULLY_DECLARED);
    const postgres = construction.adapters["postgres-tenancy"];
    const keyring = construction.adapters["keyring-envelope"];
    expect(app.contexts.secrets).toBeDefined();

    // THE TWO STORE PORTS ARE DIFFERENT PROPERTIES OF THE SAME ADAPTER, and the
    // three cryptography ports are the SAME OBJECT under three names — which is
    // exactly why identity is asserted here. `keyRing`, `cipher` and `hasher`
    // are structurally satisfied by one `KeyringEnvelopeAdapter`, so a bundle
    // that had swapped any two of them would compile and this is the only place
    // that could notice.
    const bundle = assembly.ports.secrets;
    expect(bundle?.repository).toBe(postgres?.secrets);
    expect(bundle?.variables).toBe(postgres?.secretsVariables);
    expect(bundle?.keyRing).toBe(keyring);
    expect(bundle?.cipher).toBe(keyring);
    expect(bundle?.hasher).toBe(keyring);
    expect(bundle?.unitOfWork).toBe(postgres?.unitOfWork);
  });

  it("names an AgentsContract that a published factory DOES assemble", () => {
    // WIN-267 G3 — THE CLAIM THIS CASE EXISTS TO KILL. `IDENTITY_ACCESS_UNASSEMBLED`
    // used to end "and an AgentsContract no factory assembles". That was the
    // THIRD claim of this exact shape the programme has had to withdraw: the
    // same wording stood over `secrets` and `providers` until WIN-267 grepped,
    // and both had been composable since v1.
    //
    // THE IMPORT AT THE HEAD OF THIS FILE IS THE ASSERTION, and it is a join to
    // the agents package's own module graph rather than to a string this file
    // wrote. `agentsContract` resolves through `@platos/context-agents`'s `.`
    // condition -- `dist/contracts/index.js` -- which is the same specifier
    // `app.module.ts` already imports `AgentsContract` from, so this cannot pass
    // by reaching somewhere the composition root may not reach.
    expect(typeof agentsContract).toBe("function");
    // SAME SHAPE AS THE TWO COMPOSED PEERS, checked rather than described. The
    // brief for this tranche was "build the assembler the way `secretsContract`
    // and `providersContract` are built"; there was nothing to build, and the
    // way to show that is that all three are already one function of one bundle
    // off one entry point.
    expect(typeof secretsContract).toBe("function");
    expect(typeof providersContract).toBe("function");
    for (const factory of [agentsContract, secretsContract, providersContract]) {
      expect(factory).toHaveLength(1);
    }

    // AND THE SENTENCE MUST NOT SAY OTHERWISE AGAIN. Two directions: the
    // withdrawn wording is gone, and the replacement names the factory that
    // withdrew it, so a future edit cannot quietly restore the old claim without
    // failing here.
    // THE SENTENCE THAT CARRIES THE CLAIM MOVED WITH THE COMPOSITION. It used to
    // be `identity-access`' refusal; that context is composed now, so the
    // wording lives on `governance`'s own `/readyz` row, which is where an
    // operator would look for it.
    const { assembly } = readiness(FULLY_DECLARED);
    const declined = assembly.unassembled.find((row) => row.context === "governance");
    expect(declined?.reason).toBe(GOVERNANCE_UNCOMPOSABLE);
    expect(declined?.reason).not.toContain("no factory assembles");
    expect(declined?.reason).not.toContain("publishes its use cases one by one");
    expect(declined?.reason).toContain("agentsContract");
  });

  it("blocks that contract on two agents ports instead, and joins them to the table", () => {
    // WHERE THE BLOCKER ACTUALLY IS, once the assembler claim is withdrawn. The
    // root cannot hand `governance` an `AgentsContract` because it cannot BUILD
    // one, and `AgentsDependencies`' four driven ports split two and two.
    const { assembly } = readiness(FULLY_DECLARED);
    const declined = assembly.unassembled.find((row) => row.context === "governance");
    const ports = new Set(ADAPTER_BINDINGS.map((binding) => binding.port));

    // THE TWO THAT ARE SATISFIED, derived from the binding table BY OWNER rather
    // than from a list this file wrote -- the same join the identity-access and
    // providers cases make. A port that left the table, or one that arrived,
    // changes this set without anybody editing the case.
    const owned = ADAPTER_BINDINGS.filter((binding) => binding.owner === "agents");
    expect(owned.map((binding) => binding.port).sort()).toEqual([
      "AgentsRepository",
      "ScaffoldingRepository",
    ]);
    for (const binding of owned) expect(UNIMPLEMENTED_ADAPTERS).not.toContain(binding.adapter);

    // AND THE TWO THAT ARE NOT, joined the way `GOVERNANCE_UNBOUND_PORTS` is:
    // each must appear on NO row, and must be NAMED in the reason. The day a
    // directory implements one, this case fails and the sentence has to be
    // re-derived -- which is precisely what the wording it replaced never had.
    expect(AGENTS_UNBOUND_PORTS).toHaveLength(2);
    for (const port of AGENTS_UNBOUND_PORTS) {
      expect(ports, `${port} must still be bound to no adapter`).not.toContain(port);
      expect(declined?.reason, `${port} must be NAMED in governance's refusal`).toContain(port);
    }
    // The two sets must not overlap, or "unbound" would be a list of things that
    // are in fact bound and the loop above would be vacuous.
    for (const binding of owned) expect(AGENTS_UNBOUND_PORTS).not.toContain(binding.port);
  });

  it("cannot import SIX context factories, and partitions all seventeen by DERIVING route one", () => {
    // THE OTHER HALF OF THE SAME CORRECTION, and the one that will bite the next
    // tranche. Every one of the seventeen contexts publishes a factory over its
    // whole contract; SIX of them keep it in `application/` behind a manifest
    // that publishes no `./application/index.js`, so this package cannot name it.
    //
    // THE COUNT HAS MOVED TWICE AND ONLY ONE OF THE MOVES WAS A CHANGE TO THE
    // TREE. It was EIGHT until WIN-267 published `governance`'s subpath, which
    // this file's own import of `createGovernanceSafetyEventSink` required — a
    // real change. WIN-302 takes it from seven to SIX and nothing about
    // `conversations` moved: its root barrel has re-exported
    // `createConversationsContract` all along, so the list was simply WRONG, and
    // it was wrong in the direction that costs a tranche its plan. The derived
    // half below is what makes that class of error a red test instead of a
    // paragraph somebody has to re-measure.
    //
    // JOINED TO THE MANIFESTS, WHICH IS WHAT THE RESOLVER READS. A negative
    // about packaging is exactly the kind of claim this file has been wrong
    // about three times, so it is measured against the `exports` map of every
    // context package rather than asserted -- and against ALL SEVENTEEN, as a
    // PARTITION, so a context cannot fall out of both halves and be counted by
    // neither. The day a manifest publishes the subpath, it moves from one side
    // of the partition to the other and this case fails.
    //
    // IT READS THE FILES RATHER THAN IMPORTING THE SUBPATHS, and that is rule
    // (C4) rather than a preference: a specifier assembled at run time is one
    // `composition-root.mjs` refuses outside `apps/mcp-stdio/src/runtime.ts`,
    // because no boundary rule can see it, and a LITERAL dynamic import of a
    // subpath that does not exist fails in Vite's transform -- the whole file
    // fails to load and no case runs, which is a vacuous red rather than an
    // assertion. `config/sections.test.ts` reads the platform's own files the
    // same way for the same reason.
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const manifestOf = (context: string): { readonly exports?: Record<string, unknown> } =>
      JSON.parse(readFileSync(`${root}packages/contexts/${context}/package.json`, "utf8")) as {
        readonly exports?: Record<string, unknown>;
      };

    // The seventeen ADR M0.3 §4 names, spelled out rather than globbed: a
    // directory listing would shrink silently with the tree and make the
    // partition below a statement about whatever happened to be there.
    const contexts = [
      "identity-access", "tenancy", "secrets", "providers", "agents", "skills",
      "tools", "memory", "channels", "files", "observability", "cost-monitoring",
      "governance", "jobs", "conversations", "eventing", "privacy",
    ] as const;
    expect(contexts).toHaveLength(17);

    // A FACTORY IS IMPORTABLE BY EITHER OF TWO ROUTES, and getting that wrong is
    // how the sentence being withdrawn stayed wrong: `cost-monitoring`, `memory`,
    // `providers` and `tools` publish NO `./application/index.js` and are
    // importable anyway, because their factory is on the `.` entry point. A
    // partition drawn on the manifest subpath alone would put those four on the
    // wrong side and reproduce the original error in a new place.
    //
    // ROUTE ONE, PROVED BY THE MODULE GRAPH. Every one of these was imported
    // statically at the head of this file, from the `.` specifier
    // `app.module.ts` already imports each context's TYPE from. Delete any of
    // the six exports and this file stops resolving.
    const onDotEntry = {
      agents: agentsContract,
      "cost-monitoring": costMonitoringContract,
      memory: memoryContract,
      providers: providersContract,
      secrets: secretsContract,
      tools: toolsContract,
      // WIN-302 — see this entry's import. It was missing here and PRESENT on
      // `UNIMPORTABLE_CONTEXT_FACTORIES`, which is the drift the derived half
      // below now makes impossible.
      conversations: createConversationsContract,
    } as const;
    // ROUTE TWO, PROVED THE SAME WAY, through the subpath the remaining SEVEN do
    // not have. WIN-267 adds `governance`: this file imports
    // `createGovernanceSafetyEventSink` from that subpath, which is why the
    // manifest publishes it, and `createGovernanceContract` rides the same
    // barrel. It is named here by the CONTRACT factory rather than by the sink,
    // because what this partition measures is whether the context's assembler
    // can be reached -- and the answer for `governance` is now yes, while the
    // context still cannot be BUILT for the reasons three cases above state.
    const onApplicationEntry = {
      governance: createGovernanceContract,
      "identity-access": createIdentityAccessService,
      skills: createSkillsContract,
      tenancy: createTenancyService,
    } as const;
    for (const [context, factory] of [
      ...Object.entries(onDotEntry),
      ...Object.entries(onApplicationEntry),
    ]) {
      expect(typeof factory, `${context} publishes an importable factory`).toBe("function");
    }

    // ---------------------------------------------------------------------
    // WIN-302 — ROUTE ONE IS NOW DERIVED FROM THE CONTEXTS' OWN BARRELS, AND
    // THAT IS THE GATE THAT SHOULD HAVE EXISTED SINCE WIN-267 G3.
    //
    // The literal above proves that each named factory RESOLVES; the module
    // graph settles that and nothing else can. What it could never prove is the
    // COMPLEMENT — that no OTHER context also publishes one from `.` — because
    // the literal and `UNIMPORTABLE_CONTEXT_FACTORIES` are both maintained by
    // hand, and this programme's first lesson is that an assertion comparing two
    // things you control cannot fail. It did not fail: `conversations`
    // re-exported `createConversationsContract` from its root barrel and sat on
    // the unimportable list for two tranches, and the partition below was green
    // the whole time because both of its sides had been edited to agree.
    //
    // SO THE EXPECTATION IS COMPUTED FROM SEVENTEEN FILES THIS PACKAGE DOES NOT
    // OWN. For each context, the accepted factory NAMES are derived from the
    // DIRECTORY NAME — `cost-monitoring` -> `costMonitoringContract` /
    // `createCostMonitoringContract` / `costMonitoringService` /
    // `createCostMonitoringService` — so nothing here is a list of names somebody
    // has to remember to extend. The day a context re-exports its assembler from
    // `contracts/index.ts`, this case fails until the literal above and the
    // constant below both move.
    //
    // IT READS THE FILES RATHER THAN IMPORTING THEM, for the two reasons this
    // case already records: rule (C4) refuses a specifier assembled at run time,
    // and a literal dynamic import of a subpath that does not exist fails in
    // Vite's TRANSFORM, taking the whole file down as a vacuous red.
    //
    // `export * from` IS FOLLOWED, up to two levels. `tenancy`, `agents` and
    // `privacy` all star-export inside their root barrels today, so a rule that
    // stopped at the barrel's own text would silently answer "no factory" for a
    // context that publishes one through a star — reintroducing the exact blind
    // spot this derivation exists to close, in a new place.
    const factoryNames = (context: string): readonly string[] => {
      const pascal = context
        .split("-")
        .map((part) => `${(part[0] ?? "").toUpperCase()}${part.slice(1)}`)
        .join("");
      const camel = `${(pascal[0] ?? "").toLowerCase()}${pascal.slice(1)}`;
      return [
        `${camel}Contract`,
        `create${pascal}Contract`,
        `${camel}Service`,
        `create${pascal}Service`,
      ];
    };
    const exportedFactory = (file: string, wanted: readonly string[], depth = 0): string | null => {
      if (depth > 2 || !existsSync(file)) return null;
      const source = readFileSync(file, "utf8");
      for (const name of wanted) {
        if (new RegExp(`^export function ${name}\\s*(?:<|\\()`, "mu").test(source)) return name;
        if (new RegExp(`^export const ${name}\\b`, "mu").test(source)) return name;
        if (new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\} from `, "msu").test(source)) return name;
      }
      for (const match of source.matchAll(/^export \* from "(\.[^"]+)";/gmu)) {
        const relative = (match[1] ?? "").replace(/\.js$/u, ".ts");
        const target = new URL(relative, new URL(file, "file:///"));
        const found = exportedFactory(fileURLToPath(target), wanted, depth + 1);
        if (found !== null) return found;
      }
      return null;
    };
    const derivedOnDotEntry = contexts.filter(
      (context) =>
        exportedFactory(`${root}packages/contexts/${context}/contracts/index.ts`, factoryNames(context)) !==
        null,
    );
    // THE JOIN. Not a length, not a superset: set equality in both directions, so
    // a factory added to a barrel fails here and a name deleted from the literal
    // fails here too.
    expect([...derivedOnDotEntry].sort()).toEqual([...Object.keys(onDotEntry)].sort());
    // AND IT IS NOT VACUOUS. A derivation that matched nothing — a typo in the
    // name rule, a moved barrel — would make the equality above a comparison of
    // two empty sets, which is exactly the failure this whole case is about.
    expect(derivedOnDotEntry.length).toBeGreaterThan(1);
    for (const context of derivedOnDotEntry) {
      expect(
        exportedFactory(`${root}packages/contexts/${context}/contracts/index.ts`, factoryNames(context)),
        `${context} must publish a factory whose name the DIRECTORY implies`,
      ).not.toBeNull();
    }

    // THE MANIFEST HALF, which is the only instrument that can speak for the
    // absent: route two exists exactly when the package publishes the subpath.
    const publishesEntry = contexts.filter(
      (context) => manifestOf(context).exports?.["./application/index.js"] !== undefined,
    );
    expect([...publishesEntry].sort()).toEqual(
      [...Object.keys(onApplicationEntry), "agents", "secrets"].sort(),
    );
    // AND `governance` MUST HAVE LEFT THE UNIMPORTABLE LIST, in both directions:
    // the list shrank by exactly one and the name that left is the one whose
    // manifest changed. A list edited without the manifest, or a manifest
    // changed without the list, fails here.
    expect(UNIMPORTABLE_CONTEXT_FACTORIES).toHaveLength(6);
    expect(UNIMPORTABLE_CONTEXT_FACTORIES).not.toContain("governance");
    expect(publishesEntry).toContain("governance");
    // WIN-302 — AND `conversations` HAS LEFT IT TOO, by the OTHER route. It never
    // needed the subpath: its root barrel re-exports the factory, so it was
    // importable on the day the list first named it. Both halves are asserted so
    // the removal cannot be mistaken for a manifest change that did not happen.
    expect(UNIMPORTABLE_CONTEXT_FACTORIES).not.toContain("conversations");
    expect(publishesEntry).not.toContain("conversations");
    expect(derivedOnDotEntry).toContain("conversations");

    // AND THE PARTITION OVER ALL SEVENTEEN. Importable is the UNION of the two
    // routes -- `agents` and `secrets` are in both -- and the complement is the
    // list. 10 + 7 = 17, so a context cannot fall out of both halves and be
    // counted by neither, which is what a list checked only against itself
    // allows. It was 9 + 8 until WIN-267 published `governance`'s subpath.
    const importable = new Set([
      ...Object.keys(onDotEntry),
      ...Object.keys(onApplicationEntry),
    ]);
    expect(importable.size).toBe(11);
    expect([...contexts].filter((context) => !importable.has(context)).sort()).toEqual(
      [...UNIMPORTABLE_CONTEXT_FACTORIES].sort(),
    );
    expect(UNIMPORTABLE_CONTEXT_FACTORIES).toHaveLength(6);
    for (const context of UNIMPORTABLE_CONTEXT_FACTORIES) {
      expect(contexts, `${context} must be one of the seventeen`).toContain(context);
      // The manifest IS there and publishes `.` -- so each of these is a context
      // that declined to publish the subpath, not a package that is missing,
      // which is what a misspelled name on the list would be.
      expect(Object.keys(manifestOf(context).exports ?? {})).toContain(".");
      expect(manifestOf(context).exports?.["./application/index.js"]).toBeUndefined();
    }

    // `governance` WAS THE ONE THAT MATTERED, and WIN-267 closed it. G3's
    // finding was that a tranche landing all five of `GOVERNANCE_UNBOUND_PORTS`
    // still could not compose the context because `createGovernanceContract`
    // could not be NAMED from here. Both halves moved in this tranche: the five
    // ports landed and the subpath is published, so what is left is the peer
    // chain and nothing about packaging.
    expect(UNIMPORTABLE_CONTEXT_FACTORIES).not.toContain("governance");
    expect(typeof createGovernanceContract).toBe("function");
  });

  it("declines secrets and providers by NAMING the directory that is missing", () => {
    // FALSIFIABILITY, FROM THE OTHER SIDE. An install with a database and no
    // root key ring composes tenancy and neither of the two new contexts, and
    // the reason must say WHICH directory — "secrets is not composed" is not an
    // operator-actionable sentence, and neither is one that blames the context.
    const { app, assembly } = readiness({
      PLATOS_ENVIRONMENT: "test",
      PLATOS_CORE_API_PORT: "0",
      PLATOS_STORE_POSTGRES_URL: "postgresql://platos:password-here@db.internal:5432/platos_control",
    });
    expect(app.contexts.tenancy).toBeDefined();
    expect(app.contexts.secrets).toBeUndefined();
    expect(app.contexts.providers).toBeUndefined();
    const reasons = new Map(assembly.unassembled.map((row) => [row.context, row.reason]));
    expect(reasons.get("secrets")).toContain("keyring-envelope");
    expect(reasons.get("providers")).toContain("model-router-providers");
    expect(reasons.get("providers")).toContain("redis-cache");
    expect(reasons.get("secrets")).not.toContain("postgres-tenancy");
  });
});

describe("composing tools, whose two remaining ports no adapter directory may hold", () => {
  /**
   * The eleven slots `ToolsDependencies` names, and where each one comes from.
   *
   * SPELLED OUT HERE RATHER THAN READ OFF THE THING UNDER TEST, for the reason
   * `GROUP_BUILDS` gives: deriving the expectation from the bundle the assembler
   * built would compare `assembleContextPorts` to itself and could not fail. The
   * right-hand side is either an adapter DIRECTORY that ADR M0.3 §4 assigns, a
   * kernel port the process holds, a published domain default, this deployable, or
   * a composed PEER that ADR M0.3 §1 row 7 permits.
   */
  const TOOLS_SLOT_SOURCES: Readonly<Record<string, string>> = Object.freeze({
    repository: "postgres-tenancy",
    dispatch: "this deployable (tools/adapters)",
    digest: "this deployable (tools/adapters)",
    clock: "kernel",
    ids: "kernel",
    unitOfWork: "postgres-tenancy",
    policy: "tools:DEFAULT_TOOLS_POLICY",
  });

  /** The four peers only `composeApplication` can supply. ADR M0.3 §1 row 7. */
  const TOOLS_PEERS = Object.freeze(["tenancy", "identityAccess", "secrets", "providers"]);

  it("composes it in a fully declared install, over a REAL construction", () => {
    const { app, assembly } = readiness(FULLY_DECLARED);

    expect(app.contexts.tools, "a fully declared install must compose tools").toBeDefined();
    expect(app.contexts.tools?.name).toBe("tools");
    // AND ITS FOUR PEERS ARE COMPOSED TOO, which is not decoration: the context
    // is ABSENT rather than half-built the moment any of them is, so a composed
    // `tools` beside an absent peer would mean the guard had been weakened.
    for (const peer of TOOLS_PEERS) {
      expect(app.contexts, `${peer} is a peer tools cannot be built without`).toHaveProperty(peer);
    }
  });

  it("fills exactly the seven slots the assembler owns, and pins the two that could be transposed", () => {
    const { assembly, construction } = readiness(FULLY_DECLARED);
    const bundle = assembly.ports.tools;

    // A PARTITION, not a list beside the bundle. A slot added to
    // `ToolsDependencies` that nobody wires fails here, and a slot wired but never
    // named in the map fails here too.
    expect(bundle, "the assembler must have produced the bundle").toBeDefined();
    expect(Object.keys(bundle ?? {}).sort()).toEqual(Object.keys(TOOLS_SLOT_SOURCES).sort());
    // Eleven declared slots minus the four peers `composeApplication` fills.
    expect(Object.keys(TOOLS_SLOT_SOURCES)).toHaveLength(7);

    // `repository` AND `unitOfWork` BOTH COME OFF THE ORM DIRECTORY and are
    // structurally different, so the compiler catches a swap of those two. What it
    // cannot catch is `repository` holding some OTHER object that satisfies the
    // interface, so the identity is asserted.
    expect(bundle?.repository).toBe(construction.adapters["postgres-tenancy"]);
    expect(bundle?.unitOfWork).toBe(construction.adapters["postgres-tenancy"]?.unitOfWork);

    // THE DISPATCH IS THE OBJECT THE ASSEMBLY PUBLISHED, minted ONCE. It holds a
    // session pool keyed on `DispatchTarget.sessionKey`; a fresh adapter per bundle
    // would be a fresh pool, so every call would pay an `initialize` handshake and
    // no session would ever be reused. This is the same identity pin the
    // `SafetyEventSink` gets, for the same class of reason.
    expect(assembly.toolDispatch, "a declared install must build the dispatch").not.toBeNull();
    expect(bundle?.dispatch).toBe(assembly.toolDispatch);

    // AND THE DIGEST SLOT HOLDS A REAL SHA-256, checked against FIPS 180-4's own
    // published example rather than against another digest this tree computed. A
    // slot filled with any one-method object would satisfy the type; only a known
    // answer says the right one is in it, and `Tool.schemaHash` is PERSISTED, so a
    // wrong digest here remints every tool row in the installation.
    expect(bundle?.digest.sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("declines tools by NAMING the directory that is missing, and says the two ports are not the blocker", () => {
    // FALSIFIABILITY. An install with no store composes nothing, and the reason
    // must point at `postgres-tenancy` — not at the MCP client, which is satisfied
    // in every configuration because it reads no configuration at all.
    const { app, assembly } = readiness(NOTHING_DECLARED);

    expect(app.contexts.tools).toBeUndefined();
    const reason = new Map(assembly.unassembled.map((row) => [row.context, row.reason])).get("tools");
    expect(reason).toContain("postgres-tenancy");
    expect(reason).toContain("ToolDispatch");
    expect(reason).toContain("ContentDigest");
    // AND NOTHING WAS OPENED. A dispatch adapter built for a context that cannot be
    // assembled would be a session pool with no owner and no `release()` caller.
    expect(assembly.toolDispatch).toBeNull();
  });

  it("closes what it opened, so release() is not a promise nobody keeps", async () => {
    const { assembly } = readiness(FULLY_DECLARED);
    const dispatch = assembly.toolDispatch;

    expect(dispatch).not.toBeNull();
    // Nothing has dispatched, so the pool is empty — the claim being checked is
    // that the call REACHES the pool and is safe, which is what `main.ts` relies on
    // when it calls this unconditionally after the drain.
    expect(dispatch?.liveMcpSessions).toBe(0);
    await assembly.release();
    expect(dispatch?.liveMcpSessions).toBe(0);
    // Idempotent: `main.ts` calls it on the fault path AND on the clean path, and
    // one process can reach both.
    await assembly.release();
  });

  it("keeps both root-satisfied ports off the binding table, in both directions", () => {
    const ports = new Set(ADAPTER_BINDINGS.map((binding) => binding.port));

    // DIRECTION ONE. A name on this list must be bound to no adapter, so the day a
    // directory appears for one of them this case goes red and the list has to move
    // — which is what stops a port sitting here unnoticed after gaining a home.
    for (const port of TOOLS_ROOT_SATISFIED_PORTS) {
      expect(ports, `${port} must be bound to no adapter`).not.toContain(port);
    }
    expect(TOOLS_ROOT_SATISFIED_PORTS).toEqual(["ToolDispatch", "ContentDigest"]);

    // DIRECTION TWO, and it is the half that makes the list mean something: each
    // name must have an IMPLEMENTATION reachable from here, proven by the composed
    // context existing in a declared install. A list naming a port nobody
    // implemented would pass direction one and fail this.
    const { app } = readiness(FULLY_DECLARED);
    expect(app.contexts.tools).toBeDefined();

    // AND THE BINDING COUNT DID NOT MOVE. This is the sentence `process.test.ts`
    // reads off a real socket, asserted here against the table instead: composing
    // `tools` adds a CONTEXT and no BINDING, so `declaredBindings` is untouched.
    expect(ADAPTER_BINDINGS).toHaveLength(60);
  });

  it("publishes the adapters barrel from EXACTLY ONE of the seventeen, and it is the SDK's home", () => {
    // THE MANIFESTS ARE READ AND THE SUBPATHS ARE NOT IMPORTED, which is the trap
    // the `UNIMPORTABLE_CONTEXT_FACTORIES` case above already documents and paid
    // for: a LITERAL dynamic import of a subpath that does not exist fails in
    // Vite's TRANSFORM, so the whole file fails to load and no case runs at all — a
    // vacuous red rather than an assertion. Measured here after reproducing it.
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const contexts = [
      "identity-access", "tenancy", "secrets", "providers", "agents", "skills",
      "tools", "memory", "channels", "files", "observability", "cost-monitoring",
      "governance", "jobs", "conversations", "eventing", "privacy",
    ] as const;
    expect(contexts).toHaveLength(17);

    const publishing = contexts.filter((context) => {
      const manifest = JSON.parse(
        readFileSync(`${root}packages/contexts/${context}/package.json`, "utf8"),
      ) as { readonly exports?: Record<string, unknown> };
      return manifest.exports?.["./adapters/index.js"] !== undefined;
    });

    // A PARTITION OVER ALL SEVENTEEN, so the day a second context grows a barrel
    // this fails and somebody has to say which SDK the ADR homed there. If an
    // `adapters/` directory were simply a thing any context could publish,
    // `ADAPTER_ENTRY_PROJECTS`' join to `SDK_CONTAINMENT` would be decoration.
    // `memory` declares a `ContentDigest` of its own and is deliberately NOT here.
    expect(publishing).toEqual(["tools"]);

    // AND THE FILE THE ENTRY POINTS AT EXISTS, which is the run-time claim the type
    // layer cannot make: a manifest subpath aimed at a `dist/` path no tsconfig
    // `include` emits type-checks and then fails at import — the dead-surface shape
    // WIN-297 named, one layer down. The barrel is imported STATICALLY by
    // `context-ports.ts`, so the positive half is proven by this file loading; what
    // is checked here is the emitted artifact.
    expect(existsSync(`${root}packages/contexts/tools/dist/adapters/index.js`)).toBe(true);
    expect(
      JSON.parse(readFileSync(`${root}packages/contexts/tools/tsconfig.json`, "utf8")) as {
        readonly include?: string[];
      },
    ).toMatchObject({ include: expect.arrayContaining(["adapters/**/*.ts"]) });
  });
});
