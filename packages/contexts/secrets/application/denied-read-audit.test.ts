// WIN-259 — evidence that somebody reached for material they may not have.
//
// `CREDENTIAL_AUDIT_OUTCOMES` has listed `DENIED` since this context was
// written, and a grep of the whole package found the constant declared and
// NEVER produced: `recordAudit` defaulted to `SUCCESS` and no caller passed
// anything else. So the trail recorded every read that was allowed and nothing
// at all about a read that was refused — which is exactly backwards for the
// question the trail exists to answer, since a successful read by an authorised
// runtime is the normal case and a refused read by an operator is the signal.
//
// The three limits below are DECLARED as cases rather than left implied,
// because each is a place this trail is deliberately silent and a reader
// counting rows needs to know which silences are honest.

import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { secretMaterial } from "../domain/secret-material.js";
import { createCredential } from "./create-credential.js";
import { setEnvironmentVariable } from "./environment-variable-writes.js";
import { readEnvironmentVariable } from "./environment-variable-reads.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { readSecret } from "./read-secret.js";

let context: InMemorySecrets;
let grants: InMemoryGrants;
let credentialId: string;

beforeEach(async () => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
  credentialId = unwrap(
    await createCredential(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: secretMaterial("sk-live-1"),
    }),
  ).id;
});

function reads(): readonly { action: string; outcome: string }[] {
  return context.store.allAudits().filter((row) => row.action === "READ");
}

describe("a refused read leaves evidence", () => {
  it("appends ONE DENIED READ row when an operator reaches for material", async () => {
    const denied = await readSecret(context.dependencies, {
      authorization: grants.operator,
      credentialId: credentialId as never,
    });
    expect(denied.ok).toBe(false);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toMatchObject({ action: "READ", outcome: "DENIED", actorType: "operator" });
  });

  it("names the credential, the revision and the root key the caller was after", async () => {
    await readSecret(context.dependencies, {
      authorization: grants.operator,
      credentialId: credentialId as never,
    });
    expect(reads()[0]).toMatchObject({
      credentialId,
      secretRevision: 1,
      fromRootKeyVersion: 1,
      toRootKeyVersion: 1,
    });
  });

  it("records METADATA ONLY, with no trace of the material it refused", async () => {
    await readSecret(context.dependencies, {
      authorization: grants.operator,
      credentialId: credentialId as never,
    });
    expect(reads()).toHaveLength(1);
    expect(JSON.stringify(context.store.allAudits())).not.toContain("sk-live-1");
  });

  it("resolves a credential named indirectly, not only one named by id", async () => {
    await readSecret(context.dependencies, {
      authorization: grants.operator,
      name: "OPENAI_API_KEY",
      provider: "openai",
    });
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toMatchObject({ outcome: "DENIED", credentialId });
  });

  it("tells a refusal apart from the read that was allowed", async () => {
    await readSecret(context.dependencies, {
      authorization: grants.operator,
      credentialId: credentialId as never,
    });
    unwrap(
      await readSecret(context.dependencies, {
        authorization: grants.runtime,
        credentialId: credentialId as never,
      }),
    );
    expect(reads().map((row) => row.outcome)).toEqual(["DENIED", "SUCCESS"]);
  });

  it("COMMITS the row even though the read it describes failed", async () => {
    const before = context.unitOfWork.commits();
    await readSecret(context.dependencies, {
      authorization: grants.operator,
      credentialId: credentialId as never,
    });
    expect(context.unitOfWork.commits()).toBe(before + 1);
    expect(context.unitOfWork.rollbacks()).toBe(0);
  });

  it("audits a refused ENVIRONMENT VARIABLE read against its backing credential", async () => {
    unwrap(
      await setEnvironmentVariable(context.dependencies, {
        authorization: grants.operator,
        key: "STRIPE_KEY",
        value: secretMaterial("sk-live-2"),
        secret: true,
      }),
    );
    const denied = await readEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key: "STRIPE_KEY",
    });
    expect(denied.ok).toBe(false);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toMatchObject({ outcome: "DENIED" });
  });
});

describe("the three silences, declared", () => {
  it("records NOTHING for an unminted authorization, because its actor is the forger's", async () => {
    const forged = {
      environmentId: grants.operator.environmentId,
      principalType: "runtime",
      tier: "RUNTIME",
      access: "secret:read",
      actorId: "attacker-chose-this",
    };
    const denied = await readSecret(context.dependencies, {
      authorization: forged as never,
      credentialId: credentialId as never,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details).toMatchObject({ reason: "authorization_not_minted" });
    expect(reads()).toHaveLength(0);
  });

  it("records NOTHING when the credential does not resolve, because the FK has no row for it", async () => {
    const denied = await readSecret(context.dependencies, {
      authorization: grants.operator,
      name: "A_NAME_THAT_IS_NOT_THERE",
    });
    expect(denied.ok).toBe(false);
    expect(reads()).toHaveLength(0);
  });

  it("records NOTHING for a refused PLAIN variable read, for the same reason", async () => {
    unwrap(
      await setEnvironmentVariable(context.dependencies, {
        authorization: grants.operator,
        key: "LOG_LEVEL",
        value: secretMaterial("debug"),
        secret: false,
      }),
    );
    const denied = await readEnvironmentVariable(context.dependencies, {
      authorization: grants.operator,
      key: "LOG_LEVEL",
    });
    expect(denied.ok).toBe(false);
    expect(reads()).toHaveLength(0);
  });
});

describe("the evidence path cannot change the answer", () => {
  it("still denies with the tier reason when the trail is unavailable", async () => {
    context.store.failNextAudit();
    const denied = await readSecret(context.dependencies, {
      authorization: grants.operator,
      credentialId: credentialId as never,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("CREDENTIAL_FORBIDDEN");
      expect(denied.error.details).toMatchObject({ reason: "read_requires_runtime_tier" });
    }
    expect(reads()).toHaveLength(0);
  });
});
