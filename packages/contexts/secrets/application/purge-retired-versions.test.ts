import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { secretMaterial } from "../domain/secret-material.js";

import type { CredentialId } from "../domain/ids.js";
import { createCredential } from "./create-credential.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { PURGE_RETIRED_HARD_LIMIT, purgeRetiredSecretVersions } from "./purge-retired-versions.js";
import { rotateCredential } from "./rotate-credential.js";

const HOUR = 60 * 60 * 1_000;

let context: InMemorySecrets;
let grants: InMemoryGrants;
let credentialId: CredentialId;

beforeEach(async () => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
  credentialId = unwrap(
    await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: secretMaterial("sk-live-1"),
    }),
  ).id;
});

async function rotate(plaintext: string, readableUntil?: Date): Promise<void> {
  unwrap(
    await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId,
      plaintext: secretMaterial(plaintext),
      ...(readableUntil === undefined ? {} : { readableUntil }),
    }),
  );
}

describe("purging is installation-scoped, bounded and evidenced", () => {
  it("DENIES every environment-scoped grant", async () => {
    for (const authorization of [grants.operator, grants.runtime, grants.service]) {
      const denied = await purgeRetiredSecretVersions(context.dependencies, {
        authorization: authorization as never,
        cutoff: context.clock.now(),
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("CREDENTIAL_FORBIDDEN");
    }
  });

  it("destroys only retired, past-cutoff, non-active envelopes", async () => {
    await rotate("sk-live-2");
    context.clock.advance(HOUR);
    const report = unwrap(
      await purgeRetiredSecretVersions(context.dependencies, {
        authorization: grants.rootKeyOperator,
        cutoff: context.clock.now(),
      }),
    );
    expect(report.purgedCount).toBe(1);
    const remaining = context.store.allVersions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.secretRevision).toBe(2);
  });

  it("leaves an envelope alone while its retention window has not expired", async () => {
    const readableUntil = new Date(context.clock.now().getTime() + 10 * HOUR);
    await rotate("sk-live-2", readableUntil);
    context.clock.advance(HOUR);
    const report = unwrap(
      await purgeRetiredSecretVersions(context.dependencies, {
        authorization: grants.rootKeyOperator,
        cutoff: context.clock.now(),
      }),
    );
    expect(report.purgedCount).toBe(0);
    expect(context.store.allVersions()).toHaveLength(2);
  });

  it("records one metadata-only PURGE audit per destroyed envelope", async () => {
    await rotate("sk-live-2");
    context.clock.advance(HOUR);
    await purgeRetiredSecretVersions(context.dependencies, {
      authorization: grants.rootKeyOperator,
      cutoff: context.clock.now(),
    });
    const purges = context.store.allAudits().filter((row) => row.action === "PURGE");
    expect(purges).toHaveLength(1);
    expect(purges[0]).toMatchObject({ actorType: "operations", secretRevision: 1 });
    expect(JSON.stringify(purges)).not.toContain("sk-live-1");
  });

  it("refuses a cutoff in the future rather than destroying fresh envelopes", async () => {
    await rotate("sk-live-2");
    const refused = await purgeRetiredSecretVersions(context.dependencies, {
      authorization: grants.rootKeyOperator,
      cutoff: new Date(context.clock.now().getTime() + HOUR),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("INVALID_PURGE_REQUEST");
      expect(refused.error.details).toMatchObject({ reason: "cutoff_in_the_future" });
    }
    expect(context.store.allVersions()).toHaveLength(2);
  });

  it.each([0, -5, 2.5])("refuses a limit of %s", async (limit) => {
    const refused = await purgeRetiredSecretVersions(context.dependencies, {
      authorization: grants.rootKeyOperator,
      cutoff: context.clock.now(),
      limit,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INVALID_PURGE_REQUEST");
  });

  it("clamps an oversized batch to the hard maximum instead of honouring it", async () => {
    for (let index = 2; index <= 6; index += 1) {
      await rotate(`sk-live-${index}`);
      context.clock.advance(1_000);
    }
    context.clock.advance(HOUR);
    const report = unwrap(
      await purgeRetiredSecretVersions(context.dependencies, {
        authorization: grants.rootKeyOperator,
        cutoff: context.clock.now(),
        limit: PURGE_RETIRED_HARD_LIMIT * 10,
      }),
    );
    expect(report.purgedCount).toBe(5);
    expect(context.store.allVersions()).toHaveLength(1);
  });

  it("honours a smaller explicit batch and purges oldest first", async () => {
    for (let index = 2; index <= 4; index += 1) {
      await rotate(`sk-live-${index}`);
      context.clock.advance(1_000);
    }
    context.clock.advance(HOUR);
    const report = unwrap(
      await purgeRetiredSecretVersions(context.dependencies, {
        authorization: grants.rootKeyOperator,
        cutoff: context.clock.now(),
        limit: 2,
      }),
    );
    expect(report.purgedCount).toBe(2);
    expect(
      context.store
        .allVersions()
        .map((entry) => entry.secretRevision)
        .sort((left, right) => left - right),
    ).toEqual([3, 4]);
  });

  it("rolls the whole batch back when one audit row cannot be written", async () => {
    await rotate("sk-live-2");
    context.clock.advance(HOUR);
    context.store.failNextAudit();
    const failed = await purgeRetiredSecretVersions(context.dependencies, {
      authorization: grants.rootKeyOperator,
      cutoff: context.clock.now(),
    });
    expect(failed.ok).toBe(false);
    expect(context.store.allVersions()).toHaveLength(2);
  });
});
