import { RunEngineVersion } from "@platos/database";

/**
 * Deprecated helper retained so callers that still accept an optional engine version
 * continue to compile. After Theme R2, only V2 exists — this always returns V2.
 */
export async function determineEngineVersion(_: {
  environment: unknown;
  workerVersion?: string;
  engineVersion?: RunEngineVersion;
}): Promise<RunEngineVersion> {
  return "V2";
}
