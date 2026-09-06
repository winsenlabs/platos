// The invariants PostgreSQL enforces on `providers`' four rows that the port's
// TYPES cannot, checked on the way in so each refusal has a name.
//
// WHY THIS FILE EXISTS, and it is the argument `identity-guards.ts`,
// `cost-guards.ts` and `secrets-guards.ts` make one context over. Every rule
// restated below lives in `internal-packages/tenancy-database/prisma/migrations/`.
// NOT ONE of the CHECKs is in `schema.prisma`, so not one is in the generated
// client's types; and not one is in `InMemoryProvidersRepository`, the double
// this context ships, so not one is in any use-case suite in the tree.
//
// THE DOUBLE PROVES THE POINT, and on this context it proves it harder than on
// any other so far. `InMemoryProvidersRepository.insertPrice` stores whatever
// `PriceCard` it is handed: a `VERIFIED_PROVIDER` rate with a null `sourceRef`,
// a negative `picoUsdPerToken`, a rate wider than `Decimal(24, 12)`. All three
// type-check, all three satisfy the fake, and `ModelPrice_rate_check` refuses
// all three. `upsertModel` is the same one row over: `contextWindow` is a
// PostgreSQL `INTEGER` and the double happily records 4 000 000 000.
//
// THE DATABASE REMAINS AUTHORITATIVE. These do not replace the constraints and
// may not disagree with them: `providers-constraints.integration.test.ts` removes
// each guard and shows PostgreSQL refusing the same input, so a guard that
// drifted looser is caught there, and one that drifted tighter is caught by the
// conformance run going red on a value the database accepts. What the guard buys
// is a NAMED refusal at the call site instead of a driver error carrying a
// constraint name and a SQLSTATE.
//
// SIX REFUSALS, SIX CODES. A shared code would make "this identifier is not a
// uuid", "this rate exceeds the Decimal(24, 12) domain" and "this verified rate
// names no source" indistinguishable in a log, and they have six causes and six
// fixes. Unlike `secrets`, `providers/domain/errors.ts` publishes a RICH set of
// caller-facing codes — but not one of them describes a write the SCHEMA will not
// hold, and inventing a `PROVIDERS_*` code for a defect in the adapter's own
// caller would put an adapter concern into a context's published vocabulary. So
// the distinction is carried here, as a thrown refusal — which is what the port's
// "a rejected promise is a defect, not an outcome" leaves room for.

/** A column declared `@db.Uuid` was handed something that is not one. */
export const IDENTIFIER_NOT_UUID = "providers.write.identifier_not_uuid";

/**
 * `ModelPrice_rate_check`'s first half: `"inputRate" >= 0` and its three
 * siblings — widened to the whole `Decimal(24, 12)` domain, which is the column
 * rather than the CHECK.
 *
 * `domain/rate.ts` already refuses both through `tokenRate()`, and that is not a
 * reason to omit this: a `TokenRate` is a plain readonly object, so
 * `{ picoUsdPerToken: -1n }` type-checks and never went near the constructor.
 */
export const RATE_OUT_OF_DOMAIN = "providers.write.rate_out_of_domain";

/**
 * `ModelPrice_rate_check`'s second half:
 * `("inputSource" = 'UNAVAILABLE' OR "inputSourceRef" IS NOT NULL)`, and its
 * three siblings.
 *
 * DELIBERATELY NOT the same code as the range check above, even though ONE
 * database CHECK carries both. They are two different mistakes with two
 * different fixes — a price that is out of range, and a price whose provenance
 * was dropped — and the CHECK reports only its own name for either.
 */
export const RATE_PROVENANCE_MISSING = "providers.write.rate_provenance_missing";

/** A value outside the `ModelRateSource` enum reached a rate-source column. */
export const RATE_SOURCE_UNKNOWN = "providers.write.rate_source_unknown";

/**
 * `Model.contextWindow` and `Model.maxOutputTokens` are PostgreSQL `INTEGER`.
 *
 * A catalogue that publishes a context window in BYTES rather than tokens, or a
 * `maxOutputTokens` of `Infinity` coerced from a missing field, both reach the
 * driver as values the column cannot hold.
 */
export const MODEL_INTEGER_OUT_OF_RANGE = "providers.write.model_integer_out_of_range";

/** A `Date` the `TIMESTAMP(3)` column cannot hold — `Invalid Date`, or out of range. */
export const INSTANT_NOT_REPRESENTABLE = "providers.write.instant_not_representable";

/** `pageProviderKeys` was handed a window the driver's `skip`/`take` refuses. */
export const PAGE_WINDOW_INVALID = "providers.write.page_window_invalid";

export class ProvidersWriteRefused extends Error {
  readonly code: string;
  readonly column: string;

  constructor(code: string, column: string, message: string) {
    super(message);
    this.name = "ProvidersWriteRefused";
    this.code = code;
    this.column = column;
  }
}

/**
 * Every identifier column on these four rows is `@db.Uuid`, and PostgreSQL
 * PARSES the value rather than storing the bytes it was given.
 *
 * The pattern is the canonical 8-4-4-4-12 hexadecimal form, case-insensitively.
 * `uuid_in` also accepts a braced and a `urn:uuid:` form, and both are refused
 * here deliberately: the column would store the UNWRAPPED value, so a later read
 * would not compare equal to the string the caller wrote, and `findProviderKey`
 * would miss a row it had just inserted.
 *
 * `Model.key`, `ProviderKey.provider` and `EnvironmentProvider.providerId` are
 * NOT uuid columns and are not checked here. They are `TEXT`, and a guard
 * demanding a shape of them would be stricter than the schema — the drift that
 * only ever shows up in production as a refusal nobody can explain.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export function requireUuid(column: string, value: string): string {
  if (!UUID.test(value)) {
    throw new ProvidersWriteRefused(
      IDENTIFIER_NOT_UUID,
      column,
      `${column} is a uuid column; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** The `Decimal(24, 12)` domain, in the pico-USD integers `TokenRate` holds. */
const MAX_PICO_USD = 10n ** 24n - 1n;

/**
 * One rate, judged against the COLUMN rather than against the brand.
 *
 * `domain/rate.ts`'s `tokenRate()` applies exactly this rule, and the adapter is
 * handed the resulting value rather than the constructor — so the only thing
 * that reached the checker is a structural `{ picoUsdPerToken: bigint }`.
 */
export function requireRateInDomain(column: string, picoUsdPerToken: bigint): bigint {
  if (typeof picoUsdPerToken !== "bigint" || picoUsdPerToken < 0n || picoUsdPerToken > MAX_PICO_USD) {
    throw new ProvidersWriteRefused(
      RATE_OUT_OF_DOMAIN,
      column,
      `${column} must be a non-negative rate inside the Decimal(24, 12) domain; received ${String(
        picoUsdPerToken,
      )}`,
    );
  }
  return picoUsdPerToken;
}

/**
 * A rate's provenance, judged the way the CHECK judges it.
 *
 * The rule is one-directional and that matters: a KNOWN rate must name where it
 * was read from, and an `UNAVAILABLE` one MAY still carry a reference. Demanding
 * that an unavailable rate's reference be null would be stricter than the
 * database, which is the direction a constraints suite cannot see.
 */
export function requireRateProvenance(column: string, source: string, sourceRef: string | null): void {
  if (source !== "UNAVAILABLE" && sourceRef === null) {
    throw new ProvidersWriteRefused(
      RATE_PROVENANCE_MISSING,
      column,
      `${column} is ${source} and must name the source it was read from`,
    );
  }
}

/**
 * The `ModelRateSource` enum, spelled here as the WRITE side's copy.
 *
 * `RATE_SOURCES` in `domain/price-card.ts` is the same list and is the one this
 * check is derived from — passed in by the caller rather than duplicated, so the
 * two cannot drift.
 */
export function requireRateSource(column: string, value: string, known: readonly string[]): string {
  if (!known.includes(value)) {
    throw new ProvidersWriteRefused(
      RATE_SOURCE_UNKNOWN,
      column,
      `${column} must be one of ${known.join(", ")}; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** PostgreSQL `INTEGER`. `Model`'s two token counts are both one. */
const INTEGER_MAX = 2_147_483_647;
const INTEGER_MIN = -2_147_483_648;

export function requireModelIntegerOrNull(column: string, value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < INTEGER_MIN || value > INTEGER_MAX) {
    throw new ProvidersWriteRefused(
      MODEL_INTEGER_OUT_OF_RANGE,
      column,
      `${column} must be a whole number the INTEGER column can hold; received ${String(value)}`,
    );
  }
  return value;
}

/**
 * A `Date` the column can hold.
 *
 * `new Date("nonsense")` is a `Date`, satisfies the port's type, is stored by
 * the in-memory double without complaint, and reaches the driver as `NaN`. The
 * check names the column, so an operator reading the refusal knows which of a
 * card's four `observedAt` instants was the bad one.
 */
export function requireInstant(column: string, value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ProvidersWriteRefused(
      INSTANT_NOT_REPRESENTABLE,
      column,
      `${column} must be a valid instant; received ${String(value)}`,
    );
  }
  return value;
}

/** The same check where the column is nullable. */
export function requireInstantOrNull(column: string, value: Date | null): Date | null {
  return value === null ? null : requireInstant(column, value);
}

/**
 * The page window `pageProviderKeys` is handed.
 *
 * It is checked rather than trusted because it reaches `skip` and `take`, and
 * the port's signature says `number`. `read-provider-keys.ts` clamps before it
 * gets here, and that is exactly why the check belongs here too: a second caller
 * of the port has no such clamp, and a negative `take` is a driver error rather
 * than an empty page.
 */
export function requirePageWindow(limit: number, offset: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new ProvidersWriteRefused(
      PAGE_WINDOW_INVALID,
      "limit",
      `limit must be a positive whole number; received ${String(limit)}`,
    );
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ProvidersWriteRefused(
      PAGE_WINDOW_INVALID,
      "offset",
      `offset must be a non-negative whole number; received ${String(offset)}`,
    );
  }
}

// --- what PostgreSQL refuses, named -----------------------------------------
//
// THE SAVEPOINT IS NOT TIDINESS, and `agents-guards.ts` measured why one store
// over: a statement that violates a constraint inside an interactive transaction
// ABORTS that transaction, every later statement fails, and the COMMIT the
// client sends is executed as a ROLLBACK with no error. So a store that caught a
// unique violation and returned `err(providerKeyAlreadyExists(...))` — which is
// exactly what `InMemoryProvidersRepository` does — would hand the caller a
// business outcome while silently discarding the writes it had already made.
//
// ON THIS PORT THAT IS NOT HYPOTHETICAL. `insertProviderKey` in
// `application/provider-key-store.ts` DEMOTES the incumbent default and THEN
// inserts, both inside one `UnitOfWork.run`. Without a savepoint, an insert
// refused by the label index would return the port's own conflict error and
// leave the incumbent demoted — an environment with no default key for that
// provider, produced by an operation that reported a clean refusal.
//
// A REFUSAL THIS MODULE DOES NOT RECOGNISE IS RETHROWN. A rejected promise is a
// defect (the port's own header says so), and turning an unrecognised SQLSTATE
// into a domain error would file every future constraint under one code nothing
// can tell apart.

/** PostgreSQL SQLSTATEs this store recognises, by name rather than by digit. */
export const UNIQUE_VIOLATION = "23505";
export const FOREIGN_KEY_VIOLATION = "23503";
export const CHECK_VIOLATION = "23514";

// THE SAME REFUSAL REACHES THIS ADAPTER IN THREE SHAPES, read off a real
// container rather than guessed, and `agents-guards.ts` records the same three:
// a delegate call whose violation the client KNOWS carries `code` `P2002`/`P2003`
// with `meta.target`; one it does not carries the driver's `PostgresError { code,
// message }` inside the message text, which is how EVERY rule the migrations
// install arrives; a raw statement carries `code` `P2010` with `meta` holding
// the pair directly.
const SQLSTATE_PATTERN = /PostgresError \{ code: "([0-9A-Z]{5})"/u;
const RAISED_MESSAGE_PATTERN = /PostgresError \{ code: "[0-9A-Z]{5}", message: "([^"]*)"/u;

function textOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function metaOf(error: unknown): Readonly<Record<string, unknown>> {
  if (typeof error !== "object" || error === null) return {};
  const meta = (error as { readonly meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return {};
  return meta as Readonly<Record<string, unknown>>;
}

/** The SQLSTATE behind a client error, in whichever of the three shapes it came. */
export function sqlstateOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  if (code === "P2002") return UNIQUE_VIOLATION;
  if (code === "P2003") return FOREIGN_KEY_VIOLATION;
  const raw = metaOf(error)["code"];
  if (typeof raw === "string") return raw;
  return SQLSTATE_PATTERN.exec(textOf(error))?.[1] ?? null;
}

/** The message a migration's rule raised, when the refusal came from one. */
export function raisedMessageOf(error: unknown): string {
  const raw = metaOf(error)["message"];
  if (typeof raw === "string") return raw;
  return RAISED_MESSAGE_PATTERN.exec(textOf(error))?.[1] ?? "";
}

/**
 * True when a refusal names this constraint, index or column tuple.
 *
 * `meta.target` is the COLUMN LIST for a known unique violation —
 * `["environmentId", "provider", "label"]`, not the index name — so both
 * spellings are matched. `ProviderKey` carries THREE unique indexes and the
 * distinction is load-bearing here: the three-column label index and the partial
 * one-default index are two different refusals with two different fixes.
 */
export function namesConstraint(error: unknown, constraint: string): boolean {
  const target = metaOf(error)["target"];
  if (typeof target === "string" && target === constraint) return true;
  if (Array.isArray(target) && target.join(",") === constraint) return true;
  return `${textOf(error)} ${raisedMessageOf(error)}`.includes(constraint);
}

let savepoints = 0;

/** What a savepointed statement answers: a value, or a classified refusal. */
export type Refusable<Value, Refusal> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly refusal: Refusal };

/** The narrow slice of a transaction client a savepoint needs. */
export interface SavepointClient {
  $executeRawUnsafe(query: string): Promise<number>;
}

/**
 * Run one refusable statement so its refusal costs the caller's transaction
 * nothing else.
 *
 * `classify` decides which refusals are OUTCOMES; it answers `null` for anything
 * it does not recognise, and an unrecognised refusal is rethrown with the
 * savepoint already rolled back — so a defect still reaches the caller as a
 * rejected promise and still rolls the whole transaction back.
 *
 * ITS OWN COUNTER AND ITS OWN PREFIX, rather than `agents-guards.ts`'s. A
 * savepoint name is the only thing a server log carries about which store opened
 * it, and two stores sharing one counter would make `agents_sp_41` a name that
 * could have come from either.
 *
 * THREE STATEMENTS, NOT ONE. `SAVEPOINT`, the write, and then `RELEASE
 * SAVEPOINT` or `ROLLBACK TO SAVEPOINT`. That cost is on WRITES only and is
 * pinned as such; the reads this package measures for N+1 are untouched by it.
 */
export async function providersRefusable<Value, Refusal>(
  client: SavepointClient,
  work: () => Promise<Value>,
  classify: (error: unknown) => Refusal | null,
): Promise<Refusable<Value, Refusal>> {
  savepoints += 1;
  const name = `providers_sp_${savepoints}`;
  await client.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const value = await work();
    await client.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (error) {
    await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    const refusal = classify(error);
    if (refusal === null) throw error;
    return { ok: false, refusal };
  }
}
