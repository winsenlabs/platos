export type ProviderRuntimeErrorCode =
  | "provider_configuration_unavailable"
  | "provider_credential_unavailable"
  | "provider_request_failed"
  | "model_pricing_unavailable";

const SAFE_MESSAGES: Record<ProviderRuntimeErrorCode, string> = {
  provider_configuration_unavailable: "Provider configuration is unavailable for this environment.",
  provider_credential_unavailable: "Provider credential is unavailable for this environment.",
  provider_request_failed: "Provider request failed.",
  model_pricing_unavailable: "Canonical model pricing is unavailable.",
};

/** Stable runtime error that never contains credential, database, crypto, or upstream response detail. */
export class ProviderRuntimeError extends Error {
  readonly name = "ProviderRuntimeError";

  constructor(public readonly code: ProviderRuntimeErrorCode) {
    super(SAFE_MESSAGES[code]);
  }

  toJSON(): { name: "ProviderRuntimeError"; code: ProviderRuntimeErrorCode; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export function asSafeProviderRuntimeError(error: unknown): ProviderRuntimeError {
  return error instanceof ProviderRuntimeError
    ? error
    : new ProviderRuntimeError("provider_request_failed");
}
