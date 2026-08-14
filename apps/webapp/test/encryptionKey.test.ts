import { describe, expect, it } from "vitest";
import { decryptToken } from "~/utils/tokens.server";
import { isAes256KeyHex, isAes256KeyInput, normalizeAes256Key } from "~/utils/encryptionKey.server";

describe("normalizeAes256Key", () => {
  it("decodes the canonical 64-hex format to exactly 32 bytes", () => {
    const keyHex = "ab".repeat(32);

    expect(isAes256KeyHex(keyHex)).toBe(true);
    expect(normalizeAes256Key(keyHex)).toEqual(Buffer.alloc(32, 0xab));
  });

  it("preserves exact bytes for existing 32-byte UTF-8 keys", () => {
    const legacyKey = "legacy-key-material-32-bytes!!!!";

    expect(isAes256KeyHex(legacyKey)).toBe(false);
    expect(isAes256KeyInput(legacyKey)).toBe(true);
    expect(normalizeAes256Key(legacyKey)).toEqual(Buffer.from(legacyKey, "utf8"));
  });

  it("decrypts a historical ciphertext fixture written with legacy key bytes", () => {
    expect(
      decryptToken(
        "00112233445566778899aabb",
        "f380cd5655a6d124d31e54a2fdefe81aec",
        "ff3d0dc5b5dc79cc3f24b49c0a3c030a",
        "legacy-key-material-32-bytes!!!!"
      )
    ).toBe("historical secret");
  });

  it("rejects malformed inputs that are neither supported representation", () => {
    expect(() => normalizeAes256Key("short-key")).toThrow(/64 hex.*32-byte UTF-8/i);
    expect(() => normalizeAes256Key("é".repeat(32))).toThrow(/64 hex.*32-byte UTF-8/i);
  });
});
