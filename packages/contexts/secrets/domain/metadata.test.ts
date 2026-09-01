import { asIdentifier } from "@platos/kernel";
import type { EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { Credential } from "./credential.js";
import { asSecretsIdentifier } from "./ids.js";
import type { ActorId, CredentialId, RootKeyVersion, SecretRevision, SecretVersionId } from "./ids.js";
import {
  CREDENTIAL_METADATA_FIELDS,
  SECRET_VERSION_METADATA_FIELDS,
  WITHHELD_CREDENTIAL_FIELDS,
  toCredentialMetadata,
  toSecretVersionMetadata,
} from "./metadata.js";
import type { CredentialSecretVersion } from "./secret-version.js";

const SENTINEL = "sentinel-provider-secret";
const environmentId = asIdentifier<EnvironmentId>("env-1");
const credentialId = asSecretsIdentifier<CredentialId>("cred-1");
const at = new Date("2026-01-01T00:00:00.000Z");

function bytesOf(text: string): Uint8Array {
  return Uint8Array.from([...text].map((character) => character.charCodeAt(0)));
}

const version: CredentialSecretVersion = {
  id: asSecretsIdentifier<SecretVersionId>("ver-1"),
  credentialId,
  secretRevision: 4 as SecretRevision,
  formatVersion: 1,
  rootKeyVersion: 2 as RootKeyVersion,
  salt: bytesOf(SENTINEL),
  nonce: bytesOf(SENTINEL),
  ciphertext: bytesOf(SENTINEL),
  authTag: bytesOf(SENTINEL),
  retiredAt: null,
  readableUntil: null,
  createdAt: at,
};

const credential: Credential = {
  id: credentialId,
  environmentId,
  kind: "SERVICE_CREDENTIAL",
  name: "OPENAI_API_KEY",
  provider: "openai",
  prefix: "sk",
  permissions: ["read"],
  allowedOrigins: [],
  externalClientId: null,
  activeSecretVersionId: version.id,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdBy: asSecretsIdentifier<ActorId>("user-1"),
  createdAt: at,
  updatedAt: at,
  secretHash: `hash-of-${SENTINEL}`,
  encryptedReference: `legacy-envelope-${SENTINEL}`,
};

interface Walked {
  readonly keys: readonly string[];
  readonly strings: readonly string[];
  readonly byteArrays: number;
}

function walk(value: unknown, seen: { keys: string[]; strings: string[]; byteArrays: number }): void {
  if (value instanceof Uint8Array) {
    seen.byteArrays += 1;
    return;
  }
  if (typeof value === "string") {
    seen.strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, seen);
    return;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, entry] of Object.entries(value)) {
      seen.keys.push(key);
      walk(entry, seen);
    }
  }
}

function inspectProjection(value: unknown): Walked {
  const seen = { keys: [] as string[], strings: [] as string[], byteArrays: 0 };
  walk(value, seen);
  return seen;
}

describe("the read model provably carries no secret material", () => {
  const projection = toCredentialMetadata(credential, version);
  const walked = inspectProjection(projection);

  it("exposes exactly the enumerated fields and no others", () => {
    expect(Object.keys(projection)).toEqual([...CREDENTIAL_METADATA_FIELDS]);
    expect(Object.keys(projection.activeSecretVersion ?? {})).toEqual([
      ...SECRET_VERSION_METADATA_FIELDS,
    ]);
  });

  it("carries not one byte array anywhere in the graph", () => {
    expect(walked.byteArrays).toBe(0);
  });

  it("mentions none of the withheld field names at any depth", () => {
    for (const withheld of WITHHELD_CREDENTIAL_FIELDS) {
      expect(walked.keys).not.toContain(withheld);
    }
  });

  it("contains no string carrying the sentinel, however nested", () => {
    for (const text of walked.strings) expect(text).not.toContain(SENTINEL);
    expect(JSON.stringify(projection)).not.toContain(SENTINEL);
  });

  it("still tells an operator what they need to reason about rotation", () => {
    expect(projection.activeSecretVersion).toMatchObject({
      secretRevision: 4,
      formatVersion: 1,
      rootKeyVersion: 2,
    });
  });

  it("is frozen, so a caller cannot graft material onto it downstream", () => {
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(toSecretVersionMetadata(version))).toBe(true);
  });

  it("reports a revoked credential with no active version at all", () => {
    const revoked = toCredentialMetadata(
      { ...credential, revokedAt: at, activeSecretVersionId: null },
      null,
    );
    expect(revoked.activeSecretVersion).toBeNull();
    expect(revoked.revokedAt).toBe(at);
  });
});
