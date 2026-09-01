import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { createCredential } from "./create-credential.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";

let context: InMemorySecrets;
let grants: InMemoryGrants;

beforeEach(() => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
});

describe("creating a credential", () => {
  it("seals revision 1 under the active root key and points the credential at it", async () => {
    const created = unwrap(
      await createCredential(context.dependencies, {
        authorization: grants.operator,
        name: "OPENAI_API_KEY",
        provider: "openai",
        plaintext: "sk-live-1",
      }),
    );

    expect(created.name).toBe("OPENAI_API_KEY");
    expect(created.activeSecretVersion).toMatchObject({
      secretRevision: 1,
      formatVersion: 1,
      rootKeyVersion: 1,
      retiredAt: null,
    });
    expect(context.store.allVersions()).toHaveLength(1);
  });

  it("never stores the plaintext, in the credential row or the envelope row", async () => {
    await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: "sk-live-1",
    });
    const stored = JSON.stringify([context.store.allCredentials(), context.store.allVersions()]);
    expect(stored).not.toContain("sk-live-1");
  });

  it("writes one metadata-only CREATE audit row", async () => {
    await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: "sk-live-1",
    });
    const audits = context.store.allAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "CREATE",
      outcome: "SUCCESS",
      actorType: "operator",
      secretRevision: 1,
      fromRootKeyVersion: null,
      toRootKeyVersion: 1,
    });
    expect(JSON.stringify(audits)).not.toContain("sk-live-1");
  });

  it("defaults to a service credential and accepts an explicit kind", async () => {
    const service = unwrap(
      await createCredential(context.dependencies, {
        authorization: grants.operator,
        name: "A_KEY",
        plaintext: "value",
      }),
    );
    const reference = unwrap(
      await createCredential(context.dependencies, {
        authorization: grants.operator,
        name: "A_KEY",
        kind: "SECRET_REFERENCE",
        plaintext: "value",
      }),
    );
    expect(service.kind).toBe("SERVICE_CREDENTIAL");
    expect(reference.kind).toBe("SECRET_REFERENCE");
  });
});

describe("creation refuses what it must", () => {
  it("DENIES a read-only operator grant", async () => {
    const denied = await createCredential(context.dependencies, {
      authorization: grants.readOnlyOperator,
      name: "OPENAI_API_KEY",
      plaintext: "sk-live-1",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("CREDENTIAL_FORBIDDEN");
    expect(context.store.allCredentials()).toHaveLength(0);
  });

  it("DENIES a runtime grant, which may only read", async () => {
    const denied = await createCredential(context.dependencies, {
      authorization: grants.runtime,
      name: "OPENAI_API_KEY",
      plaintext: "sk-live-1",
    });
    expect(denied.ok).toBe(false);
  });

  it("allows a service grant holding secret:write", async () => {
    const created = await createCredential(context.dependencies, {
      authorization: grants.service,
      name: "OPENAI_API_KEY",
      plaintext: "sk-live-1",
    });
    expect(created.ok).toBe(true);
  });

  it("refuses empty plaintext before touching the store", async () => {
    const refused = await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: "",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("INVALID_SECRET_MATERIAL");
    expect(context.store.allCredentials()).toHaveLength(0);
  });

  it("refuses a duplicate name within the environment and kind", async () => {
    const command = {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: "sk-live-1",
    };
    expect((await createCredential(context.dependencies, command)).ok).toBe(true);
    const clash = await createCredential(context.dependencies, command);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.code).toBe("CREDENTIAL_NAME_TAKEN");
  });
});

describe("an unauditable creation does not happen", () => {
  it("rolls back the credential AND the envelope when the audit write fails", async () => {
    context.store.failNextAudit();
    const failed = await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      plaintext: "sk-live-1",
    });

    expect(failed.ok).toBe(false);
    expect(context.store.allCredentials()).toHaveLength(0);
    expect(context.store.allVersions()).toHaveLength(0);
    expect(context.store.allAudits()).toHaveLength(0);
    expect(context.unitOfWork.rollbacks()).toBe(1);
  });
});
