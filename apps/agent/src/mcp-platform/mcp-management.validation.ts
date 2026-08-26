import { BadRequestException } from "@nestjs/common";

const IDENTITY_MODES = ["bearer", "oidc", "anonymous"] as const;

export function validateMcpIdentityMode(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new BadRequestException("identityMode must be a non-empty string");
  }
  const modes = value.split("+");
  if (
    modes.some((mode) => !IDENTITY_MODES.includes(mode as (typeof IDENTITY_MODES)[number])) ||
    new Set(modes).size !== modes.length
  ) {
    throw new BadRequestException(
      "identityMode must contain unique bearer, oidc, and anonymous modes joined by +",
    );
  }
  return modes.join("+");
}

export function validateIdentityProviders(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException("identityProviders must be a JSON array");
  }
  if (value.some((provider) => !provider || typeof provider !== "object" || Array.isArray(provider))) {
    throw new BadRequestException("identityProviders entries must be JSON objects");
  }
  return value;
}
