import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { canRemoveRootKey } from "../domain/key-ring.js";
import type { CredentialId, RootKeyVersion } from "../domain/ids.js";
import { createCredential } from "./create-credential.js";
import { reportRootKeyUsage } from "./describe-credentials.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { purgeRetiredSecretVersions } from "./purge-retired-versions.js";
import { readSecret } from "./read-secret.js";
import { reEncryptCredential } from "./re-encrypt-credential.js";

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
      plaintext: "sk-live-1",
    }),
  ).id;
});

describe("re-encryption moves the key without moving the secret", () => {
  it("keeps the revision and changes the root key version", async () => {
    context.keyRing.rotateTo(2);
    const moved = unwrap(
      await reEncryptCredential(context.dependencies, {
        authorization: grants.operator,
        credentialId,
      }),
    );
    expect(moved.activeSecretVersion).toMatchObject({ secretRevision: 1, rootKeyVersion: 2 });
  });

  it("preserves the plaintext across the move", async () => {
    context.keyRing.rotateTo(2);
    await reEncryptCredential(context.dependencies, { authorization: grants.operator, credentialId });
    const material = unwrap(
      await readSecret(context.dependencies, { authorization: grants.runtime, credentialId }),
    );
    expect(material.reveal()).toBe("sk-live-1");
  });

  it("records a REWRAP audit naming both root keys", async () => {
    context.keyRing.rotateTo(2);
    await reEncryptCredential(context.dependencies, { authorization: grants.operator, credentialId });
    expect(context.store.allAudits().find((row) => row.action === "REWRAP")).toMatchObject({
      secretRevision: 1,
      fromRootKeyVersion: 1,
      toRootKeyVersion: 2,
    });
  });

  it("is a no-op that converges when the envelope is already on the active key", async () => {
    const first = unwrap(
      await reEncryptCredential(context.dependencies, {
        authorization: grants.operator,
        credentialId,
      }),
    );
    expect(first.activeSecretVersion?.rootKeyVersion).toBe(1);
    expect(context.store.allVersions()).toHaveLength(1);
    expect(context.store.allAudits().some((row) => row.action === "REWRAP")).toBe(false);
  });

  it("DENIES a read-only operator grant", async () => {
    context.keyRing.rotateTo(2);
    const denied = await reEncryptCredential(context.dependencies, {
      authorization: grants.readOnlyOperator,
      credentialId,
    });
    expect(denied.ok).toBe(false);
  });
});

describe("re-encryption is what eventually frees a root key", () => {
  it("blocks removal of the prior key until its last envelope is purged", async () => {
    context.keyRing.rotateTo(2);
    await reEncryptCredential(context.dependencies, { authorization: grants.operator, credentialId });

    const before = unwrap(await reportRootKeyUsage(context.dependencies, grants.rootKeyOperator));
    expect(canRemoveRootKey(before, 1 as RootKeyVersion)).toBe(false);

    context.clock.advance(60_000);
    const purged = unwrap(
      await purgeRetiredSecretVersions(context.dependencies, {
        authorization: grants.rootKeyOperator,
        cutoff: context.clock.now(),
      }),
    );
    expect(purged.purgedCount).toBe(1);

    const after = unwrap(await reportRootKeyUsage(context.dependencies, grants.rootKeyOperator));
    expect(canRemoveRootKey(after, 1 as RootKeyVersion)).toBe(true);
    expect(after.activeRootKeyVersion).toBe(2);
  });
});
