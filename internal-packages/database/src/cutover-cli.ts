#!/usr/bin/env node

import { runCutover } from "./cutover-engine";
import {
  CUTOVER_REQUIRED_KEY_ENVIRONMENT,
} from "./cutover-preflight";
import { serializeCutoverReport } from "./cutover-report";
import type { CutoverMode, CutoverOptions } from "./cutover-types";

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
  readonly freshCatalogDatabaseUrlEnvironment: string;
  readonly forcedFailurePhase?: string;
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
    "--fresh-catalog-database-url-env",
    "--force-failure-after-phase",
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
    } else if (["--execute", "--core-rehearsal", "--force-rollback-before-commit"].includes(argument)) {
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

  const mode: CutoverMode = flags.has("--core-rehearsal")
    ? "CORE_REHEARSAL_ROLLBACK"
    : flags.has("--execute")
      ? "FULL_EXECUTE"
      : "DRY_RUN";
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
    freshCatalogDatabaseUrlEnvironment:
      values.get("--fresh-catalog-database-url-env") ?? "CUTOVER_FRESH_DATABASE_URL",
    forcedFailurePhase: values.get("--force-failure-after-phase"),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCutoverArguments(argv);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const options: CutoverOptions = {
    databaseUrl,
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
    freshCatalogDatabaseUrl: process.env[parsed.freshCatalogDatabaseUrlEnvironment],
    requiredKeyEnvironment: Object.fromEntries(
      CUTOVER_REQUIRED_KEY_ENVIRONMENT.map((name) => [name, Boolean(process.env[name])])
    ),
    forcedFailurePhase: parsed.forcedFailurePhase,
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
