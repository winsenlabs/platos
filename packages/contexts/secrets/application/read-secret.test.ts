import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { secretMaterial } from "../domain/secret-material.js";

import { createCredential } from "./create-credential.js";
import { openSecret } from "./envelope-operations.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { readSecret } from "./read-secret.js";
import { revokeCredential } from "./revoke-credential.js";
import { rotateCredential } from "./rotate-credential.js";
import type { CredentialId } from "../domain/ids.js";

const PLAINTEXT = "sk-live-1";

let context: InMemorySecrets;
let grants: InMemoryGrants;
let credentialId: CredentialId;

beforeEach(async () => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
  const created = unwrap(
    await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: secretMaterial(PLAINTEXT),
    }),
  );
  credentialId = created.id;
});

describe("the runtime tier, and only the runtime tier, reads material", () => {
  it("returns the sealed plaintext to a runtime grant", async () => {
    const material = unwrap(
      await readSecret(context.dependencies, { authorization: grants.runtime, credentialId }),
    );
    expect(material.reveal()).toBe(PLAINTEXT);
  });

  it("DENIES an operator holding secret:mutate, however privileged", async () => {
    const denied = await readSecret(context.dependencies, {
      authorization: grants.operator,
      credentialId,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("CREDENTIAL_FORBIDDEN");
      expect(denied.error.details).toMatchObject({ reason: "read_requires_runtime_tier" });
    }
  });

  it("DENIES a read-only operator and a write-only service grant", async () => {
    for (const authorization of [grants.readOnlyOperator, grants.service]) {
      expect((await readSecret(context.dependencies, { authorization, credentialId })).ok).toBe(false);
    }
  });

  it("audits every read in the same unit of work", async () => {
    await readSecret(context.dependencies, { authorization: grants.runtime, credentialId });
    await readSecret(context.dependencies, { authorization: grants.runtime, credentialId });
    const reads = context.store.allAudits().filter((row) => row.action === "READ");
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ actorType: "runtime", secretRevision: 1 });
  });

  it("does not record a read when the material could not be produced", async () => {
    context.keyRing.retireVersion(1);
    context.keyRing.rotateTo(2);
    await readSecret(context.dependencies, { authorization: grants.runtime, credentialId });
    expect(context.store.allAudits().filter((row) => row.action === "READ")).toHaveLength(0);
  });
});

describe("a retired envelope is closed to reads", () => {
  it("refuses a version the credential still points at once it is retired", async () => {
    const version = context.store.allVersions()[0];
    expect(version).toBeDefined();
    if (version === undefined) return;
    const retired = { ...version, retiredAt: new Date("2026-01-02T00:00:00.000Z") };

    const refused = await openSecret(context.dependencies, {
      environmentId: grants.environmentId,
      version: retired,
      activeSecretVersionId: retired.id,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("CREDENTIAL_UNAVAILABLE");
      expect(refused.error.details).toMatchObject({ reason: "secret_version_retired" });
    }
  });

  it("refuses a live version the credential no longer points at", async () => {
    const version = context.store.allVersions()[0];
    if (version === undefined) throw new Error("no version");
    const refused = await openSecret(context.dependencies, {
      environmentId: grants.environmentId,
      version,
      activeSecretVersionId: null,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.details).toMatchObject({ reason: "secret_version_not_active" });
    }
  });

  it("stops reading a revoked credential immediately", async () => {
    await revokeCredential(context.dependencies, { authorization: grants.operator, credentialId });
    const refused = await readSecret(context.dependencies, {
      authorization: grants.runtime,
      credentialId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("CREDENTIAL_UNAVAILABLE");
  });

  it("reads the NEW material after a rotation, never the retired one", async () => {
    await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId,
      plaintext: secretMaterial("sk-live-2"),
    });
    const material = unwrap(
      await readSecret(context.dependencies, { authorization: grants.runtime, credentialId }),
    );
    expect(material.reveal()).toBe("sk-live-2");
  });
});

describe("a rotated-out root key fails closed", () => {
  it("returns an error and NO ciphertext when the sealing key has left the ring", async () => {
    context.keyRing.rotateTo(2);
    context.keyRing.retireVersion(1);

    const refused = await readSecret(context.dependencies, {
      authorization: grants.runtime,
      credentialId,
    });

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("CREDENTIAL_UNAVAILABLE");
      expect(refused.error.details).toMatchObject({ reason: "root_key_absent" });
      expect(JSON.stringify(refused)).not.toContain(PLAINTEXT);
      expect(Object.keys(refused)).toEqual(["ok", "error"]);
    }
  });

  it("still reads while the key is merely PRIOR rather than absent", async () => {
    context.keyRing.rotateTo(2);
    const material = unwrap(
      await readSecret(context.dependencies, { authorization: grants.runtime, credentialId }),
    );
    expect(material.reveal()).toBe(PLAINTEXT);
  });
});

describe("distinct failures collapse to one indistinguishable answer", () => {
  it("gives the same code for a missing credential, a revoked one and a tampered envelope", async () => {
    const missing = await readSecret(context.dependencies, {
      authorization: grants.runtime,
      credentialId: "no-such-credential" as CredentialId,
    });

    const version = context.store.allVersions()[0];
    if (version === undefined) throw new Error("no version");
    version.ciphertext[0] = (version.ciphertext[0] ?? 0) ^ 1;
    const tampered = await readSecret(context.dependencies, {
      authorization: grants.runtime,
      credentialId,
    });

    const otherEnvironment = inMemoryGrants("2");
    const crossTenant = await readSecret(context.dependencies, {
      authorization: otherEnvironment.runtime,
      credentialId,
    });

    for (const outcome of [missing, tampered, crossTenant]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe("CREDENTIAL_UNAVAILABLE");
        expect(outcome.error.message).toBe("credential unavailable");
      }
    }
    if (!tampered.ok) {
      expect(tampered.error.details).toMatchObject({ reason: "envelope_open_failed" });
    }
  });
});
