/**
 * One tenant with two people in it, seeded across all four stores.
 *
 * The corpus exists because "0 discovered, 0 deleted, verified" passes whether
 * discovery works or not. Every executor in this module had only ever been
 * exercised against a subject with nothing in the store, which is the one
 * fixture that cannot tell a working sweep from one looking in the wrong place.
 *
 * Two properties are built into the shape rather than asserted by one test:
 *
 *   ALICE spans two scopes, three threads, both audit-matching routes (a
 *   canonical `endUserId` and the denormalized id buried in a JSON payload),
 *   four identity handles, three objects in the bucket, and the full set of
 *   Redis keys a live turn leaves behind.
 *
 *   BOB is a bystander in the same organization with the same shape of data.
 *   Every "the sweep found everything" assertion is paired with his rows, keys
 *   and objects surviving — an over-broad WHERE is as much a defect as a
 *   missed one, and only a second person in the fixture can catch it.
 */

import { bucketDouble, database, redisDouble, type Row } from "./erasure-doubles.test-fixture";

export const ORG = "org_acme";

/** Salt for the subject hash and the tombstone register. */
export const CORPUS_SALT = "corpus-test-salt";

export const SCOPES = [
  { organizationId: ORG, projectId: "project_eu", environmentId: "env_eu" },
  { organizationId: ORG, projectId: "project_us", environmentId: "env_us" },
];

export const ALICE = {
  slug: "alice",
  endUserId: "end_user_alice",
  /** The id the erasure is requested under. */
  external: "walle-77",
  slack: "U0ALICE",
  email: "alice@example.com",
  threads: ["thread_eu_1", "thread_eu_2", "thread_us_1"],
  objects: [
    "org_acme/env_eu/thread_eu_1/contract.pdf",
    "org_acme/env_eu/thread_eu_2/passport-scan.png",
    "org_acme/env_us/thread_us_1/voice-note.ogg",
  ],
  /** Free text that must not survive anywhere, in any store. */
  content: "alice's home address",
};

/** A different person in the same tenant. Nothing of theirs may move. */
export const BOB = {
  slug: "bob",
  endUserId: "end_user_bob",
  external: "walle-99",
  threads: ["thread_bob"],
  objects: ["org_acme/env_eu/thread_bob/invoice.pdf"],
  content: "bob's phone number",
};

export const scopeKey = (s: (typeof SCOPES)[number]) =>
  `${s.organizationId}:${s.projectId}:${s.environmentId}`;

/**
 * The keys one person's traffic leaves in Redis.
 *
 * Per thread: the trace envelope, the per-thread cost counter, the two working
 * memory keys and the chat-session cursor. Per scope: the daily cost counter,
 * its reservation sibling and the rate-limit counter — all keyed by the
 * denormalized external id rather than by the end-user uuid, which is why the
 * Redis sweep needs the legacy id and a resume without one cannot certify.
 */
export function subjectRedisKeys(threads: string[], externalId: string): string[] {
  return [
    ...threads.flatMap((t) => [
      `trace:thread:${t}`,
      `cost:thread:${t}`,
      `wm:${t}:messages`,
      `wm:${t}:summary`,
      `chatsess:cursor:session_1:${t}`,
    ]),
    ...SCOPES.flatMap((s) => [
      `cost:user:${scopeKey(s)}:${externalId}:2026-08-20`,
      `cost:user:${scopeKey(s)}:${externalId}:2026-08-20:reserved`,
      `rl:day:${scopeKey(s)}:${externalId}:2026-08-20`,
    ]),
  ];
}

/** Summed floats with no user dimension. Subject-adjacent, never deletable. */
export function aggregateRedisKeys(): string[] {
  return SCOPES.flatMap((s) => [
    `cost:scope:${scopeKey(s)}:2026-08-20`,
    `cost:agent:${scopeKey(s)}:agent_support:2026-08-20`,
  ]);
}

function environmentFor(index: number): string {
  return index === 2 ? "env_us" : "env_eu";
}

function seedPerson(
  db: Row,
  person: typeof ALICE | typeof BOB,
  identities: Array<{ issuer: string; channel: string; subject: string; disabledAt?: Date }>,
) {
  db.endUser.rows.push({ id: person.endUserId, organizationId: ORG });
  for (const [index, identity] of identities.entries()) {
    db.endUserIdentity.rows.push({
      id: `identity_${person.slug}_${index}`,
      endUserId: person.endUserId,
      organizationId: ORG,
      disabledAt: null,
      ...identity,
    });
  }
  for (const [index, id] of person.threads.entries()) {
    db.thread.rows.push({
      id,
      endUserId: person.endUserId,
      environmentId: environmentFor(index),
      title: person.content,
    });
  }
  for (const [index, storageKey] of person.objects.entries()) {
    db.messageAttachment.rows.push({
      id: `attachment_${person.slug}_${index}`,
      endUserId: person.endUserId,
      environmentId: environmentFor(index),
      storageKey,
    });
  }
  db.memory.rows.push(
    { id: `memory_${person.slug}_1`, endUserId: person.endUserId,
      environmentId: "env_eu", content: person.content },
    { id: `memory_${person.slug}_2`, endUserId: person.endUserId,
      environmentId: "env_us", content: person.content },
  );
  db.memoryEntity.rows.push({
    id: `entity_${person.slug}`, endUserId: person.endUserId,
    environmentId: "env_eu", name: person.content,
  });
  db.memoryRelationship.rows.push({
    id: `relationship_${person.slug}`, endUserId: person.endUserId,
    environmentId: "env_eu",
  });
  db.messageRating.rows.push({
    id: `rating_${person.slug}`, endUserId: person.endUserId,
    environmentId: "env_eu", comment: person.content,
  });
  // Canonically keyed, and keyed the legacy way through the JSON payload. Both
  // routes have to be swept; the second is the one a `userId`-blind sweep misses.
  db.toolCallAudit.rows.push(
    { id: `audit_${person.slug}_canonical`, endUserId: person.endUserId,
      environmentId: "env_eu", arguments: { query: person.content }, result: person.content,
      error: null },
    { id: `audit_${person.slug}_legacy`, endUserId: null, environmentId: "env_eu",
      arguments: { __platosAudit: { userId: person.external }, query: person.content },
      result: person.content, error: null },
  );
  db.safetyEvent.rows.push(
    { id: `safety_${person.slug}_canonical`, endUserId: person.endUserId,
      environmentId: "env_eu", metadata: { note: person.content } },
    { id: `safety_${person.slug}_legacy`, endUserId: null, environmentId: "env_eu",
      metadata: { __platosSafety: { userId: person.external }, note: person.content } },
  );
}

/** Postgres, with both people in it. */
export function corpusDatabase(): Row {
  const db = database([
    { id: "env_eu", projectId: "project_eu" },
    { id: "env_us", projectId: "project_us" },
  ]);
  seedPerson(db, ALICE, [
    { issuer: "platos:external", channel: "external", subject: ALICE.external },
    { issuer: "platos", channel: "session", subject: ALICE.external },
    { issuer: "channel:slack:T_ACME", channel: "slack", subject: ALICE.slack },
    // Already disabled, and still an alias the sweep and the register cover.
    { issuer: "email", channel: "email", subject: ALICE.email,
      disabledAt: new Date("2026-08-05T00:00:00.000Z") },
  ]);
  seedPerson(db, BOB, [
    { issuer: "platos:external", channel: "external", subject: BOB.external },
  ]);
  return db;
}

/** Redis, holding both people's keys plus the scope-level rollups. */
export function corpusRedis(): ReturnType<typeof redisDouble> {
  const redis = redisDouble();
  const keys = [
    ...subjectRedisKeys(ALICE.threads, ALICE.external),
    ...subjectRedisKeys(BOB.threads, BOB.external),
    ...aggregateRedisKeys(),
  ];
  for (const key of keys) redis.store.set(`platos:${key}`, "1");
  return redis;
}

/** The bucket, holding both people's attachments. */
export function corpusBucket(): ReturnType<typeof bucketDouble> {
  return bucketDouble(
    Object.fromEntries([...ALICE.objects, ...BOB.objects].map((key) => [key, "bytes"])),
  );
}

/** Keys still in the store, in the logical (unprefixed) form patterns use. */
export function remainingKeys(redis: ReturnType<typeof redisDouble>): string[] {
  return [...redis.store.keys()].map((k) => k.replace(/^platos:/, "")).sort();
}
