#!/usr/bin/env node

import { runCutover } from "./cutover-engine";
import {
  CUTOVER_REQUIRED_KEY_ENVIRONMENT,
} from "./cutover-preflight";
import { serializeCutoverReport } from "./cutover-report";
import { CredentialRootKeyRing } from "./secrets";
import type { CutoverMode, CutoverOptions } from "./cutover-types";
import { parseCutoverRehearsalConfig } from "./cutover-external-executor";

export interface ParsedCutoverArguments {
  readonly mode: CutoverMode;
  readonly backupAttestationRef?: string;
  readonly backupRestoreTestRef?: string;
  readonly capacityAttestationRef?: string;
  readonly executeAcceptance?: string;
  readonly irreversibleEffectsAcceptance?: string;
  readonly writerFenceAttestationRef?: string;
  readonly reportDirectory?: string;
  readonly exportDirectory?: string;
  readonly exportKeyEnvironment: string;
  readonly exportKeyReference?: string;
  readonly freshCatalogDatabaseUrlEnvironment: string;
  readonly forcedFailurePhase?: string;
  readonly enableExternalRehearsal: boolean;
  readonly externalRehearsalOperationId?: string;
  readonly resumeExternalRehearsal: boolean;
}

const EXPORT_KEY_ENVIRONMENT = /^[A-Z_][A-Z0-9_]*$/;
const EXPORT_KEY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;
const EXTERNAL_REHEARSAL_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function resolveCutoverMessageEncryptionKeyVersion(
  environment: Readonly<Record<string, string | undefined>>
): number {
  const configuredVersion = Number(environment.PLATOS_MESSAGE_ENCRYPTION_KEY_V ?? "1");
  return Number.isSafeInteger(configuredVersion) && configuredVersion > 0 ? configuredVersion : 1;
}

export function parseCutoverArguments(argv: readonly string[]): ParsedCutoverArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--accept-execute",
    "--accept-irreversible-effects",
    "--backup-attestation-ref",
    "--backup-restore-test-ref",
    "--capacity-attestation-ref",
    "--writer-fence-attestation-ref",
    "--report-dir",
    "--export-dir",
    "--export-key-env",
    "--export-key-reference",
    "--fresh-catalog-database-url-env",
    "--force-failure-after-phase",
    "--external-rehearsal-operation-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      continue;
    } else if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      values.set(argument, value);
      index += 1;
    } else if (["--execute", "--core-rehearsal", "--force-rollback-before-commit", "--enable-external-rehearsal", "--resume-external-rehearsal"].includes(argument)) {
      flags.add(argument);
    } else {
      throw new Error(`unknown db:cutover argument: ${argument}`);
    }
  }

  if (flags.has("--core-rehearsal") !== flags.has("--force-rollback-before-commit")) {
    throw new Error("core rehearsal requires --force-rollback-before-commit and cannot commit");
  }
  if (flags.has("--core-rehearsal") && !flags.has("--execute")) {
    throw new Error("core rehearsal requires the explicit --execute flag and all mutation attestations");
  }
  if (flags.has("--enable-external-rehearsal") && !flags.has("--core-rehearsal")) {
    throw new Error("external rehearsal is restricted to the forced-rollback core rehearsal");
  }
  const externalRehearsalOperationId = values.get("--external-rehearsal-operation-id");
  if (flags.has("--enable-external-rehearsal") && !externalRehearsalOperationId) {
    throw new Error("external rehearsal requires --external-rehearsal-operation-id");
  }
  if (externalRehearsalOperationId && !EXTERNAL_REHEARSAL_OPERATION_ID.test(externalRehearsalOperationId)) {
    throw new Error("--external-rehearsal-operation-id must be a canonical lower-case UUID");
  }
  if (!flags.has("--enable-external-rehearsal") && (externalRehearsalOperationId || flags.has("--resume-external-rehearsal"))) {
    throw new Error("external rehearsal operation and resume options require --enable-external-rehearsal");
  }

  const mode: CutoverMode = flags.has("--core-rehearsal")
    ? "CORE_REHEARSAL_ROLLBACK"
    : flags.has("--execute")
      ? "FULL_EXECUTE"
      : "DRY_RUN";
  const exportKeyEnvironment =
    values.get("--export-key-env") ?? "PLATOS_CUTOVER_EXPORT_KEY";
  const exportKeyReference = values.get("--export-key-reference");
  if (!EXPORT_KEY_ENVIRONMENT.test(exportKeyEnvironment)) {
    throw new Error("--export-key-env must name an environment variable");
  }
  if (exportKeyReference !== undefined && !EXPORT_KEY_REFERENCE.test(exportKeyReference)) {
    throw new Error("--export-key-reference is invalid");
  }
  return {
    mode,
    executeAcceptance: values.get("--accept-execute"),
    irreversibleEffectsAcceptance: values.get("--accept-irreversible-effects"),
    backupAttestationRef: values.get("--backup-attestation-ref"),
    backupRestoreTestRef: values.get("--backup-restore-test-ref"),
    capacityAttestationRef: values.get("--capacity-attestation-ref"),
    writerFenceAttestationRef: values.get("--writer-fence-attestation-ref"),
    reportDirectory: values.get("--report-dir"),
    exportDirectory: values.get("--export-dir"),
    exportKeyEnvironment,
    exportKeyReference,
    freshCatalogDatabaseUrlEnvironment:
      values.get("--fresh-catalog-database-url-env") ?? "CUTOVER_FRESH_DATABASE_URL",
    forcedFailurePhase: values.get("--force-failure-after-phase"),
    enableExternalRehearsal: flags.has("--enable-external-rehearsal"),
    externalRehearsalOperationId,
    resumeExternalRehearsal: flags.has("--resume-external-rehearsal"),
  };
}

/** Mirrors the message runtime's active-plus-prior environment key contract. */
export function resolveCutoverMessageEncryptionKeys(
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  const activeVersion = resolveCutoverMessageEncryptionKeyVersion(environment);
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    const match = name.match(/^PLATOS_MESSAGE_ENCRYPTION_KEY_V([1-9][0-9]*)$/);
    if (match && value) keys[match[1]!] = value;
  }
  if (environment.PLATOS_MESSAGE_ENCRYPTION_KEY) {
    keys[String(activeVersion)] = environment.PLATOS_MESSAGE_ENCRYPTION_KEY;
  }
  return Object.freeze(keys);
}

/** Mirrors the runtime's active-plus-prior credential root key-ring contract. */
export function resolveCutoverCredentialRootKeyRing(
  environment: Readonly<Record<string, string | undefined>>
): CredentialRootKeyRing | undefined {
  const activeVersionValue = environment.PLATOS_CREDENTIAL_ROOT_KEY_VERSION;
  const keysValue = environment.PLATOS_CREDENTIAL_ROOT_KEYS;
  if (!activeVersionValue || !keysValue) return undefined;

  try {
    const activeVersion = Number(activeVersionValue);
    const keys = JSON.parse(keysValue) as unknown;
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error();
    return new CredentialRootKeyRing({
      activeVersion,
      keys: keys as Readonly<Record<number, string>>,
    });
  } catch {
    throw new Error("credential root key ring configuration is invalid");
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCutoverArguments(argv);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const externalRehearsalConfig = parsed.enableExternalRehearsal
    ? parseCutoverRehearsalConfig(process.env, {
      operationId: parsed.externalRehearsalOperationId!,
      resume: parsed.resumeExternalRehearsal,
    })
    : undefined;
  if (parsed.enableExternalRehearsal && !externalRehearsalConfig) {
    throw new Error("external rehearsal requires CUTOVER_REHEARSAL_EXTERNAL_ENABLED=1");
  }

  const options: CutoverOptions = {
    databaseUrl: externalRehearsalConfig?.targetDatabaseUrl ?? databaseUrl,
    mode: parsed.mode,
    attestations: {
      executeAcceptance: parsed.executeAcceptance,
      irreversibleEffectsAcceptance: parsed.irreversibleEffectsAcceptance,
      backupAttestationRef: parsed.backupAttestationRef,
      backupRestoreTestRef: parsed.backupRestoreTestRef,
      capacityAttestationRef: parsed.capacityAttestationRef,
      writerFenceAttestationRef: parsed.writerFenceAttestationRef,
    },
    reportDirectory: parsed.reportDirectory,
    exportDirectory: parsed.exportDirectory,
    exportKeyReference: parsed.exportKeyReference,
    freshCatalogDatabaseUrl: process.env[parsed.freshCatalogDatabaseUrlEnvironment],
    requiredKeyEnvironment: Object.fromEntries(
      CUTOVER_REQUIRED_KEY_ENVIRONMENT.map((name) => [
        name,
        name === "PLATOS_CUTOVER_EXPORT_KEY"
          ? Boolean(process.env[parsed.exportKeyEnvironment])
          : Boolean(process.env[name]),
      ])
    ),
    keyMaterial: {
      legacyEncryptionKey: process.env.ENCRYPTION_KEY,
      targetAuthEncryptionKey: process.env.PLATOS_ENCRYPTION_KEY,
      messageEncryptionKeys: resolveCutoverMessageEncryptionKeys(process.env),
      targetMessageEncryptionKey: process.env.PLATOS_MESSAGE_ENCRYPTION_KEY,
      targetMessageEncryptionKeyVersion: resolveCutoverMessageEncryptionKeyVersion(process.env),
      credentialRootKeyRing: resolveCutoverCredentialRootKeyRing(process.env),
      exportSealingKeyHex: process.env[parsed.exportKeyEnvironment],
    },
    forcedFailurePhase: parsed.forcedFailurePhase,
    externalRehearsalConfig,
  };
  const report = await runCutover(options);
  process.stdout.write(serializeCutoverReport(report));
  if (
    (report.state !== "ROLLED_BACK" && report.state !== "COMMITTED") ||
    report.checks.some((entry) => entry.status === "BLOCK")
  ) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`db:cutover: ${error instanceof Error ? error.message : "unexpected failure"}`);
    process.exitCode = 1;
  });
}
