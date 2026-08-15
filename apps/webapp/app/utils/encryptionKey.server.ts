const AES_256_KEY_HEX = /^[0-9a-f]{64}$/i;

/**
 * Decode AES-256-GCM deployment input without changing historical key bytes.
 * New keys use 64 hex chars; existing exact 32-byte UTF-8 keys remain valid.
 */
export function normalizeAes256Key(key: string, name = "encryption key"): Buffer {
  if (AES_256_KEY_HEX.test(key)) {
    return Buffer.from(key, "hex");
  }

  const legacy = Buffer.from(key, "utf8");
  if (legacy.length === 32) return legacy;

  throw new Error(`${name} must be 64 hex characters or an existing 32-byte UTF-8 key`);
}

export function isAes256KeyHex(value: string): boolean {
  return AES_256_KEY_HEX.test(value);
}

export function isAes256KeyInput(value: string): boolean {
  try {
    return normalizeAes256Key(value).length === 32;
  } catch {
    return false;
  }
}
