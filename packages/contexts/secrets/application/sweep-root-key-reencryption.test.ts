// The sweep: bounded, resumable, idempotent, and never "complete" while a
// credential is still owed a rewrap.

import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { canRemoveRootKey } from "../domain/key-ring.js";
import { createCredential } from "./create-credential.js";
import { reportRootKeyUsage } from "./describe-credentials.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { readSecret } from "./read-secret.js";
import { revokeCredential } from "./revoke-credential.js";
import { SWEEP_HARD_LIMIT, sweepRootKeyReEncryption } from "./sweep-root-key-reencryption.js";

let context: InMemorySecrets;
let grants: InMemoryGrants;

/** `n` credentials, names zero-padded so the name order is the numeric order. */
async function seed(count: number): Promise<readonly string[]> {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `KEY_${String(index).padStart(3, "0")}`;
    names.push(name);
    unwrap(
      await createCredential(context.dependencies, {
        authorization: grants.operator,
        name,
        plaintext: `sk-live-${index}`,
      }),
    );
  }
  return names;
}

function sweep(command: Parameters<typeof sweepRootKeyReEncryption>[1] extends infer C ? Partial<C> : never = {}) {
  return sweepRootKeyReEncryption(context.dependencies, {
    authorization: grants.operator,
    ...command,
  });
}

beforeEach(() => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
});

describe("what a sweep moves", () => {
  it("moves every credential onto the active key and reports the environment complete", async () => {
    await seed(3);
    context.keyRing.rotateTo(2);

    const report = unwrap(await sweep());
    expect(report).toMatchObject({
      activeRootKeyVersion: 2,
      examined: 3,
      reEncrypted: 3,
      alreadyActive: 0,
      nextCursor: null,
      complete: true,
    });
    expect(report.skipped).toEqual([]);
  });

  it("preserves every plaintext across the move", async () => {
    const names = await seed(3);
    context.keyRing.rotateTo(2);
    await sweep();

    for (const [index, name] of names.entries()) {
      const material = unwrap(
        await readSecret(context.dependencies, { authorization: grants.runtime, name }),
      );
      expect(material.reveal()).toBe(`sk-live-${index}`);
    }
  });

  it("does NOT free the prior root key on its own — a purge still has to run", async () => {
    // WRITTEN THE OTHER WAY ROUND FIRST, AND THE RULE SAID NO. The obvious claim
    // is "sweep the environment and the old key can go", and it is false:
    // `countVersionsByRootKey` counts UNPURGED versions, a re-encryption RETIRES
    // the row it replaces rather than deleting it, and `canRemoveRootKey` is
    // false while any unpurged row still names the version. So the sweep moves
    // every ACTIVE envelope and the retired ones stay behind until
    // `purgeRetiredSecretVersions` destroys them.
    //
    // That is the correct design and it is worth pinning rather than working
    // around: `secret-version.ts` calls `readableUntil` a "PURGE-DEFERRAL
    // window", so retiring and destroying are deliberately two steps with an
    // operator-chosen gap. A test that asserted the key was free would have been
    // asserting that the gap does not exist.
    await seed(3);
    context.keyRing.rotateTo(2);
    const before = unwrap(await reportRootKeyUsage(context.dependencies, grants.rootKeyOperator));
    expect(canRemoveRootKey(before, 1 as never)).toBe(false);

    const report = unwrap(await sweep());
    expect(report.complete).toBe(true);

    const after = unwrap(await reportRootKeyUsage(context.dependencies, grants.rootKeyOperator));
    // Still false — and the count is the reason, so this cannot pass for the
    // wrong reason. Three retired v1 rows, three active v2 rows.
    expect(canRemoveRootKey(after, 1 as never)).toBe(false);
    const byVersion = new Map(after.usage.map((row) => [row.rootKeyVersion as number, row.unpurgedVersionCount]));
    expect(byVersion.get(1)).toBe(3);
    expect(byVersion.get(2)).toBe(3);
  });

  it("is a no-op that reports success when nothing is owed", async () => {
    // IDEMPOTENCE. Running a sweep over ground it has covered writes no row and
    // still reports complete, which is what makes a scheduled job safe to leave
    // running after the rotation is done.
    await seed(3);
    context.keyRing.rotateTo(2);
    await sweep();
    const audits = context.store.allAudits().length;

    const second = unwrap(await sweep());
    expect(second).toMatchObject({ examined: 3, reEncrypted: 0, alreadyActive: 3, complete: true });
    expect(context.store.allAudits()).toHaveLength(audits);
  });

  it("examines a credential that never needed moving without re-encrypting it", async () => {
    // No rotation at all: every envelope is already on the active key.
    await seed(2);
    const report = unwrap(await sweep());
    expect(report).toMatchObject({ examined: 2, reEncrypted: 0, alreadyActive: 2, complete: true });
  });
});

describe("the sweep is bounded and resumable", () => {
  it("stops at the limit and hands back a cursor", async () => {
    await seed(5);
    context.keyRing.rotateTo(2);

    const first = unwrap(await sweep({ limit: 2 }));
    expect(first).toMatchObject({ examined: 2, reEncrypted: 2, complete: false });
    expect(first.nextCursor).toBe("KEY_001");
  });

  it("resumes strictly after the cursor and never repeats a credential", async () => {
    await seed(5);
    context.keyRing.rotateTo(2);

    const first = unwrap(await sweep({ limit: 2 }));
    const second = unwrap(await sweep({ limit: 2, afterName: first.nextCursor }));
    const third = unwrap(await sweep({ limit: 2, afterName: second.nextCursor }));

    expect(second).toMatchObject({ examined: 2, reEncrypted: 2, complete: false });
    expect(second.nextCursor).toBe("KEY_003");
    expect(third).toMatchObject({ examined: 1, reEncrypted: 1, nextCursor: null, complete: true });

    // FIVE rewraps across three calls and not one more. A cursor that resumed AT
    // rather than AFTER would re-encrypt KEY_001 and KEY_003 a second time, and
    // the audit trail is where that shows.
    expect(context.store.allAudits().filter((row) => row.action === "REWRAP")).toHaveLength(5);
  });

  it("commits each credential separately, so a resume keeps the work already done", async () => {
    // The durability property, stated as a fact about the store rather than
    // about the report: after a bounded batch the moved credentials are ON the
    // new key in the store, with no sweep-wide transaction left open to lose.
    await seed(4);
    context.keyRing.rotateTo(2);
    await sweep({ limit: 2 });

    const usage = unwrap(await reportRootKeyUsage(context.dependencies, grants.rootKeyOperator));
    const byVersion = new Map(usage.usage.map((row) => [row.rootKeyVersion as number, row.unpurgedVersionCount]));
    // Two moved (each leaving a retired v1 row behind) and two not yet.
    expect(byVersion.get(2)).toBe(2);
    expect(byVersion.get(1)).toBe(4);
  });

  it("clamps a limit above the hard maximum rather than honouring it", async () => {
    // FOUND BY A SURVIVING MUTANT. This case first seeded TWO credentials and
    // asked for a thousand, and its own comment admitted the clamp was "not
    // observable in `examined`" — which is another way of saying the assertion
    // could not fail. Deleting `Math.min` passed it.
    //
    // So it seeds one MORE than the hard limit. `examined` is then 50 with the
    // clamp and 51 without, and the difference is the only thing separating a
    // bounded batch from an unbounded rewrap of an environment.
    await seed(SWEEP_HARD_LIMIT + 1);
    context.keyRing.rotateTo(2);

    const report = unwrap(await sweep({ limit: SWEEP_HARD_LIMIT + 1_000 }));
    expect(report.examined).toBe(SWEEP_HARD_LIMIT);
    expect(report.reEncrypted).toBe(SWEEP_HARD_LIMIT);
    // And the batch is honest about not being finished, so the caller comes back.
    expect(report.complete).toBe(false);
    expect(report.nextCursor).toBe(`KEY_${String(SWEEP_HARD_LIMIT - 1).padStart(3, "0")}`);
  });

  it("refuses a limit that is not a positive integer", async () => {
    for (const limit of [0, -1, 1.5]) {
      const refused = await sweep({ limit });
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("INVALID_PURGE_REQUEST");
    }
  });
});

describe("a credential the sweep cannot move", () => {
  it("skips a revoked credential as already-done rather than as a failure", async () => {
    // A revoked credential has no envelope to move and is not a defect. Counting
    // it as a SKIP would keep the environment permanently incomplete over a row
    // that is behaving exactly as designed.
    const names = await seed(2);
    unwrap(
      await revokeCredential(context.dependencies, {
        authorization: grants.operator,
        credentialId: unwrap(
          await createCredential(context.dependencies, {
            authorization: grants.operator,
            name: "REVOKED_KEY",
            plaintext: "sk-live-gone",
          }),
        ).id,
      }),
    );
    context.keyRing.rotateTo(2);

    const report = unwrap(await sweep());
    expect(report.examined).toBe(names.length + 1);
    expect(report.reEncrypted).toBe(2);
    expect(report.alreadyActive).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it("records a failure, carries on, and refuses to call the sweep complete", async () => {
    // The key that sealed KEY_001 is taken OUT of the ring, so its envelope
    // cannot be opened at all — the fail-closed path `domain/key-ring.ts` calls
    // `absent`. The two credentials either side of it must still move.
    await seed(3);
    // Seal KEY_001 under a version that will disappear: rotate to 2, move only
    // that one credential onto 2, then rotate to 3 and drop 2 from the ring.
    context.keyRing.rotateTo(2);
    unwrap(await sweep({ limit: 1, afterName: "KEY_000" }));
    context.keyRing.rotateTo(3);
    context.keyRing.retireVersion(2);

    const report = unwrap(await sweep());
    expect(report.examined).toBe(3);
    expect(report.reEncrypted).toBe(2);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    // COMPLETE IS FALSE EVEN THOUGH THE BATCH REACHED THE END. A caller looping
    // until `complete` therefore never concludes the environment is on one key
    // while a credential is stranded — and `canRemoveRootKey` agrees.
    expect(report.nextCursor).toBeNull();
    expect(report.complete).toBe(false);
  });

  it("reports the failure's CODE and never its reason or its envelope", async () => {
    await seed(1);
    context.keyRing.rotateTo(2);
    unwrap(await sweep());
    context.keyRing.rotateTo(3);
    context.keyRing.retireVersion(2);

    const report = unwrap(await sweep());
    expect(report.skipped).toHaveLength(1);
    // `domain/errors.ts` keeps the distinguishing reason in `details`, which it
    // documents as "never returned to a client", and an operator reading this
    // report through an API is a client. The skip carries two fields and no more.
    expect(Object.keys(report.skipped[0] as object).sort()).toEqual(["code", "credentialId"]);
  });
});

describe("who may run a sweep", () => {
  it("refuses a read-only operator grant", async () => {
    await seed(1);
    const refused = await sweepRootKeyReEncryption(context.dependencies, {
      authorization: grants.readOnlyOperator,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("CREDENTIAL_FORBIDDEN");
  });

  it("accepts an operator grant, which may NOT read a secret out of the vault", async () => {
    // The asymmetry this use case rests on. `readSecret` demands the RUNTIME
    // tier — "operators administer the vault; they do not read out of it" — and
    // a sweep is administration: the material is opened and re-sealed inside the
    // boundary and never becomes a value the caller holds.
    await seed(1);
    context.keyRing.rotateTo(2);
    expect((await sweep()).ok).toBe(true);

    const denied = await readSecret(context.dependencies, {
      authorization: grants.operator as never,
      name: "KEY_000",
    });
    expect(denied.ok).toBe(false);
  });

  it("sweeps only the granted environment", async () => {
    // A second environment's credentials must be invisible: the sweep asks the
    // repository for ONE environment's list and the grant is what names it.
    await seed(2);
    const otherGrants = inMemoryGrants("2");
    unwrap(
      await createCredential(context.dependencies, {
        authorization: otherGrants.operator,
        name: "OTHER_KEY",
        plaintext: "sk-live-other",
      }),
    );
    context.keyRing.rotateTo(2);

    const report = unwrap(await sweep());
    expect(report.examined).toBe(2);
    expect(report.reEncrypted).toBe(2);
  });
});
