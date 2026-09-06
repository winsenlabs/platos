// THE DELIVERABLE, END TO END, WITH REAL CRYPTOGRAPHY ON BOTH SIDES.
//
// A ciphertext produced by an EXTRACTION SOURCE goes in; the ordinary runtime
// read path gives the plaintext back out. Nothing between the two is doubled
// except the store and the clock:
//
//   * the legacy payload is bytes `internal-packages/tenancy-database/src/auth.ts`
//     or `apps/agent/src/auth/secrets.service.ts` produced, frozen in
//     `legacy-wire-vectors.ts` — neither module is edited by this issue;
//   * `openLegacy` is this adapter's real AES-256-GCM reader;
//   * `migrateLegacyEnvelope` is `secrets`' real use case, with its real grant
//     check, its real transaction and its real audit row;
//   * `seal` is this adapter's real HKDF-SHA256 + AES-256-GCM cipher over a real
//     versioned root key ring;
//   * `readSecret` is `secrets`' real runtime read path, which refuses any format
//     that is not `versionedRootKey` — so the material coming back out is proof
//     the row it opened is genuinely format 1.
//
// WHY IT LIVES HERE AND NOT IN `secrets`. That package's colocated suites drive
// `in-memory-crypto.ts`, whose own header says "It is NOT cryptography." A
// migration proven only against a keystream derived from FNV-1a would be a
// migration nobody had run. This is the package that holds the primitive, so it
// is the package where the claim can be falsified.
//
// WHAT IS STILL DOUBLED, AND WHY IT DOES NOT WEAKEN THE CLAIM. The store is
// `inMemorySecretsStore`. It cannot enforce the three CHECK constraints that make
// a legacy envelope unstorable in `CredentialSecretVersion` — that is
// `postgres-tenancy`'s job and a real PostgreSQL's — but nothing here tries to
// store one: the whole point of the transcoding is that what reaches the store is
// canonical. What this file proves is that the BYTES round-trip.

import { beforeEach, describe, expect, it } from "vitest";

import {
  inMemoryClock,
  inMemoryGrants,
  inMemoryIdGenerator,
  inMemorySecretsStore,
  inMemoryUnitOfWork,
  migrateLegacyEnvelope,
  readSecret,
} from "@platos/context-secrets/application/index.js";
import type {
  InMemoryGrants,
  InMemorySecretsStore,
  SecretsDependencies,
} from "@platos/context-secrets/application/index.js";
import type {
  CredentialId,
  EnvelopeFormatVersion,
} from "@platos/context-secrets/application/ports/index.js";
import { asSecretsIdentifier } from "@platos/context-secrets/application/ports/index.js";

import { createKeyringEnvelopeAdapter } from "./adapter.js";
import type { LegacyWireVector } from "./legacy-wire-vectors.js";
import { LEGACY_WIRE_VECTORS, legacyKeysFor } from "./legacy-wire-vectors.js";
import { createRootKeyRing } from "./root-key-ring.js";

/** A root key that is NOT any vector's legacy key. The two rings never overlap. */
const ROOT_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ACTIVE_ROOT_KEY_VERSION = 7;

let store: InMemorySecretsStore;
let grants: InMemoryGrants;

function vector(name: string): LegacyWireVector {
  const found = LEGACY_WIRE_VECTORS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no legacy vector named: ${name}`);
  return found;
}

/**
 * The vault, wired to the REAL adapter, holding the legacy key for one vector.
 *
 * The legacy keys are scoped to the vector under test on purpose: a harness that
 * loaded all three of a format's keys would let a vector open under a sibling's
 * key and nobody would notice.
 */
function vaultFor(subject: LegacyWireVector): SecretsDependencies {
  const ring = createRootKeyRing({
    activeVersion: ACTIVE_ROOT_KEY_VERSION,
    keys: { [String(ACTIVE_ROOT_KEY_VERSION)]: ROOT_KEY_HEX },
  });
  if (!ring.ok) throw new Error(`root key ring did not build: ${ring.error.code}`);
  const adapter = createKeyringEnvelopeAdapter(ring.value, legacyKeysFor(subject));
  return {
    repository: store,
    variables: store,
    keyRing: adapter,
    cipher: adapter,
    hasher: adapter,
    clock: inMemoryClock(),
    ids: inMemoryIdGenerator(),
    unitOfWork: inMemoryUnitOfWork([store]),
  };
}

/**
 * A credential whose material still lives in a legacy column: no canonical row.
 *
 * `unwrap` is NOT used here, and nowhere in this file, because this package
 * declares exactly one dependency — `@platos/context-secrets` — and reaching for
 * `@platos/kernel` would be a second import edge out of an adapter that
 * `application/ports/index.js` republishes the kernel's own `Result` helpers
 * specifically to prevent. A `throw` on a failed set-up is the local equivalent
 * and needs nothing imported.
 */
async function unmigratedCredential(deps: SecretsDependencies): Promise<CredentialId> {
  const id = asSecretsIdentifier<CredentialId>("credential-legacy-1");
  await deps.unitOfWork.run(async (transaction) => {
    const inserted = await deps.repository.insertCredential(
      {
        id,
        environmentId: grants.environmentId,
        kind: "ENTITY_SECRET",
        name: "LEGACY_IMPORT",
        provider: "openai",
        createdBy: null,
        createdAt: deps.clock.now(),
      },
      transaction,
    );
    if (!inserted.ok) throw new Error(`credential did not insert: ${inserted.error.code}`);
  });
  return id;
}

/** Migrate one vector and read the material back the way the runtime does. */
async function migrateAndRead(subject: LegacyWireVector) {
  const deps = vaultFor(subject);
  const credentialId = await unmigratedCredential(deps);

  // BEFORE: the material is unreachable. There is no canonical row, so the
  // ordinary read path has nothing to open — which is the state every legacy
  // secret in every live database is in today.
  const before = await readSecret(deps, { authorization: grants.runtime, credentialId });

  const migrated = await migrateLegacyEnvelope(deps, {
    authorization: grants.operator,
    credentialId,
    legacy: {
      formatVersion: subject.formatVersion as EnvelopeFormatVersion,
      payload: subject.payload,
    },
  });

  const after = await readSecret(deps, { authorization: grants.runtime, credentialId });
  return { before, migrated, after };
}

beforeEach(() => {
  store = inMemorySecretsStore();
  grants = inMemoryGrants();
});

describe("a format-2 row written by auth.ts opens after migration", () => {
  it("returns the extraction source's plaintext through the runtime read path", async () => {
    const subject = vector("format 2, a TOTP secret as `beginTotpEnrollment` stores one");
    const { after } = await migrateAndRead(subject);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.reveal()).toBe(subject.plaintext);
  });

  it("was unreadable BEFORE the migration and is readable after", async () => {
    // The refusal is gone, and this case is the before/after that says so. It is
    // one case rather than two so the two halves cannot drift onto different
    // credentials.
    const subject = vector("format 2, a longer payload under a second key");
    const { before, after } = await migrateAndRead(subject);
    expect(before.ok).toBe(false);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.reveal()).toBe(subject.plaintext);
  });

  it("carries multi-byte UTF-8 through both ciphers without loss", async () => {
    const subject = vector("format 2, non-ASCII plaintext under a third key");
    const { after } = await migrateAndRead(subject);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.reveal()).toBe(subject.plaintext);
  });
});

describe("a format-3 row written by the agent's SecretsService opens after migration", () => {
  it("returns the extraction source's plaintext through the runtime read path", async () => {
    const subject = vector("format 3, an API key as `SecretsService.encrypt` stores one");
    const { after } = await migrateAndRead(subject);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.reveal()).toBe(subject.plaintext);
  });

  it("was unreadable BEFORE the migration and is readable after", async () => {
    const subject = vector("format 3, a service-account JSON fragment under a second key");
    const { before, after } = await migrateAndRead(subject);
    expect(before.ok).toBe(false);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.reveal()).toBe(subject.plaintext);
  });

  it("carries multi-byte UTF-8 through both ciphers without loss", async () => {
    const subject = vector("format 3, non-ASCII plaintext under a third key");
    const { after } = await migrateAndRead(subject);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.reveal()).toBe(subject.plaintext);
  });
});

describe("what the migrated row IS", () => {
  it("is format 1 under the ACTIVE root key version, not the format it came from", async () => {
    const subject = vector("format 2, a TOTP secret as `beginTotpEnrollment` stores one");
    const { migrated } = await migrateAndRead(subject);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.value.activeSecretVersion).toMatchObject({
      formatVersion: 1,
      rootKeyVersion: ACTIVE_ROOT_KEY_VERSION,
      secretRevision: 1,
    });
  });

  it("carries a 32-byte salt and a 12-byte nonce the legacy row never had", async () => {
    // THE WIDTHS THE CANONICAL ROW'S CHECK CONSTRAINTS DEMAND, and the ones both
    // legacy formats fail: `octet_length(salt) = 32` and `octet_length(nonce) =
    // 12`. A migration that had somehow carried the legacy bytes across would
    // produce a row PostgreSQL refuses, and this case would say so before the
    // database had to.
    const subject = vector("format 3, an API key as `SecretsService.encrypt` stores one");
    await migrateAndRead(subject);
    const [version] = store.allVersions();
    expect(version?.salt).toHaveLength(32);
    expect(version?.nonce).toHaveLength(12);
    expect(version?.authTag).toHaveLength(16);
  });

  it("is bound to its own row: the sealed bytes differ from the legacy bytes", async () => {
    // The legacy envelope bound no context; the canonical one binds environment,
    // credential, revision, format and root key version inside the associated
    // data. The ciphertexts therefore cannot be the same bytes, and a migration
    // that copied rather than re-sealed would be caught here.
    const subject = vector("format 2, a TOTP secret as `beginTotpEnrollment` stores one");
    await migrateAndRead(subject);
    const [version] = store.allVersions();
    const legacyBytes = Buffer.from(subject.payload.split(".")[2] ?? "", "base64url");
    expect(Buffer.from(version?.ciphertext ?? new Uint8Array()).equals(legacyBytes)).toBe(false);
  });

  it("records the MIGRATE audit naming the destination key and no source key", async () => {
    const subject = vector("format 2, a TOTP secret as `beginTotpEnrollment` stores one");
    await migrateAndRead(subject);
    expect(store.allAudits().find((row) => row.action === "MIGRATE")).toMatchObject({
      fromRootKeyVersion: null,
      toRootKeyVersion: ACTIVE_ROOT_KEY_VERSION,
    });
  });
});

describe("the negative controls that keep the six positives honest", () => {
  it("refuses the vector under a root key ring that never held its legacy key", async () => {
    // Same vector, same format, the legacy key simply absent. If the six positives
    // above were opening by some path other than the configured legacy key, this
    // would still succeed.
    const subject = vector("format 2, a TOTP secret as `beginTotpEnrollment` stores one");
    const ring = createRootKeyRing({
      activeVersion: ACTIVE_ROOT_KEY_VERSION,
      keys: { [String(ACTIVE_ROOT_KEY_VERSION)]: ROOT_KEY_HEX },
    });
    if (!ring.ok) throw new Error("root key ring did not build");
    const adapter = createKeyringEnvelopeAdapter(ring.value);
    const opened = await adapter.openLegacy({ formatVersion: 2, payload: subject.payload });
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.details?.reason).toBe("legacy_key_absent_for_format");
  });

  it("cannot seal a legacy format even with the legacy key present", async () => {
    // `seal` reaches the ring, and the legacy keys are deliberately NOT in it. So
    // there is no version to name, no handle to mint, and the write side of the
    // legacy formats stays unreachable by construction rather than by a check.
    const subject = vector("format 2, a TOTP secret as `beginTotpEnrollment` stores one");
    const ring = createRootKeyRing({
      activeVersion: ACTIVE_ROOT_KEY_VERSION,
      keys: { [String(ACTIVE_ROOT_KEY_VERSION)]: ROOT_KEY_HEX },
    });
    if (!ring.ok) throw new Error("root key ring did not build");
    createKeyringEnvelopeAdapter(ring.value, legacyKeysFor(subject));
    const read = ring.value.state();
    if (!read.ok) throw new Error(`ring state unreadable: ${read.error.code}`);
    const state = read.value;
    expect(state.presentVersions).toEqual([ACTIVE_ROOT_KEY_VERSION]);
    expect(state.presentVersions).not.toContain(2);
    expect(state.presentVersions).not.toContain(3);
  });
});
