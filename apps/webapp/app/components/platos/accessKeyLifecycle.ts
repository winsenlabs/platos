const ACCESS_KEY_PREFIX_PATTERN = /^platos_live_[A-Za-z0-9_-]{1,12}$/;
const ACCESS_KEY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export type PendingAccessKey = {
  requestId: string;
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
};

export type AccessKeySubmission = Omit<PendingAccessKey, "rawKey">;

export type AccessKeySettlement =
  | { status: "revealed"; rawKey: string }
  | { status: "discarded" }
  | { status: "ignored" };

export function isAccessKeyRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function generatePendingAccessKey(): Promise<PendingAccessKey> {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  const rawKey = `platos_live_${base64Url(secret)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  const keyHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    requestId: crypto.randomUUID(),
    rawKey,
    keyHash,
    keyPrefix: rawKey.slice(0, 24),
  };
}

export async function beginGeneratedAccessKey(
  lifecycle: AccessKeyRevealLifecycle,
  generate: () => Promise<PendingAccessKey> = generatePendingAccessKey,
): Promise<AccessKeySubmission | null> {
  const pending = await generate();
  if (lifecycle.disposed) return null;
  return lifecycle.begin(pending);
}

/** Keeps raw bearer material private until the matching persisted response. */
export class AccessKeyRevealLifecycle {
  #pending = new Map<string, PendingAccessKey>();
  #currentRequestId: string | null = null;
  #disposed = false;

  get hasPending(): boolean {
    return this.#currentRequestId !== null;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  begin(pending: PendingAccessKey): AccessKeySubmission {
    if (this.#disposed) throw new Error("access_key_lifecycle_disposed");
    if (
      !isAccessKeyRequestId(pending.requestId) ||
      !ACCESS_KEY_HASH_PATTERN.test(pending.keyHash) ||
      !ACCESS_KEY_PREFIX_PATTERN.test(pending.keyPrefix) ||
      !pending.rawKey.startsWith(`${pending.keyPrefix}`)
    ) {
      throw new Error("invalid_access_key_material");
    }

    this.cancel();
    this.#pending.set(pending.requestId, { ...pending });
    this.#currentRequestId = pending.requestId;
    return {
      requestId: pending.requestId,
      keyHash: pending.keyHash,
      keyPrefix: pending.keyPrefix,
    };
  }

  settle(response: unknown): AccessKeySettlement {
    if (response === null || typeof response !== "object" || Array.isArray(response)) {
      this.cancel();
      return { status: "discarded" };
    }
    const record = response as Record<string, unknown>;
    const requestId = typeof record.requestId === "string" ? record.requestId : null;
    if (!requestId || requestId !== this.#currentRequestId) {
      if (requestId) this.#pending.delete(requestId);
      return { status: "ignored" };
    }

    const pending = this.#pending.get(requestId);
    this.cancel(requestId);
    const result = record.result !== null && typeof record.result === "object" && !Array.isArray(record.result)
      ? record.result as Record<string, unknown>
      : {};
    const key = result.key !== null && typeof result.key === "object" && !Array.isArray(result.key)
      ? result.key as Record<string, unknown>
      : {};
    if (
      !pending ||
      record.ok !== true ||
      result.requestId !== requestId ||
      typeof key.id !== "string" ||
      key.id.trim() === "" ||
      key.keyPrefix !== pending.keyPrefix
    ) return { status: "discarded" };
    return { status: "revealed", rawKey: pending.rawKey };
  }

  cancel(requestId?: string): void {
    if (requestId !== undefined && requestId !== this.#currentRequestId) {
      this.#pending.delete(requestId);
      return;
    }
    this.#pending.clear();
    this.#currentRequestId = null;
  }

  dispose(): void {
    this.cancel();
    this.#disposed = true;
  }

  toJSON(): string {
    return "[AccessKeyRevealLifecycle redacted]";
  }

  [INSPECT](): string {
    return "[AccessKeyRevealLifecycle redacted]";
  }
}
