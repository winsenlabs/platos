export type GeneratedAccessKey = {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
};

export async function generateAccessKey(
  cryptoApi: Pick<Crypto, "getRandomValues" | "subtle"> = globalThis.crypto
): Promise<GeneratedAccessKey> {
  const random = cryptoApi.getRandomValues(new Uint8Array(32));
  const rawKey = `platos_live_${toBase64Url(random)}`;
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));

  return {
    rawKey,
    keyHash: toHex(new Uint8Array(digest)),
    keyPrefix: rawKey.slice(0, 18),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
