import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { CredentialId } from "../domain/ids.js";
import { createCredential } from "./create-credential.js";
import { describeCredential } from "./describe-credentials.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { readSecret } from "./read-secret.js";
import {
  DEFAULT_REVOKED_SECRET_RETENTION_MS,
  MAX_REVOKED_SECRET_RETENTION_MS,
  revokeCredential,
} from "./revoke-credential.js";

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

describe("revocation closes the secret at once and keeps the evidence briefly", () => {
  it("drops the pointer, retires the envelope and stamps revokedAt", async () => {
    const revoked = unwrap(
      await revokeCredential(context.dependencies, { authorization: grants.operator, credentialId }),
    );
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.activeSecretVersion).toBeNull();
    expect(context.store.allVersions()[0]?.retiredAt).not.toBeNull();
  });

  it("makes the secret unreadable immediately, whatever the retention window says", async () => {
    await revokeCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId,
      retentionMs: MAX_REVOKED_SECRET_RETENTION_MS,
    });
    const refused = await readSecret(context.dependencies, {
      authorization: grants.runtime,
      credentialId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("CREDENTIAL_UNAVAILABLE");
  });

  it("defaults the retention window to twenty-four hours", async () => {
    const revokedAt = context.clock.now();
    await revokeCredential(context.dependencies, { authorization: grants.operator, credentialId });
    const version = context.store.allVersions()[0];
    expect(version?.readableUntil?.getTime()).toBe(
      revokedAt.getTime() + DEFAULT_REVOKED_SECRET_RETENTION_MS,
    );
  });

  it("still describes the revoked credential as metadata", async () => {
    await revokeCredential(context.dependencies, { authorization: grants.operator, credentialId });
    const described = unwrap(
      await describeCredential(context.dependencies, {
        authorization: grants.readOnlyOperator,
        credentialId,
      }),
    );
    expect(described).toBeNull();
    expect(context.store.allCredentials()[0]?.revokedAt).not.toBeNull();
  });

  it("writes a REVOKE audit naming the revision and the key it was under", async () => {
    await revokeCredential(context.dependencies, { authorization: grants.operator, credentialId });
    expect(context.store.allAudits().find((row) => row.action === "REVOKE")).toMatchObject({
      secretRevision: 1,
      fromRootKeyVersion: 1,
    });
  });
});

describe("the retention window is bounded on both ends", () => {
  it.each([0, -1, 1.5, MAX_REVOKED_SECRET_RETENTION_MS + 1])(
    "refuses a retention of %s milliseconds",
    async (retentionMs) => {
      const refused = await revokeCredential(context.dependencies, {
        authorization: grants.operator,
        credentialId,
        retentionMs,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("INVALID_RETENTION_REQUEST");
      expect(context.store.allCredentials()[0]?.revokedAt).toBeNull();
    },
  );

  it("DENIES a read-only operator grant", async () => {
    const denied = await revokeCredential(context.dependencies, {
      authorization: grants.readOnlyOperator,
      credentialId,
    });
    expect(denied.ok).toBe(false);
    expect(context.store.allCredentials()[0]?.revokedAt).toBeNull();
  });
});
