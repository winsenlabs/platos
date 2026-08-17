import { sourceModelManifest } from "./source-model-manifest";
import { legacyIndexCatalog } from "./legacy-index-catalog";

export type CutoverDisposition = "BACKFILL" | "EXPORT_DROP" | "EPHEMERAL_DROP";

const backfillInheritedModels = [
  "User",
  "Organization",
  "OrgMember",
  "OrgMemberInvite",
  "RuntimeEnvironment",
  "Project",
  "SecretReference",
  "SecretStore",
  "ImpersonationAuditLog",
] as const;

const exportDropInheritedModels = [
  "InvitationCode",
  "OrganizationAccessToken",
  "DataMigration",
  "BackgroundWorker",
  "BackgroundWorkerFile",
  "Prompt",
  "PromptVersion",
  "BackgroundWorkerTask",
  "TaskRun",
  "TaskRunTemplate",
  "TaskRunExecutionSnapshot",
  "TaskRunCheckpoint",
  "Waitpoint",
  "TaskRunWaitpoint",
  "WaitpointTag",
  "FeatureFlag",
  "WorkerInstance",
  "WorkerInstanceGroup",
  "WorkerGroupToken",
  "TaskRunTag",
  "TaskRunDependency",
  "TaskRunCounter",
  "TaskRunNumberCounter",
  "TaskRunAttempt",
  "TaskEvent",
  "TaskQueue",
  "BatchTaskRun",
  "BatchTaskRunItem",
  "BatchTaskRunError",
  "EnvironmentVariable",
  "EnvironmentVariableValue",
  "Checkpoint",
  "CheckpointRestoreEvent",
  "WorkerDeployment",
  "WorkerDeploymentPromotion",
  "TaskSchedule",
  "TaskScheduleInstance",
  "ProjectAlertChannel",
  "ProjectAlert",
  "ProjectAlertStorage",
  "OrganizationIntegration",
  "OrganizationProjectIntegration",
  "BulkActionGroup",
  "BulkActionItem",
  "RealtimeStreamChunk",
  "TaskEventPartitioned",
  "GithubAppInstallation",
  "GithubRepository",
  "ConnectedGithubRepository",
  "CustomerQuery",
  "IntegrationDeployment",
  "MetricsDashboard",
  "LlmModel",
  "LlmPricingTier",
  "LlmPrice",
  "PlatformNotification",
  "PlatformNotificationInteraction",
  "ErrorGroupState",
] as const;

const ephemeralDropInheritedModels = [
  // Recovery codes are intentionally invalidated rather than translated.
  "MfaBackupCode",
  // Signed CUID environment/browser sessions are intentionally invalidated.
  "RuntimeEnvironmentSession",
] as const;

const physicalTableOverrides: Readonly<Record<string, string>> = Object.freeze({
  Prompt: "prompts",
  PromptVersion: "prompt_versions",
  LlmModel: "llm_models",
  LlmPricingTier: "llm_pricing_tiers",
  LlmPrice: "llm_prices",
});

export interface LegacyModelDisposition {
  readonly sourceModel: string;
  readonly physicalTable: string;
  readonly disposition: CutoverDisposition;
  readonly targets: readonly string[];
}

function modelEntry(
  sourceModel: string,
  disposition: CutoverDisposition,
  targets: readonly string[] = []
): LegacyModelDisposition {
  return {
    sourceModel,
    physicalTable: physicalTableOverrides[sourceModel] ?? sourceModel,
    disposition,
    targets,
  };
}

const inheritedTargets: Readonly<Record<string, readonly string[]>> = Object.freeze({
  User: ["User", "OperatorIdentity", "OperatorMfaTotp"],
  Organization: ["Organization"],
  OrgMember: ["OrganizationMembership"],
  OrgMemberInvite: ["OrganizationInvitation"],
  RuntimeEnvironment: ["Environment"],
  Project: ["Project", "ProjectMembership"],
  SecretReference: ["OperatorMfaTotp", "Credential", "CredentialSecretVersion"],
  SecretStore: ["OperatorMfaTotp", "CredentialSecretVersion"],
  ImpersonationAuditLog: ["ImpersonationAudit"],
});

/** Exact, single-disposition accounting for all 124 inherited Prisma models. */
export const legacyModelDispositionLedger: readonly LegacyModelDisposition[] = [
  ...backfillInheritedModels.map((name) =>
    modelEntry(name, "BACKFILL", inheritedTargets[name] ?? [])
  ),
  ...sourceModelManifest.map((entry) => modelEntry(entry.source, "BACKFILL", entry.targets)),
  ...exportDropInheritedModels.map((name) => modelEntry(name, "EXPORT_DROP")),
  ...ephemeralDropInheritedModels.map((name) => modelEntry(name, "EPHEMERAL_DROP")),
];

export interface LegacyPhysicalObjectDisposition {
  readonly kind: "IMPLICIT_JOIN_TABLE" | "EXTENSION" | "MIGRATION_HISTORY";
  readonly name: string;
  readonly disposition: CutoverDisposition;
}

/** Physical objects not represented one-for-one by a Prisma model. */
export const legacyAdditionalPhysicalObjectLedger = [
  {
    kind: "IMPLICIT_JOIN_TABLE",
    name: "_BackgroundWorkerToBackgroundWorkerFile",
    disposition: "EXPORT_DROP",
  },
  { kind: "IMPLICIT_JOIN_TABLE", name: "_BackgroundWorkerToTaskQueue", disposition: "EXPORT_DROP" },
  { kind: "IMPLICIT_JOIN_TABLE", name: "_TaskRunToTaskRunTag", disposition: "EXPORT_DROP" },
  { kind: "IMPLICIT_JOIN_TABLE", name: "_WaitpointRunConnections", disposition: "EXPORT_DROP" },
  { kind: "IMPLICIT_JOIN_TABLE", name: "_completedWaitpoints", disposition: "EXPORT_DROP" },
  { kind: "EXTENSION", name: "vector", disposition: "BACKFILL" },
  { kind: "MIGRATION_HISTORY", name: "_prisma_migrations", disposition: "EXPORT_DROP" },
] as const satisfies readonly LegacyPhysicalObjectDisposition[];

/** All 130 inherited physical tables, including joins and Prisma history. */
export const legacyPhysicalTableDispositionLedger = [
  ...legacyModelDispositionLedger.map((entry) => ({
    name: entry.physicalTable,
    disposition: entry.disposition,
  })),
  ...legacyAdditionalPhysicalObjectLedger
    .filter((entry) => entry.kind === "IMPLICIT_JOIN_TABLE" || entry.kind === "MIGRATION_HISTORY")
    .map((entry) => ({ name: entry.name, disposition: entry.disposition })),
] as readonly { readonly name: string; readonly disposition: CutoverDisposition }[];

const tableDisposition = new Map(
  legacyPhysicalTableDispositionLedger.map((entry) => [entry.name, entry.disposition] as const)
);

/** Exact 458-index catalog from a clean replay of all inherited migrations. */
export const legacyIndexDispositionLedger = legacyIndexCatalog.map((entry) => {
  const disposition = tableDisposition.get(entry.table);
  if (!disposition) throw new Error(`Legacy index ${entry.name} has unknown table ${entry.table}`);
  return { ...entry, disposition };
});

/** The inherited migration lineage creates no application functions or triggers. */
export const legacyFunctionDispositionLedger = [] as const;
export const legacyTriggerDispositionLedger = [] as const;

export const legacyEnumDispositionLedger = [
  { name: "AuthenticationMethod", disposition: "BACKFILL" },
  { name: "OrganizationAccessTokenType", disposition: "EXPORT_DROP" },
  { name: "OrgMemberRole", disposition: "BACKFILL" },
  { name: "RuntimeEnvironmentType", disposition: "BACKFILL" },
  { name: "ProjectVersion", disposition: "EXPORT_DROP" },
  { name: "SecretStoreProvider", disposition: "BACKFILL" },
  { name: "TaskTriggerSource", disposition: "EXPORT_DROP" },
  { name: "TaskRunStatus", disposition: "EXPORT_DROP" },
  { name: "RunEngineVersion", disposition: "EXPORT_DROP" },
  { name: "TaskRunExecutionStatus", disposition: "EXPORT_DROP" },
  { name: "TaskRunCheckpointType", disposition: "EXPORT_DROP" },
  { name: "WaitpointType", disposition: "EXPORT_DROP" },
  { name: "WaitpointStatus", disposition: "EXPORT_DROP" },
  { name: "WorkerInstanceGroupType", disposition: "EXPORT_DROP" },
  { name: "WorkloadType", disposition: "EXPORT_DROP" },
  { name: "TaskRunAttemptStatus", disposition: "EXPORT_DROP" },
  { name: "TaskEventLevel", disposition: "EXPORT_DROP" },
  { name: "TaskEventKind", disposition: "EXPORT_DROP" },
  { name: "TaskEventStatus", disposition: "EXPORT_DROP" },
  { name: "TaskQueueType", disposition: "EXPORT_DROP" },
  { name: "TaskQueueVersion", disposition: "EXPORT_DROP" },
  { name: "BatchTaskRunStatus", disposition: "EXPORT_DROP" },
  { name: "BatchTaskRunItemStatus", disposition: "EXPORT_DROP" },
  { name: "CheckpointType", disposition: "EXPORT_DROP" },
  { name: "CheckpointRestoreEventType", disposition: "EXPORT_DROP" },
  { name: "WorkerDeploymentType", disposition: "EXPORT_DROP" },
  { name: "WorkerDeploymentStatus", disposition: "EXPORT_DROP" },
  { name: "ScheduleType", disposition: "EXPORT_DROP" },
  { name: "ScheduleGeneratorType", disposition: "EXPORT_DROP" },
  { name: "ProjectAlertChannelType", disposition: "EXPORT_DROP" },
  { name: "ProjectAlertType", disposition: "EXPORT_DROP" },
  { name: "ProjectAlertStatus", disposition: "EXPORT_DROP" },
  { name: "IntegrationService", disposition: "EXPORT_DROP" },
  { name: "BulkActionType", disposition: "EXPORT_DROP" },
  { name: "BulkActionStatus", disposition: "EXPORT_DROP" },
  { name: "BulkActionNotificationType", disposition: "EXPORT_DROP" },
  { name: "BulkActionItemStatus", disposition: "EXPORT_DROP" },
  { name: "GithubRepositorySelection", disposition: "EXPORT_DROP" },
  { name: "ImpersonationAuditLogAction", disposition: "BACKFILL" },
  { name: "CustomerQuerySource", disposition: "EXPORT_DROP" },
  { name: "CustomerQueryScope", disposition: "EXPORT_DROP" },
  { name: "PlatformNotificationSurface", disposition: "EXPORT_DROP" },
  { name: "PlatformNotificationScope", disposition: "EXPORT_DROP" },
  { name: "ErrorGroupStatus", disposition: "EXPORT_DROP" },
] as const satisfies readonly { name: string; disposition: CutoverDisposition }[];

export type CryptographicProbe =
  | "MFA_VERIFY_NEXT_TIMESTEP"
  | "CREDENTIAL_RUNTIME_READ"
  | "ENTITY_AUTH_HANDSHAKE"
  | "CHANNEL_CREDENTIAL_READ"
  | "MCP_OIDC_TOKEN_READ"
  | "MESSAGE_DECRYPT_READ"
  | "AUDIT_DECRYPT_READ"
  | "MEMORY_DECRYPT_READ";

export interface CryptographicFieldLedgerEntry {
  readonly id: string;
  readonly family:
    | "MFA"
    | "PROVIDER"
    | "CHANNEL"
    | "ENTITY"
    | "OIDC"
    | "GENERIC_CREDENTIAL"
    | "MESSAGE";
  readonly sourceFields: readonly string[];
  readonly sourceKeyDomain:
    | "NONE"
    | "ENCRYPTION_KEY"
    | "PLATOS_ENCRYPTION_KEY"
    | "PLATOS_MESSAGE_ENCRYPTION_KEY"
    | "PLATOS_CREDENTIAL_ROOT_KEYS";
  readonly alternateSourceKeyDomain?: "PLATOS_MESSAGE_ENCRYPTION_KEY" | "NONE";
  readonly sourceKeyVersion:
    | "UNVERSIONED"
    | "SecretStore.version"
    | "PlatosAgentMessage.encKeyVersion"
    | "__platos_enc.v";
  readonly sourceEncoding:
    | "PLAINTEXT_UTF8"
    | "SECRET_STORE_V1_PLAINTEXT_JSON_OR_V2_AES_256_GCM_HEX_JSON"
    | "SECRETS_BASE64_IV16_TAG16_CIPHERTEXT_OR_LEGACY_MESSAGE_OR_PLAINTEXT"
    | "MESSAGE_BASE64_IV16_TAG16_CIPHERTEXT_WITH_VERSION_COLUMN"
    | "MESSAGE_JSON_ENVELOPE_AS_JSONB"
    | "MESSAGE_JSON_ENVELOPE_AS_TEXT";
  readonly targetFields: readonly string[];
  readonly targetKeyDomain:
    | "OPERATOR_AUTH_MFA_KEY"
    | "PLATOS_CREDENTIAL_ROOT_KEYS"
    | "PLATOS_MESSAGE_ENCRYPTION_KEY";
  readonly transform:
    | "DECRYPT_BASE32_REENCRYPT"
    | "DECRYPT_REENVELOPE"
    | "DECRYPT_VALIDATE_REENCRYPT"
    | "VALIDATE_REENVELOPE";
  readonly probe: CryptographicProbe;
  readonly nullable: boolean;
}

const credentialTarget = [
  "Credential.activeSecretVersionId",
  "CredentialSecretVersion.ciphertext",
] as const;

/**
 * Every retained encrypted-material family. Entries are field-addressable and
 * consumed by preflight/decrypt-probe tooling; hashes and plaintext webhook URL
 * factors are intentionally not described as encrypted material.
 */
export const cryptographicFieldLedger = [
  {
    id: "mfa-totp-secret-store",
    family: "MFA",
    sourceFields: [
      "User.mfaSecretReferenceId",
      "SecretReference.key",
      "SecretReference.provider",
      "SecretStore.version",
      "SecretStore.value",
    ],
    sourceKeyDomain: "ENCRYPTION_KEY",
    sourceKeyVersion: "SecretStore.version",
    sourceEncoding: "SECRET_STORE_V1_PLAINTEXT_JSON_OR_V2_AES_256_GCM_HEX_JSON",
    targetFields: ["OperatorMfaTotp.encryptedSecret", "OperatorMfaTotp.lastUsedCounter"],
    targetKeyDomain: "OPERATOR_AUTH_MFA_KEY",
    transform: "DECRYPT_BASE32_REENCRYPT",
    probe: "MFA_VERIFY_NEXT_TIMESTEP",
    nullable: true,
  },
  {
    id: "provider-secret-store",
    family: "PROVIDER",
    sourceFields: ["PlatosProviderKey.envVarName", "SecretStore.version", "SecretStore.value"],
    sourceKeyDomain: "ENCRYPTION_KEY",
    sourceKeyVersion: "SecretStore.version",
    sourceEncoding: "SECRET_STORE_V1_PLAINTEXT_JSON_OR_V2_AES_256_GCM_HEX_JSON",
    targetFields: ["ProviderKey.credentialId", ...credentialTarget],
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS",
    transform: "DECRYPT_REENVELOPE",
    probe: "CREDENTIAL_RUNTIME_READ",
    nullable: false,
  },
  {
    id: "entity-mcp-client-secret-store",
    family: "ENTITY",
    sourceFields: [
      "PlatosEntityMcpClient.credsSecretKey",
      "SecretStore.version",
      "SecretStore.value",
    ],
    sourceKeyDomain: "ENCRYPTION_KEY",
    sourceKeyVersion: "SecretStore.version",
    sourceEncoding: "SECRET_STORE_V1_PLAINTEXT_JSON_OR_V2_AES_256_GCM_HEX_JSON",
    targetFields: ["EntityMcpClient.credentialId", ...credentialTarget],
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS",
    transform: "DECRYPT_REENVELOPE",
    probe: "CREDENTIAL_RUNTIME_READ",
    nullable: true,
  },
  {
    id: "generic-credential-encrypted-reference",
    family: "GENERIC_CREDENTIAL",
    sourceFields: ["Credential.encryptedReference"],
    sourceKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY",
    sourceKeyVersion: "__platos_enc.v",
    sourceEncoding: "MESSAGE_JSON_ENVELOPE_AS_TEXT",
    targetFields: credentialTarget,
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS",
    transform: "DECRYPT_VALIDATE_REENCRYPT",
    probe: "CREDENTIAL_RUNTIME_READ",
    nullable: true,
  },
  {
    id: "entity-service-secret",
    family: "ENTITY",
    sourceFields: ["PlatosConnectedEntity.serviceSecret"],
    sourceKeyDomain: "NONE",
    sourceKeyVersion: "UNVERSIONED",
    sourceEncoding: "PLAINTEXT_UTF8",
    targetFields: credentialTarget,
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS",
    transform: "VALIDATE_REENVELOPE",
    probe: "ENTITY_AUTH_HANDSHAKE",
    nullable: false,
  },
  {
    id: "entity-test-credentials",
    family: "ENTITY",
    sourceFields: ["PlatosConnectedEntity.testCredentials"],
    sourceKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY",
    sourceKeyVersion: "__platos_enc.v",
    sourceEncoding: "MESSAGE_JSON_ENVELOPE_AS_TEXT",
    targetFields: credentialTarget,
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS",
    transform: "DECRYPT_VALIDATE_REENCRYPT",
    probe: "CREDENTIAL_RUNTIME_READ",
    nullable: true,
  },
  {
    id: "channel-connection-credentials",
    family: "CHANNEL",
    sourceFields: ["PlatosChannelConnection.credentials"],
    sourceKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY",
    sourceKeyVersion: "__platos_enc.v",
    sourceEncoding: "MESSAGE_JSON_ENVELOPE_AS_TEXT",
    targetFields: ["ChannelConnection.credentialId", ...credentialTarget],
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS",
    transform: "DECRYPT_VALIDATE_REENCRYPT",
    probe: "CHANNEL_CREDENTIAL_READ",
    nullable: true,
  },
  {
    id: "channel-connection-webhook-secret",
    family: "CHANNEL",
    sourceFields: ["PlatosChannelConnection.webhookSecret"],
    sourceKeyDomain: "NONE",
    sourceKeyVersion: "UNVERSIONED",
    sourceEncoding: "PLAINTEXT_UTF8",
    targetFields: ["ChannelConnection.credentialId", ...credentialTarget],
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS",
    transform: "VALIDATE_REENVELOPE",
    probe: "CHANNEL_CREDENTIAL_READ",
    nullable: false,
  },
  ...[
    ["channel-app-client-secret", "PlatosChannelApp.clientSecret"],
    ["channel-app-signing-secret", "PlatosChannelApp.signingSecret"],
  ].map(([id, sourceField]) => ({
    id: id!,
    family: "CHANNEL" as const,
    sourceFields: [sourceField!],
    sourceKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY" as const,
    sourceKeyVersion: "__platos_enc.v" as const,
    sourceEncoding: "MESSAGE_JSON_ENVELOPE_AS_TEXT" as const,
    targetFields: ["ChannelApp.credentialId", ...credentialTarget],
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS" as const,
    transform: "DECRYPT_REENVELOPE" as const,
    probe: "CHANNEL_CREDENTIAL_READ" as const,
    nullable: false,
  })),
  ...[
    ["channel-installation-bot-token", "PlatosChannelInstallation.botToken", false],
    ["channel-installation-refresh-token", "PlatosChannelInstallation.refreshToken", true],
  ].map(([id, sourceField, nullable]) => ({
    id: id as string,
    family: "CHANNEL" as const,
    sourceFields: [sourceField as string],
    sourceKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY" as const,
    sourceKeyVersion: "__platos_enc.v" as const,
    sourceEncoding: "MESSAGE_JSON_ENVELOPE_AS_TEXT" as const,
    targetFields: ["ChannelInstallation.credentialId", ...credentialTarget],
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS" as const,
    transform: "DECRYPT_REENVELOPE" as const,
    probe: "CHANNEL_CREDENTIAL_READ" as const,
    nullable: nullable as boolean,
  })),
  ...[
    ["mcp-oidc-access-token", "PlatosMcpOidcSession.entityAccessToken"],
    ["mcp-oidc-refresh-token", "PlatosMcpOidcSession.entityRefreshToken"],
  ].map(([id, sourceField]) => ({
    id: id!,
    family: "OIDC" as const,
    sourceFields: [sourceField!],
    sourceKeyDomain: "PLATOS_ENCRYPTION_KEY" as const,
    alternateSourceKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY" as const,
    sourceKeyVersion: "UNVERSIONED" as const,
    sourceEncoding: "SECRETS_BASE64_IV16_TAG16_CIPHERTEXT_OR_LEGACY_MESSAGE_OR_PLAINTEXT" as const,
    targetFields: ["McpOidcSession.credentialId", ...credentialTarget],
    targetKeyDomain: "PLATOS_CREDENTIAL_ROOT_KEYS" as const,
    transform: "DECRYPT_REENVELOPE" as const,
    probe: "MCP_OIDC_TOKEN_READ" as const,
    nullable: true,
  })),
  ...[
    ["message-content", "PlatosAgentMessage.content", "Turn.outputText"],
    ["message-thinking", "PlatosAgentMessage.thinkingContent", "Turn.thinkingContent"],
  ].map(([id, sourceField, targetField]) => ({
    id: id!,
    family: "MESSAGE" as const,
    sourceFields: [sourceField!, "PlatosAgentMessage.encKeyVersion"],
    sourceKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY" as const,
    sourceKeyVersion: "PlatosAgentMessage.encKeyVersion" as const,
    sourceEncoding: "MESSAGE_BASE64_IV16_TAG16_CIPHERTEXT_WITH_VERSION_COLUMN" as const,
    targetFields: [targetField!],
    targetKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY" as const,
    transform: "DECRYPT_VALIDATE_REENCRYPT" as const,
    probe: "MESSAGE_DECRYPT_READ" as const,
    nullable: true,
  })),
  ...[
    [
      "tool-audit-arguments",
      "PlatosToolCallAudit.args",
      "ToolCallAudit.arguments",
      "AUDIT_DECRYPT_READ",
    ],
    [
      "tool-audit-result",
      "PlatosToolCallAudit.result",
      "ToolCallAudit.result",
      "AUDIT_DECRYPT_READ",
    ],
    ["safety-detail", "PlatosSafetyEvent.detail", "SafetyEvent.detail", "AUDIT_DECRYPT_READ"],
    ["safety-metadata", "PlatosSafetyEvent.meta", "SafetyEvent.metadata", "AUDIT_DECRYPT_READ"],
    ["memory-content", "PlatosMemory.content", "Memory.content", "MEMORY_DECRYPT_READ"],
    ["memory-metadata", "PlatosMemory.metadata", "Memory.metadata", "MEMORY_DECRYPT_READ"],
    [
      "memory-entity-label",
      "PlatosMemoryEntity.label",
      "MemoryEntity.label",
      "MEMORY_DECRYPT_READ",
    ],
    [
      "memory-entity-metadata",
      "PlatosMemoryEntity.metadata",
      "MemoryEntity.metadata",
      "MEMORY_DECRYPT_READ",
    ],
    [
      "memory-relationship-metadata",
      "PlatosMemoryRelationship.metadata",
      "MemoryRelationship.metadata",
      "MEMORY_DECRYPT_READ",
    ],
  ].map(([id, sourceField, targetField, probe]) => ({
    id: id!,
    family: "MESSAGE" as const,
    sourceFields: [sourceField!],
    sourceKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY" as const,
    sourceKeyVersion: "__platos_enc.v" as const,
    sourceEncoding:
      sourceField!.endsWith(".content") ||
      sourceField!.endsWith(".label") ||
      sourceField!.endsWith(".detail")
        ? ("MESSAGE_JSON_ENVELOPE_AS_TEXT" as const)
        : ("MESSAGE_JSON_ENVELOPE_AS_JSONB" as const),
    targetFields: [targetField!],
    targetKeyDomain: "PLATOS_MESSAGE_ENCRYPTION_KEY" as const,
    transform: "DECRYPT_VALIDATE_REENCRYPT" as const,
    probe: probe as CryptographicProbe,
    nullable: !sourceField!.endsWith(".content") && !sourceField!.endsWith(".label"),
  })),
] as const satisfies readonly CryptographicFieldLedgerEntry[];

/** Executable preflight validation descriptors shared by later cutover stages. */
export const cutoverValidationQueries = [
  {
    id: "source-model-counts",
    sql: `SELECT table_name, count(*)::bigint AS source_count FROM information_schema.tables CROSS JOIN LATERAL (SELECT 1) AS bounded WHERE table_schema = 'cutover_legacy' GROUP BY table_name ORDER BY table_name`,
  },
  {
    id: "unmapped-backfill-identities",
    sql: `SELECT source_model, count(*)::bigint AS unmapped_count FROM cutover_legacy.cutover_id_map WHERE mapping_version = 1 AND target_id IS NULL GROUP BY source_model ORDER BY source_model`,
  },
  {
    id: "duplicate-target-identities",
    sql: `SELECT target_id, count(*)::bigint AS collision_count FROM cutover_legacy.cutover_id_map WHERE mapping_version = 1 GROUP BY target_id HAVING count(*) > 1 ORDER BY target_id`,
  },
] as const;
