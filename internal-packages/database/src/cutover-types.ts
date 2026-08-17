import type { ExternalCutoverReportFragment } from "./cutover-external";
import type { CredentialRootKeyRing } from "./secrets";

export type CutoverMode = "DRY_RUN" | "CORE_REHEARSAL_ROLLBACK" | "FULL_EXECUTE";

export type CutoverState =
  | "PREFLIGHT_BLOCKED"
  | "PREFLIGHT_READY"
  | "INCOMPLETE_IMPLEMENTATION"
  | "ROLLED_BACK"
  | "COMMITTED"
  | "RESTORE_REQUIRED";

export type CutoverCheckStatus = "PASS" | "BLOCK" | "INCOMPLETE";

export interface CutoverCheck {
  readonly id: string;
  readonly status: CutoverCheckStatus;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CutoverAttestations {
  readonly executeAcceptance?: string;
  readonly backupAttestationRef?: string;
  readonly backupRestoreTestRef?: string;
  readonly irreversibleEffectsAcceptance?: string;
  readonly writerFenceAttestationRef?: string;
  readonly capacityAttestationRef?: string;
}

export interface CutoverOptions {
  readonly databaseUrl: string;
  readonly mode: CutoverMode;
  readonly attestations: CutoverAttestations;
  readonly reportDirectory?: string;
  readonly exportDirectory?: string;
  readonly freshCatalogDatabaseUrl?: string;
  readonly requiredKeyEnvironment?: Readonly<Record<string, boolean>>;
  readonly keyMaterial?: {
    readonly legacyEncryptionKey?: string;
    readonly targetAuthEncryptionKey?: string;
    readonly messageEncryptionKeys?: Readonly<Record<string, string>>;
    readonly credentialRootKeyRing?: CredentialRootKeyRing;
  };
  readonly forcedFailurePhase?: string;
}

export interface CutoverPhaseResult {
  readonly phase: string;
  readonly status: "SUCCEEDED" | "BLOCKED" | "ROLLED_BACK" | "FAILED" | "NOT_RUN";
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly summary: string;
}

export interface SourceDigest {
  readonly sourceModel: string;
  readonly rowCount: string;
  readonly identityDigest: string;
}

export interface CutoverReport {
  readonly reportVersion: 1;
  readonly runId: string;
  readonly mappingVersion: number;
  readonly mappingNamespace: string;
  readonly mode: CutoverMode;
  readonly state: CutoverState;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: readonly CutoverCheck[];
  readonly phases: readonly CutoverPhaseResult[];
  readonly sourceDigests: readonly SourceDigest[];
  readonly external?: ExternalCutoverReportFragment;
  readonly incompletePhaseIds: readonly string[];
  readonly backupAttestationRef?: string;
  readonly backupRestoreTestRef?: string;
  readonly writerFenceAttestationRef?: string;
  readonly capacityAttestationRef?: string;
  readonly reportSha256?: string;
}

export interface QueryResultLike<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface CutoverDatabase {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<QueryResultLike<Row>>;
}

export class CutoverFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly restoreRequired = false
  ) {
    super(message);
    this.name = "CutoverFailure";
  }
}
