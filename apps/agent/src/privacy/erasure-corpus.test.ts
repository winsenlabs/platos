import { beforeEach, describe, expect, it } from "vitest";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { ErasureService } from "./erasure.service";
import { ErasureObjectStore } from "./object-store";
import { isStoreSettled } from "./erasure-receipt";
import { subjectKeyPatterns } from "./redis-keys";
import type { SubjectKeys } from "./subject-graph";
import type { Row } from "./erasure-doubles.test-fixture";
import {
  ALICE, BOB, CORPUS_SALT, ORG, SCOPES,
  aggregateRedisKeys, corpusBucket, corpusDatabase, corpusRedis,
  remainingKeys, subjectRedisKeys,
} from "./erasure-corpus.test-fixture";

/**
 * The object-store and Redis executors, over a subject who actually has data.
 *
 * Every existing test of these two paths runs them against a subject with
 * nothing in either store, so "0 discovered, 0 deleted, verified" passes
 * whether the discovery works or not — and a sweep that finds nothing is
 * indistinguishable from a sweep that looks in the wrong place, which is the
 * defect this whole module exists to fix. So the corpus here is seeded: three
 * threads across two scopes, attachments in the bucket, the full shape of the
 * Redis keyspace a live turn leaves behind, and a bystander in both stores who
 * must come through untouched.
 *
 * The subject is resolved by the real `discoverSubject` rather than
 * hand-written, so the executors are addressed exactly as production addresses
 * them.
 */

describe("the object-store sweep over a seeded bucket", () => {
  let db: Row;
  let bucket: ReturnType<typeof corpusBucket>;
  let service: ErasureService;
  let subject: SubjectKeys;

  beforeEach(async () => {
    process.env.PLATOS_ERASURE_HASH_SALT = CORPUS_SALT;
    db = corpusDatabase();
    bucket = corpusBucket();
    service = new ErasureService(db as any, corpusRedis() as any, bucket as any);
    subject = await service.discoverSubject(ALICE.external, ORG);
  });

  const sweep = () => (service as any).minioExecutor(subject, null);

  it("finds every object the subject owns and empties them from the bucket", async () => {
    const outcome = await sweep();

    expect(outcome).toMatchObject({
      store: "minio",
      status: "done",
      discovered: 3,
      deleted: 3,
      failures: 0,
      verificationStatus: "passed",
    });
    // The bytes, not the call count: an S3 delete succeeds for a key that was
    // never there, so only what the bucket still holds is evidence.
    expect([...bucket.store.keys()]).toEqual(BOB.objects);
  });

  it("does not reach into another person's objects", async () => {
    await sweep();

    expect(bucket.deleted).toEqual(ALICE.objects);
    expect(bucket.store.has(BOB.objects[0]!)).toBe(true);
  });

  it("reports a surviving object instead of the delete that claimed to remove it", async () => {
    // Deleted as far as the call is concerned; still there when probed. This is
    // what a bucket-side failure looks like from the outside, and the receipt
    // has to say so.
    const survivor = ALICE.objects[1]!;
    bucket.state.inconclusive.add(survivor);

    const outcome = await sweep();

    expect(outcome.deleted).toBe(3);
    expect(outcome.verificationStatus).toBe("failed");
    expect(outcome.note).toBe("verified 2/3 objects absent");
    expect(isStoreSettled(outcome)).toBe(false);
  });

  it("counts a delete that raised, and still refuses to certify it", async () => {
    bucket.state.deleteFails.add(ALICE.objects[0]!);

    const outcome = await sweep();

    expect(outcome).toMatchObject({
      status: "failed",
      discovered: 3,
      deleted: 2,
      failures: 1,
      verificationStatus: "failed",
    });
    // The object it could not delete is still in the bucket, which is precisely
    // why the verification must not pass.
    expect(bucket.store.has(ALICE.objects[0]!)).toBe(true);
  });

  it("says the store is absent rather than clean when no client is wired", async () => {
    bucket.state.available = false;

    await expect(sweep()).resolves.toMatchObject({
      status: "not_provisioned",
      discovered: 0,
      note: "no object-store client wired",
    });
    // Nothing was probed, so nothing may be claimed — and the objects are
    // still there to prove the difference matters.
    expect(bucket.store.size).toBe(4);
  });
});

describe("the object-store client's own existence probe", () => {
  /**
   * The real ErasureObjectStore over a substitute transport.
   *
   * Only the AWS client is replaced. The behaviour under test is this class's
   * error classification — 404 means absent, anything else means STILL PRESENT
   * — which is the one place in the object path where an ambiguous answer could
   * be rounded down into a false certificate of deletion.
   */
  function objectStore(send: (command: unknown) => Promise<unknown>): ErasureObjectStore {
    process.env.MINIO_ENDPOINT = "http://minio.test:9000";
    process.env.MINIO_ACCESS_KEY = "access";
    process.env.MINIO_SECRET_KEY = "secret";
    const store = new ErasureObjectStore();
    (store as any).client = { send };
    return store;
  }

  const probing = (respond: () => Promise<unknown>) =>
    objectStore(async (command) => {
      if (command instanceof HeadObjectCommand) return respond();
      return {};
    });

  it("reports an object that HEADs successfully as present", async () => {
    await expect(probing(async () => ({ ContentLength: 12 })).objectExists("k")).resolves.toBe(true);
  });

  it("reports 404 and NotFound as absent", async () => {
    const notFoundStatus = probing(async () => {
      throw Object.assign(new Error("nope"), { $metadata: { httpStatusCode: 404 } });
    });
    const notFoundName = probing(async () => {
      throw Object.assign(new Error("nope"), { name: "NotFound" });
    });

    await expect(notFoundStatus.objectExists("k")).resolves.toBe(false);
    await expect(notFoundName.objectExists("k")).resolves.toBe(false);
  });

  it("treats an inconclusive probe as still present", async () => {
    // 403 is the dangerous one: the object may well be there, and a client that
    // read "not visible to me" as "gone" would certify an erasure it never
    // performed.
    const denied = probing(async () => {
      throw Object.assign(new Error("denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });
    });
    const severed = probing(async () => {
      throw new Error("socket hang up");
    });

    await expect(denied.objectExists("k")).resolves.toBe(true);
    await expect(severed.objectExists("k")).resolves.toBe(true);
  });
});

describe("the Redis sweep over a seeded keyspace", () => {
  let db: Row;
  let redis: ReturnType<typeof corpusRedis>;
  let service: ErasureService;
  let subject: SubjectKeys;

  beforeEach(async () => {
    process.env.PLATOS_ERASURE_HASH_SALT = CORPUS_SALT;
    db = corpusDatabase();
    redis = corpusRedis();
    service = new ErasureService(db as any, redis as any);
    subject = await service.discoverSubject(ALICE.external, ORG);
  });

  const sweep = () => (service as any).redisExecutor(subject, null);

  it("finds every key the subject's traffic left behind", async () => {
    const expected = subjectRedisKeys(ALICE.threads, ALICE.external);

    const outcome = await sweep();

    // 3 threads x 5 keys + 2 scopes x 3 counters. A discovery that quietly
    // resolved nothing would report 0 here and still call itself verified.
    expect(expected).toHaveLength(21);
    expect(outcome).toMatchObject({
      store: "redis",
      status: "done",
      discovered: 21,
      deleted: 21,
      failures: 0,
      verificationStatus: "passed",
    });
    // Sixteen patterns found twenty-one keys, so the wildcard forms — the
    // working-memory keys and the chat-session cursors — matched rather than
    // being scanned for literally.
    expect(subjectKeyPatterns({
      threadIds: ALICE.threads,
      legacyUserIds: [ALICE.external],
      platosEndUserIds: [ALICE.endUserId],
      scopes: SCOPES,
    })).toHaveLength(16);
  });

  it("deletes the subject's keys and nobody else's", async () => {
    await sweep();

    // What is LEFT is the assertion. Bob's traffic and the scope-level rollups
    // both survive; the rollups because a single person's contribution cannot
    // be subtracted from a summed float, and they carry no personal data.
    expect(remainingKeys(redis)).toEqual(
      [...subjectRedisKeys(BOB.threads, BOB.external), ...aggregateRedisKeys()].sort(),
    );
  });

  it("addresses del() in the form ioredis expects, and the keys are gone", async () => {
    // THE FOOTGUN. keys() returns "platos:wm:…" and del() prefixes again, so
    // handing a scan result straight back deletes "platos:platos:wm:…" — which
    // matches nothing and reports success. Both halves are asserted: that the
    // subject's keys are actually gone from the keyspace, and that nothing was
    // addressed in the already-prefixed form that produces the bug. The first
    // is what fails if the stripping is removed; the second says why.
    await sweep();

    const subjectKeysRemaining = remainingKeys(redis).filter((k) =>
      subjectRedisKeys(ALICE.threads, ALICE.external).includes(k),
    );
    expect(subjectKeysRemaining).toEqual([]);
    expect(redis.deleteTargets.filter((k) => k.startsWith("platos:"))).toEqual([]);
    expect(redis.deleteTargets).toHaveLength(21);
  });

  it("refuses to certify a key that a successful delete did not remove", async () => {
    // Exactly the shape of the double-prefix bug from the store's side: del
    // reports success, the key stays. Verification re-reads on the wire rather
    // than trusting the delete, so it catches it.
    const ignored = `wm:${ALICE.threads[0]}:messages`;
    redis.state.silentlyIgnores.add(ignored);

    const outcome = await sweep();

    expect(outcome.deleted).toBe(21);
    expect(outcome.verificationStatus).toBe("failed");
    expect(outcome.note).toContain("1 survivors");
    expect(isStoreSettled(outcome)).toBe(false);
    expect(redis.store.has(`platos:${ignored}`)).toBe(true);
  });

  it("counts a delete that raised and leaves the store unsettled", async () => {
    redis.state.undeletable.add(`trace:thread:${ALICE.threads[1]}`);

    const outcome = await sweep();

    expect(outcome).toMatchObject({ status: "failed", deleted: 20, failures: 1 });
    expect(isStoreSettled(outcome)).toBe(false);
  });

  it("does not report a keyspace it could not scan as clean", async () => {
    const before = remainingKeys(redis);
    redis.state.scanFails = true;

    const outcome = await sweep();

    // Sixteen patterns, sixteen failed scans. Nothing was deleted and nothing
    // may be claimed: the operation stays open for a later pass.
    expect(outcome).toMatchObject({ status: "failed", discovered: 0, deleted: 0, failures: 16 });
    expect(isStoreSettled(outcome)).toBe(false);
    expect(remainingKeys(redis)).toEqual(before);
  });
});
