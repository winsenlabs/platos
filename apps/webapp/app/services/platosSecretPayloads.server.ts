export type SafeProviderKey = {
  id: string;
  credentialId: string;
  provider: string;
  label: string;
  referenceName: string;
  isDefault: boolean;
  status: "healthy" | "verifying" | "failed" | "unknown";
  createdAt: string;
  lastUsedAt: string | null;
  updatedAt: string | null;
};

export type SafeAccessKey = {
  id: string;
  keyPrefix: string;
  allowedOrigins: string[];
  lastUsedAt: string | null;
  validUntil: string | null;
  replacedById: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
};

export type SafeAccessKeyPayload = {
  key: SafeAccessKey | null;
  retiringKey: SafeAccessKey | null;
};

const PROVIDER_STATUSES = new Set<SafeProviderKey["status"]>([
  "healthy",
  "verifying",
  "failed",
  "unknown",
]);

export function sanitizeProviderKeysPayload(payload: unknown): SafeProviderKey[] {
  if (!isRecord(payload) || !Array.isArray(payload.keys)) return [];

  return payload.keys.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = stringValue(value.id);
    const credentialId = stringValue(value.credentialId);
    const provider = stringValue(value.provider);
    const label = stringValue(value.label);
    const referenceName = stringValue(
      value.referenceName ?? value.environmentKeyName ?? value.envVarName
    );
    const createdAt = dateString(value.createdAt);
    if (!id || !credentialId || !provider || !label || !referenceName || !createdAt) return [];

    const rawStatus = stringValue(value.status ?? value.healthStatus)?.toLowerCase();
    const status = PROVIDER_STATUSES.has(rawStatus as SafeProviderKey["status"])
      ? (rawStatus as SafeProviderKey["status"])
      : value.envVarSet === false
      ? "failed"
      : "unknown";

    return [
      {
        id,
        credentialId,
        provider,
        label,
        referenceName,
        isDefault: value.isDefault === true,
        status,
        createdAt,
        lastUsedAt: nullableDateString(value.lastUsedAt),
        updatedAt: nullableDateString(value.updatedAt),
      },
    ];
  });
}

export function sanitizeAccessKeyPayload(payload: unknown): SafeAccessKeyPayload {
  if (!isRecord(payload)) return { key: null, retiringKey: null };

  if (Array.isArray(payload.keys)) {
    const keys = payload.keys
      .map(sanitizeAccessKey)
      .filter((key): key is SafeAccessKey => key !== null);
    const active = keys.find((key) => !key.revokedAt && !key.validUntil) ?? null;
    const retiring =
      keys
        .filter((key) => !key.revokedAt && key.validUntil)
        .sort((a, b) => Date.parse(b.validUntil ?? "") - Date.parse(a.validUntil ?? ""))[0] ?? null;
    return { key: active, retiringKey: retiring };
  }

  return {
    key: sanitizeAccessKey(payload.key),
    retiringKey: sanitizeAccessKey(payload.retiringKey),
  };
}

export function safeMutationResult(intent: string, payload?: unknown) {
  const accessKeys = sanitizeAccessKeyPayload(payload);
  return {
    ok: true as const,
    intent,
    ...(accessKeys.key ? { key: accessKeys.key } : {}),
    ...(accessKeys.retiringKey ? { retiringKey: accessKeys.retiringKey } : {}),
  };
}

function sanitizeAccessKey(value: unknown): SafeAccessKey | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const keyPrefix = stringValue(value.keyPrefix);
  const createdAt = dateString(value.createdAt);
  if (!id || !keyPrefix || !createdAt) return null;

  return {
    id,
    keyPrefix,
    allowedOrigins: Array.isArray(value.allowedOrigins)
      ? value.allowedOrigins.filter((origin): origin is string => typeof origin === "string")
      : [],
    lastUsedAt: nullableDateString(value.lastUsedAt),
    validUntil: nullableDateString(value.validUntil),
    replacedById: nullableString(value.replacedById),
    revokedAt: nullableDateString(value.revokedAt),
    createdAt,
    updatedAt: nullableDateString(value.updatedAt),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function nullableDateString(value: unknown): string | null {
  return value === null || value === undefined ? null : dateString(value);
}
