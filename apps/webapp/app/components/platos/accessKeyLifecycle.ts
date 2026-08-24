const ACCESS_KEY_PREFIX_PATTERN = /^platos_live_[A-Za-z0-9_-]{1,12}$/;
const ACCESS_KEY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export type PendingAccessKey = {
  attemptId: string;
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
};

export type AccessKeySubmission = Omit<PendingAccessKey, "rawKey">;

export type AccessKeySettlement =
  | { status: "revealed"; rawKey: string }
  | { status: "discarded" }
  | { status: "ignored" };

export function isAccessKeyAttemptId(value: string): boolean {
  return ATTEMPT_ID_PATTERN.test(value);
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
    attemptId: crypto.randomUUID(),
    rawKey,
    keyHash,
    keyPrefix: rawKey.slice(0, 24),
  };
}

/** Keeps raw bearer material private until the matching persisted response. */
export class AccessKeyRevealLifecycle {
  #pending = new Map<string, PendingAccessKey>();
  #currentAttemptId: string | null = null;

  get hasPending(): boolean {
    return this.#currentAttemptId !== null;
  }

  begin(pending: PendingAccessKey): AccessKeySubmission {
    if (
      !isAccessKeyAttemptId(pending.attemptId) ||
      !ACCESS_KEY_HASH_PATTERN.test(pending.keyHash) ||
      !ACCESS_KEY_PREFIX_PATTERN.test(pending.keyPrefix) ||
      !pending.rawKey.startsWith(`${pending.keyPrefix}`)
    ) {
      throw new Error("invalid_access_key_material");
    }

    this.cancel();
    this.#pending.set(pending.attemptId, { ...pending });
    this.#currentAttemptId = pending.attemptId;
    return {
      attemptId: pending.attemptId,
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
    const attemptId = typeof record.attemptId === "string" ? record.attemptId : null;
    if (!attemptId || attemptId !== this.#currentAttemptId) {
      if (attemptId) this.#pending.delete(attemptId);
      return { status: "ignored" };
    }

    const pending = this.#pending.get(attemptId);
    this.cancel(attemptId);
    if (!pending || record.ok !== true) return { status: "discarded" };
    return { status: "revealed", rawKey: pending.rawKey };
  }

  cancel(attemptId?: string): void {
    if (attemptId !== undefined && attemptId !== this.#currentAttemptId) {
      this.#pending.delete(attemptId);
      return;
    }
    this.#pending.clear();
    this.#currentAttemptId = null;
  }

  toJSON(): string {
    return "[AccessKeyRevealLifecycle redacted]";
  }

  [INSPECT](): string {
    return "[AccessKeyRevealLifecycle redacted]";
  }
}
