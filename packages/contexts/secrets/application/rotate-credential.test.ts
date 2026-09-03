import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { createCredential } from "./create-credential.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { readSecret } from "./read-secret.js";
import { rotateCredential } from "./rotate-credential.js";
import type { CredentialId } from "../domain/ids.js";

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

describe("rotation advances the revision and retires what it replaces", () => {
  it("mints revision 2 and points the credential at it", async () => {
    const rotated = unwrap(
      await rotateCredential(context.dependencies, {
        authorization: grants.operator,
        credentialId,
        plaintext: "sk-live-2",
      }),
    );
    expect(rotated.activeSecretVersion).toMatchObject({ secretRevision: 2, retiredAt: null });
    expect(context.store.allVersions()).toHaveLength(2);
  });

  it("retires the previous envelope with the requested purge-deferral window", async () => {
    const readableUntil = new Date("2026-02-01T00:00:00.000Z");
    await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId,
      plaintext: "sk-live-2",
      readableUntil,
    });
    const retired = context.store.allVersions().find((entry) => entry.secretRevision === 1);
    expect(retired?.retiredAt).not.toBeNull();
    expect(retired?.readableUntil).toEqual(readableUntil);
  });

  it("does not invalidate material a caller already holds", async () => {
    const held = unwrap(
      await readSecret(context.dependencies, { authorization: grants.runtime, credentialId }),
    );
    await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId,
      plaintext: "sk-live-2",
    });
    expect(held.reveal()).toBe("sk-live-1");
  });

  it("records the root key an envelope left and the one it arrived on", async () => {
    context.keyRing.rotateTo(2);
    await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId,
      plaintext: "sk-live-2",
    });
    const audit = context.store.allAudits().find((row) => row.action === "ROTATE");
    expect(audit).toMatchObject({ secretRevision: 2, fromRootKeyVersion: 1, toRootKeyVersion: 2 });
  });

  it("always seals under the ACTIVE root key, never the one being retired", async () => {
    context.keyRing.rotateTo(3);
    const rotated = unwrap(
      await rotateCredential(context.dependencies, {
        authorization: grants.operator,
        credentialId,
        plaintext: "sk-live-2",
      }),
    );
    expect(rotated.activeSecretVersion?.rootKeyVersion).toBe(3);
  });
});

describe("rotation refuses what it must", () => {
  it("DENIES a read-only operator grant and leaves the envelope untouched", async () => {
    const denied = await rotateCredential(context.dependencies, {
      authorization: grants.readOnlyOperator,
      credentialId,
      plaintext: "sk-live-2",
    });
    expect(denied.ok).toBe(false);
    expect(context.store.allVersions()).toHaveLength(1);
  });

  it("refuses an unknown credential and one in another environment", async () => {
    const unknown = await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId: "no-such-credential" as CredentialId,
      plaintext: "sk-live-2",
    });
    expect(unknown.ok).toBe(false);

    const crossTenant = await rotateCredential(context.dependencies, {
      authorization: inMemoryGrants("2").operator,
      credentialId,
      plaintext: "sk-live-2",
    });
    expect(crossTenant.ok).toBe(false);
  });

  it("rolls back the whole rotation when the audit write fails", async () => {
    context.store.failNextAudit();
    const failed = await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId,
      plaintext: "sk-live-2",
    });
    expect(failed.ok).toBe(false);
    expect(context.store.allVersions()).toHaveLength(1);
    const survivor = context.store.allVersions()[0];
    expect(survivor?.retiredAt).toBeNull();
    const material = unwrap(
      await readSecret(context.dependencies, { authorization: grants.runtime, credentialId }),
    );
    expect(material.reveal()).toBe("sk-live-1");
  });
});
