import { asIdentifier, isOk } from "@platos/kernel";
import type { EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  CANONICAL_ENVELOPE_FORMAT,
  ENVELOPE_FORMAT_VERSIONS,
  envelopeAad,
  envelopeFormat,
  envelopeKeyInfo,
  isEnvelopeFormatVersion,
  requireWritableFormat,
  sameBinding,
} from "./envelope.js";
import type { EnvelopeBinding } from "./envelope.js";
import { asSecretsIdentifier } from "./ids.js";
import type { CredentialId, RootKeyVersion, SecretRevision } from "./ids.js";

const binding: EnvelopeBinding = {
  environmentId: asIdentifier<EnvironmentId>("22222222-2222-4222-8222-222222222222"),
  credentialId: asSecretsIdentifier<CredentialId>("11111111-1111-4111-8111-111111111111"),
  secretRevision: 1 as SecretRevision,
  formatVersion: 1,
  rootKeyVersion: 1 as RootKeyVersion,
};

// The field separator the extraction source uses, built rather than typed so this
// file stays free of a raw control character.
const NUL = String.fromCharCode(0);
const SERIALIZED = [
  "22222222-2222-4222-8222-222222222222",
  "11111111-1111-4111-8111-111111111111",
  "1",
  "1",
  "1",
].join(NUL);

describe("the envelope format union is closed and only one member is writable", () => {
  it("names exactly the three formats the pre-V1 codebase actually wrote", () => {
    expect([...ENVELOPE_FORMAT_VERSIONS]).toEqual([1, 2, 3]);
    expect(envelopeFormat(1).name).toBe("hkdf-sha256.aes-256-gcm.context-bound");
    expect(envelopeFormat(2).legacyOrigin).toBe("internal-packages/tenancy-database/src/auth.ts");
    expect(envelopeFormat(3).legacyOrigin).toBe("apps/agent/src/auth/secrets.service.ts");
  });

  it("keeps the shape differences that make the three mutually unreadable", () => {
    expect(envelopeFormat(1)).toMatchObject({ saltBytes: 32, nonceBytes: 12, bindsContext: true });
    expect(envelopeFormat(2)).toMatchObject({ saltBytes: 0, nonceBytes: 12, bindsContext: false });
    expect(envelopeFormat(3)).toMatchObject({ saltBytes: 0, nonceBytes: 16, bindsContext: false });
  });

  it("permits writing the canonical format and refuses both legacy ones", () => {
    expect(CANONICAL_ENVELOPE_FORMAT).toBe(1);
    expect(isOk(requireWritableFormat(1))).toBe(true);
    for (const legacy of [2, 3] as const) {
      const refused = requireWritableFormat(legacy);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("ENVELOPE_FORMAT_UNWRITABLE");
    }
  });

  it("rejects a version outside the union", () => {
    expect(isEnvelopeFormatVersion(4)).toBe(false);
    expect(isEnvelopeFormatVersion(1)).toBe(true);
  });

  it("marks only the canonical format as participating in root key rotation", () => {
    expect(envelopeFormat(1).versionedRootKey).toBe(true);
    expect(envelopeFormat(2).versionedRootKey).toBe(false);
    expect(envelopeFormat(3).versionedRootKey).toBe(false);
  });
});

describe("the derivation and authentication labels are wire-compatible", () => {
  it("reproduces the extraction source's labels byte for byte", () => {
    expect(envelopeKeyInfo(binding)).toBe(`platos:credential-secret:v1:key:${SERIALIZED}`);
    expect(envelopeAad(binding)).toBe(`platos:credential-secret:v1:aad:${SERIALIZED}`);
  });

  it("separates fields with NUL so no field value can forge a boundary", () => {
    expect(envelopeAad(binding).split(NUL)).toHaveLength(5);
  });

  it.each([
    ["environment", { environmentId: asIdentifier<EnvironmentId>("33333333") }],
    ["credential", { credentialId: asSecretsIdentifier<CredentialId>("44444444") }],
    ["revision", { secretRevision: 2 as SecretRevision }],
    ["format", { formatVersion: 2 as const }],
    ["root key version", { rootKeyVersion: 2 as RootKeyVersion }],
  ])("changes the authenticated data when the %s changes", (_label, patch) => {
    const moved: EnvelopeBinding = { ...binding, ...patch };
    expect(envelopeAad(moved)).not.toBe(envelopeAad(binding));
    expect(envelopeKeyInfo(moved)).not.toBe(envelopeKeyInfo(binding));
    expect(sameBinding(moved, binding)).toBe(false);
  });

  it("treats two structurally identical bindings as the same slot", () => {
    expect(sameBinding({ ...binding }, binding)).toBe(true);
  });
});
