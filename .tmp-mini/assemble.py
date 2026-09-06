import re

head = open('/tmp/pl-head.txt').read()
catalogue = open('/tmp/pl-catalogue.txt').read()
tail = open('/tmp/pl-tail.txt').read()

KEY_HEADER = '''// Each of `ProviderKey`'s five database rules, standing beside the guard or the
// store method that meets it.
//
// THE PAIRING IS THE POINT. For every write-shape guard there are two cases: the
// guard refuses the value with a NAMED code, and PostgreSQL refuses the SAME
// value when the guard is stepped around with a raw statement. A guard that
// drifted looser is caught by the second half going green when it should be red;
// one that drifted tighter is caught by the conformance differential going red
// on a value the database accepts.
//
// NOT ONE of the rules below is in `schema.prisma`, so not one is in the
// generated client's types; and not one is in `InMemoryProvidersRepository`, so
// not one is in any use-case suite in the tree. That is the whole reason this
// file exists: the double this context ships stores any `credentialId` at all,
// and every provider key in every use-case suite in the repository was written
// against it.
//
// `Model` AND `ModelPrice` ARE NEXT DOOR, in
// `providers-catalogue-constraints.integration.test.ts`, and the seam is the
// port's own: these four rules are ENVIRONMENT-SCOPED and every case here needs
// a tenant chain and a credential, while not one case there needs a scope at
// all. The split is also what the §6 budget asked for — one file measured 491
// effective lines, inside the warning band and heading for the 500-line ERROR.
//
// It FAILS when Docker is absent rather than skipping.
'''

CATALOGUE_HEADER = '''// `Model` and `ModelPrice`'s database rules, standing beside the guards that
// meet them.
//
// INSTALLATION-GLOBAL, WHICH IS WHY THIS IS A SEPARATE FILE. Not one case here
// takes an `EnvironmentScope`, because these two rows have none — the port says
// so outright — while every case in `providers-constraints.integration.test.ts`
// needs a tenant chain and a credential before it can write anything at all.
// The split is also what the ADR M0.3 §6 budget asked for: one file measured 491
// effective lines, inside the warning band and heading for the 500-line ERROR.
//
// THREE OF THESE RULES HAVE NO COUNTERPART IN THE PORT AT ALL.
// `ModelPrice_rate_check` refuses a KNOWN rate that names no source, and
// `InMemoryProvidersRepository.insertPrice` stores whatever `PriceCard` it is
// handed. `Model`'s `@@unique([provider, name])` is a SECOND identity
// `upsertModel` — keyed by `key` — has no code for, and the double's map is
// keyed by `key` alone so it stores both happily. And `ModelPrice`'s three
// immutability triggers refuse an UPDATE the port never makes, with the
// privileges revoked from PUBLIC on top.
//
// It FAILS when Docker is absent rather than skipping.
'''

# The head file keeps its imports; swap its prose header for the key-shaped one.
body_start = head.index('import { afterAll')
head_body = head[body_start:]
key_file = KEY_HEADER + '\n' + head_body.rstrip() + '\n\n' + tail.rstrip() + '\n'

CATALOGUE_IMPORTS = '''
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ModelId,
  ModelKey,
  PriceCard,
  ProviderId,
  RateBook,
} from "@platos/context-providers/application/ports/index.js";
import {
  asProvidersIdentifier,
  rateFromDecimalString,
} from "@platos/context-providers/application/ports/index.js";

import { MODEL_INTEGER_OUT_OF_RANGE, RATE_OUT_OF_DOMAIN, RATE_PROVENANCE_MISSING } from "./providers-guards.js";
import type { ProvidersHarness } from "./providers-harness.js";
import { startProvidersHarness } from "./providers-harness.js";

let harness: ProvidersHarness;

const AT = new Date("2026-05-01T09:00:00.000Z");
const ANTHROPIC = asProvidersIdentifier<ProviderId>("anthropic");

function uuid(slot: string): string {
  return `ba000000-${slot}-4000-8000-000000000000`;
}

function rate(value: string): { readonly picoUsdPerToken: bigint } {
  const parsed = rateFromDecimalString(value);
  if (!parsed.ok) throw new Error(`fixture rate ${value} is not representable`);
  return parsed.value;
}

/** A card whose four rates are all known and all reference their source. */
function card(effectiveFrom: Date, overrides: Partial<RateBook> = {}): PriceCard {
  const known = {
    rate: rate("0.000001000000"),
    source: "LITELLM" as const,
    observedAt: AT,
    sourceRef: "litellm@2026-05-01",
  };
  return {
    effectiveFrom,
    rates: {
      input: known,
      output: known,
      cacheRead: known,
      cacheWrite: known,
      ...overrides,
    },
  };
}

/** The facts every model in this file is written with. */
function facts(name: string): {
  readonly provider: ProviderId;
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly capabilities: readonly string[];
  readonly releaseDate: Date | null;
  readonly deprecationDate: Date | null;
  readonly baseModelName: string | null;
  readonly sourceUpdatedAt: Date;
} {
  return {
    provider: ANTHROPIC,
    name,
    displayName: null,
    description: null,
    contextWindow: 1000,
    maxOutputTokens: 100,
    capabilities: [],
    releaseDate: null,
    deprecationDate: null,
    baseModelName: null,
    sourceUpdatedAt: AT,
  };
}

beforeAll(async () => {
  harness = await startProvidersHarness();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});
'''

catalogue_file = CATALOGUE_HEADER + CATALOGUE_IMPORTS + '\n' + catalogue.rstrip() + '\n'

open('packages/adapters/postgres-tenancy/src/providers-constraints.integration.test.ts', 'w').write(key_file)
open('packages/adapters/postgres-tenancy/src/providers-catalogue-constraints.integration.test.ts', 'w').write(catalogue_file)
print('written')
