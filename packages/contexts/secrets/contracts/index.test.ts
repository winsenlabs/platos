import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { inMemoryGrants, inMemorySecrets } from "../application/index.js";
import type { InMemoryGrants, InMemorySecrets } from "../application/index.js";
import * as published from "./index.js";
import { SECRETS_EVENT_NAMES, secretsContract } from "./index.js";
import type { SecretsContract } from "./index.js";

let context: InMemorySecrets;
let grants: InMemoryGrants;
let vault: SecretsContract;

beforeEach(() => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
  vault = secretsContract(context.dependencies);
});

describe("the published surface", () => {
  it("names the context and is frozen", () => {
    expect(vault.name).toBe("secrets");
    expect(Object.isFrozen(vault)).toBe(true);
  });

  it("exports NO SecretReference of any shape", () => {
    // ADR M0.3 §1 row 3 lists SecretReference as a secrets sole-writer row. It does
    // not exist in internal-packages/tenancy-database/prisma/schema.prisma, and
    // docs/model-disposition.md already merged it into Credential. The merged shape
    // is the credential KIND below, and this assertion keeps the stale ADR row from
    // being re-implemented by someone reading the table rather than the schema.
    const exported = Object.keys(published);
    expect(exported.filter((name) => name.includes("SecretReference"))).toEqual([]);
    expect([...published.CREDENTIAL_KINDS]).toContain("SECRET_REFERENCE");
  });

  it("publishes the withheld-field list so a caller can see what it will never get", () => {
    expect([...published.WITHHELD_CREDENTIAL_FIELDS]).toEqual([
      "salt",
      "nonce",
      "ciphertext",
      "authTag",
      "secretHash",
      "encryptedReference",
    ]);
  });

  it("publishes the mint functions, because a grant cannot be built any other way", () => {
    expect(typeof published.authorizeEnvironmentOperator).toBe("function");
    expect(typeof published.authorizeEnvironmentRuntime).toBe("function");
    expect(typeof published.authorizeEnvironmentService).toBe("function");
    expect(typeof published.authorizeRootKeyOperations).toBe("function");
    expect(published.isMintedAuthorization(grants.operator)).toBe(true);
  });

  it("names its integration events under the owning context", () => {
    for (const name of SECRETS_EVENT_NAMES) expect(name.startsWith("secrets.")).toBe(true);
  });
});

describe("the whole vault lifecycle through the contract alone", () => {
  it("creates, describes, reads, rotates, re-encrypts, revokes and purges", async () => {
    const created = unwrap(
      await vault.createCredential({
        authorization: grants.operator,
        name: "OPENAI_API_KEY",
        provider: "openai",
        plaintext: "sk-live-1",
      }),
    );

    const described = unwrap(
      await vault.describeCredential({
        authorization: grants.readOnlyOperator,
        credentialId: created.id,
      }),
    );
    expect(described).toMatchObject({ name: "OPENAI_API_KEY", provider: "openai" });

    const material = unwrap(
      await vault.readSecret({ authorization: grants.runtime, credentialId: created.id }),
    );
    expect(material.reveal()).toBe("sk-live-1");

    const rotated = unwrap(
      await vault.rotateCredential({
        authorization: grants.operator,
        credentialId: created.id,
        plaintext: "sk-live-2",
      }),
    );
    expect(rotated.activeSecretVersion?.secretRevision).toBe(2);

    context.keyRing.rotateTo(2);
    const moved = unwrap(
      await vault.reEncryptCredential({ authorization: grants.operator, credentialId: created.id }),
    );
    expect(moved.activeSecretVersion).toMatchObject({ secretRevision: 2, rootKeyVersion: 2 });

    const listed = unwrap(await vault.listCredentials(grants.readOnlyOperator));
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("sk-live-2");

    const revoked = unwrap(
      await vault.revokeCredential({ authorization: grants.operator, credentialId: created.id }),
    );
    expect(revoked.activeSecretVersion).toBeNull();

    context.clock.advance(48 * 60 * 60 * 1_000);
    const purged = unwrap(
      await vault.purgeRetiredSecretVersions({
        authorization: grants.rootKeyOperator,
        cutoff: context.clock.now(),
      }),
    );
    expect(purged.purgedCount).toBe(3);
    expect(context.store.allVersions()).toHaveLength(0);
  });

  it("routes environment variables through the same surface", async () => {
    unwrap(
      await vault.setEnvironmentVariable({
        authorization: grants.operator,
        key: "OPENAI_API_KEY",
        value: "sk-live-1",
        secret: true,
      }),
    );
    const listed = unwrap(await vault.listEnvironmentVariables(grants.readOnlyOperator));
    expect(listed[0]).toMatchObject({ kind: "SECRET", value: null, hasSecret: true });

    const read = unwrap(
      await vault.readEnvironmentVariable({ authorization: grants.runtime, key: "OPENAI_API_KEY" }),
    );
    expect(read.kind).toBe("SECRET");

    const removed = unwrap(
      await vault.deleteEnvironmentVariable({
        authorization: grants.operator,
        key: "OPENAI_API_KEY",
      }),
    );
    expect(removed.deleted).toBe(true);
  });

  it("reports root key usage only to the installation-global grant", async () => {
    await vault.createCredential({
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: "sk-live-1",
    });
    const report = unwrap(await vault.reportRootKeyUsage(grants.rootKeyOperator));
    expect(report).toMatchObject({ activeRootKeyVersion: 1 });
    expect(report.usage).toEqual([{ rootKeyVersion: 1, unpurgedVersionCount: 1 }]);

    const denied = await vault.reportRootKeyUsage(grants.operator as never);
    expect(denied.ok).toBe(false);
  });
});
