// WIN-259 — the SECRET REFERENCE, against a real authenticated-encryption
// analogue and the real use cases.
//
// The domain suite next door proves the wire form and the claims body. This one
// proves the four properties that only exist once a cipher and a store are
// involved, and it proves each of them by JOINING TO SOMETHING THE ASSERTION
// DOES NOT CONTROL:
//
//   OPACITY is asserted against the plaintext, the credential's NAME and its
//   PROVIDER — three strings this file never puts in the reference and the
//   issuer never returns. A reference that leaked any of them would have to leak
//   a value the test did not hand it.
//
//   ENVIRONMENT BINDING is asserted against a SECOND fully-built environment
//   with its own grants and its own credential. The reference is carried from
//   one to the other by hand. Nothing in the exchange path compares two
//   environment ids, so the refusal comes from the cipher's key derivation and
//   its AAD — remove the environment from either and this case goes red while
//   every other case in the file stays green.
//
//   REVISION PINNING is asserted against a ROTATION performed by the real
//   `rotateCredential`, so the superseding revision is one the vault minted.
//
//   THE AUDIT TRAIL is asserted against the store's own rows, in both
//   directions, and against the plaintext never appearing in any of them.
//
// The `inMemoryAeadCipher` is a test double with the right FAILURE MODES: it
// mixes the root key material, the key info and the salt into a keystream and
// tags over the AAD. So a wrong environment, a wrong key version and an edited
// byte all fail exactly where AES-256-GCM would fail. That is what makes the
// negative controls below mean something.

import { unwrap } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { secretMaterial } from "../domain/secret-material.js";
import { createCredential } from "./create-credential.js";
import { inMemorySecrets } from "./in-memory-dependencies.js";
import type { InMemorySecrets } from "./in-memory-dependencies.js";
import { inMemoryGrants } from "./in-memory-grants.js";
import type { InMemoryGrants } from "./in-memory-grants.js";
import { readSecret } from "./read-secret.js";
import { rotateCredential } from "./rotate-credential.js";
import { exchangeSecretHandle, issueSecretHandle } from "./secret-handles.js";

const PLAINTEXT = "sk-live-reference-1";
const NAME = "OPENAI_API_KEY";
const PROVIDER = "openai";

let context: InMemorySecrets;
let grants: InMemoryGrants;
let credentialId: string;

async function seed(seedContext: InMemorySecrets, seedGrants: InMemoryGrants, plaintext: string) {
  return unwrap(
    await createCredential(seedContext.dependencies, {
      authorization: seedGrants.operator,
      name: NAME,
      provider: PROVIDER,
      plaintext: secretMaterial(plaintext),
    }),
  ).id;
}

async function issue(options: { lifetimeMs?: number } = {}): Promise<string> {
  const issued = await issueSecretHandle(context.dependencies, {
    authorization: grants.operator,
    credentialId: credentialId as never,
    ...(options.lifetimeMs === undefined ? {} : { lifetimeMs: options.lifetimeMs }),
  });
  return unwrap(issued).handle;
}

function reads(): readonly { action: string; outcome: string }[] {
  return context.store.allAudits().filter((row) => row.action === "READ");
}

beforeEach(async () => {
  context = inMemorySecrets();
  grants = inMemoryGrants();
  credentialId = await seed(context, grants, PLAINTEXT);
});

describe("issuing a reference", () => {
  it("returns an opaque value carrying NO material, NO name and NO provider", async () => {
    const handle = await issue();
    expect(handle).not.toContain(PLAINTEXT);
    expect(handle).not.toContain(NAME);
    expect(handle).not.toContain(PROVIDER);
    expect(handle).not.toContain(credentialId);
    expect(handle).not.toContain(grants.environmentId);
  });

  it("is spelled with the scheme so a leaked one is RECOGNISABLE as a reference", async () => {
    // A leaked reference should be identifiable at a glance in a log or a
    // payload, which is the opposite of the requirement on a secret. Only the
    // ability to REVERSE it has to be denied.
    expect(await issue()).toMatch(/^psh1\./u);
  });

  it("publishes the expiry, and nothing else about the credential", async () => {
    const issued = unwrap(
      await issueSecretHandle(context.dependencies, {
        authorization: grants.operator,
        credentialId: credentialId as never,
      }),
    );
    expect(Object.keys(issued).sort()).toEqual(["expiresAt", "handle", "issuedAt"]);
    expect(issued.expiresAt.getTime() - issued.issuedAt.getTime()).toBe(900_000);
  });

  it("is issuable by a metadata-only operator, who may NOT read the material", async () => {
    const issued = await issueSecretHandle(context.dependencies, {
      authorization: grants.readOnlyOperator,
      credentialId: credentialId as never,
    });
    expect(issued.ok).toBe(true);
    const denied = await readSecret(context.dependencies, {
      authorization: grants.readOnlyOperator,
      credentialId: credentialId as never,
    });
    expect(denied.ok).toBe(false);
  });

  it("resolves a credential named by value, so a caller can stop naming it that way", async () => {
    const issued = await issueSecretHandle(context.dependencies, {
      authorization: grants.operator,
      name: NAME,
      provider: PROVIDER,
    });
    expect(issued.ok).toBe(true);
  });

  it("mints a DIFFERENT reference every time for the same credential", async () => {
    expect(await issue()).not.toEqual(await issue());
  });

  it("refuses an unminted authorization", async () => {
    const forged = {
      organizationId: "org-1",
      projectId: "proj-1",
      environmentId: grants.environmentId,
      principalType: "operator",
      tier: "OPERATOR",
      access: "secret:mutate",
      actorUserId: "user-1",
      effectiveUserId: "user-1",
    };
    const issued = await issueSecretHandle(context.dependencies, {
      authorization: forged as never,
      credentialId: credentialId as never,
    });
    expect(issued.ok).toBe(false);
    if (issued.ok) return;
    expect(issued.error.code).toBe("CREDENTIAL_FORBIDDEN");
  });

  it("refuses to reference a credential that does not exist", async () => {
    const issued = await issueSecretHandle(context.dependencies, {
      authorization: grants.operator,
      name: "NOT_A_CREDENTIAL",
    });
    expect(issued.ok).toBe(false);
  });

  it("refuses a lifetime past the ceiling instead of silently shortening it", async () => {
    const issued = await issueSecretHandle(context.dependencies, {
      authorization: grants.operator,
      credentialId: credentialId as never,
      lifetimeMs: 86_400_001,
    });
    expect(issued.ok).toBe(false);
    if (issued.ok) return;
    expect(issued.error.details).toMatchObject({ reason: "handle_lifetime_invalid" });
  });

  it("writes NO audit row, because no material moved", async () => {
    await issue();
    expect(context.store.allAudits().filter((row) => row.action === "READ")).toHaveLength(0);
  });
});

describe("exchanging a reference", () => {
  it("yields the material the reference was issued against", async () => {
    const handle = await issue();
    const material = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle,
    });
    expect(material.ok).toBe(true);
    if (!material.ok) return;
    expect(material.value.reveal()).toBe(PLAINTEXT);
  });

  it("returns a value that still redacts itself", async () => {
    const material = unwrap(
      await exchangeSecretHandle(context.dependencies, {
        authorization: grants.runtime,
        handle: await issue(),
      }),
    );
    expect(JSON.stringify({ material })).not.toContain(PLAINTEXT);
    expect(`${material}`).toBe("[REDACTED SecretMaterial]");
  });

  it("appends ONE SUCCESS READ row naming the revision and the root key", async () => {
    await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle: await issue(),
    });
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toMatchObject({
      action: "READ",
      outcome: "SUCCESS",
      actorType: "runtime",
      credentialId,
      secretRevision: 1,
      fromRootKeyVersion: 1,
      toRootKeyVersion: 1,
    });
  });

  it("records METADATA ONLY — no reference and no plaintext reaches the trail", async () => {
    const handle = await issue();
    await exchangeSecretHandle(context.dependencies, { authorization: grants.runtime, handle });
    const trail = JSON.stringify(context.store.allAudits());
    expect(trail).not.toContain(PLAINTEXT);
    expect(trail).not.toContain(handle);
  });
});

describe("what a reference refuses", () => {
  it("refuses an OPERATOR, however privileged — the runtime tier only", async () => {
    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.operator,
      handle: await issue(),
    });
    expect(spent.ok).toBe(false);
    if (spent.ok) return;
    expect(spent.error.code).toBe("CREDENTIAL_FORBIDDEN");
  });

  it("AUDITS that refusal as DENIED, naming the credential the holder reached for", async () => {
    await exchangeSecretHandle(context.dependencies, {
      authorization: grants.operator,
      handle: await issue(),
    });
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toMatchObject({
      outcome: "DENIED",
      actorType: "operator",
      credentialId,
      secretRevision: 1,
    });
  });

  it("refuses a reference minted for ANOTHER ENVIRONMENT", async () => {
    // The second environment is fully built: its own grants, its own store, its
    // own credential with the same name and provider. Only the environment id
    // differs, and it differs INSIDE the cipher's key derivation and AAD.
    const elsewhere = inMemorySecrets();
    const elsewhereGrants = inMemoryGrants("2");
    await seed(elsewhere, elsewhereGrants, "sk-live-elsewhere");
    const foreign = unwrap(
      await issueSecretHandle(elsewhere.dependencies, {
        authorization: elsewhereGrants.operator,
        name: NAME,
      }),
    ).handle;

    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle: foreign,
    });
    expect(spent.ok).toBe(false);
    if (spent.ok) return;
    expect(spent.error.code).toBe("CREDENTIAL_UNAVAILABLE");
    expect(spent.error.details).toMatchObject({ reason: "handle_open_failed" });
  });

  it("leaves NO audit row for a foreign reference, so a replay cannot write into this trail", async () => {
    const elsewhere = inMemorySecrets();
    const elsewhereGrants = inMemoryGrants("2");
    await seed(elsewhere, elsewhereGrants, "sk-live-elsewhere");
    const foreign = unwrap(
      await issueSecretHandle(elsewhere.dependencies, {
        authorization: elsewhereGrants.operator,
        name: NAME,
      }),
    ).handle;

    await exchangeSecretHandle(context.dependencies, {
      authorization: grants.operator,
      handle: foreign,
    });
    expect(context.store.allAudits()).toHaveLength(1);
    expect(reads()).toHaveLength(0);
  });

  it("refuses a reference whose bytes were edited, with the SAME answer", async () => {
    const handle = await issue();
    const fields = handle.split(".");
    const tampered = [...fields.slice(0, 4), `${fields[4]}A`, fields[5]].join(".");
    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle: tampered,
    });
    expect(spent.ok).toBe(false);
    if (spent.ok) return;
    expect(spent.error.details).toMatchObject({ reason: "handle_open_failed" });
  });

  it("refuses a reference invented outright, however well formed", async () => {
    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle: "psh1.1.AAAA.BBBB.CCCC.DDDD",
    });
    expect(spent.ok).toBe(false);
  });

  it("refuses a value that is not a reference at all", async () => {
    for (const nonsense of [undefined, null, 42, { handle: "psh1" }, "not-a-handle"]) {
      const spent = await exchangeSecretHandle(context.dependencies, {
        authorization: grants.runtime,
        handle: nonsense,
      });
      expect(spent.ok).toBe(false);
    }
  });

  it("refuses an EXPIRED reference", async () => {
    const handle = await issue({ lifetimeMs: 60_000 });
    context.clock.advance(60_000);
    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle,
    });
    expect(spent.ok).toBe(false);
    if (spent.ok) return;
    expect(spent.error.details).toMatchObject({ reason: "handle_expired" });
  });

  it("still resolves one millisecond BEFORE the expiry", async () => {
    const handle = await issue({ lifetimeMs: 60_000 });
    context.clock.advance(59_999);
    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle,
    });
    expect(spent.ok).toBe(true);
  });

  it("STOPS RESOLVING once the credential is rotated past the pinned revision", async () => {
    const handle = await issue();
    unwrap(
      await rotateCredential(context.dependencies, {
        authorization: grants.operator,
        credentialId: credentialId as never,
        plaintext: secretMaterial("sk-live-rotated"),
      }),
    );
    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle,
    });
    expect(spent.ok).toBe(false);
    if (spent.ok) return;
    expect(spent.error.details).toMatchObject({ reason: "handle_revision_superseded" });
  });

  it("never yields the SUPERSEDING material, which is the whole point of the pin", async () => {
    const handle = await issue();
    await rotateCredential(context.dependencies, {
      authorization: grants.operator,
      credentialId: credentialId as never,
      plaintext: secretMaterial("sk-live-rotated"),
    });
    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle,
    });
    expect(spent.ok).toBe(false);
    // And the material is still readable BY NAME, so the refusal is the
    // reference's rule and not the credential having become unusable.
    const byName = await readSecret(context.dependencies, {
      authorization: grants.runtime,
      credentialId: credentialId as never,
    });
    expect(unwrap(byName).reveal()).toBe("sk-live-rotated");
  });

  it("refuses a reference whose ROOT KEY has left the ring", async () => {
    const handle = await issue();
    context.keyRing.rotateTo(2);
    context.keyRing.retireVersion(1);
    const spent = await exchangeSecretHandle(context.dependencies, {
      authorization: grants.runtime,
      handle,
    });
    expect(spent.ok).toBe(false);
    if (spent.ok) return;
    expect(spent.error.details).toMatchObject({ reason: "root_key_absent" });
  });
});
