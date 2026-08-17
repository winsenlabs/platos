export type CanonicalOwner =
  | "organization"
  | "project"
  | "environment"
  | "agent"
  | "agentVersion"
  | "thread"
  | "turn"
  | "step"
  | "entity"
  | "channelConnection"
  | "channelApp"
  | "channelInstallation"
  | "projectSkill"
  | "environmentSkill"
  | "memoryEntity"
  | "user"
  | "oauthClient"
  | "global";

export type PrincipalSurface = "operator" | "subject" | "subject-audit";

export interface SourceModelDisposition {
  readonly source: `Platos${string}`;
  readonly targets: readonly string[];
  readonly owner: CanonicalOwner;
  readonly surface: PrincipalSurface;
  readonly decision: "rename" | "merge" | "split" | "re-home";
}

/**
 * Mechanical accounting ledger for the 55 legacy Platos-prefixed models.
 * A source occurs exactly once even when several sources merge into Credential
 * or one source splits into Turn, Step, and ToolCall.
 */
export const sourceModelManifest = [
  {
    source: "PlatosAgent",
    targets: ["Agent", "AgentBinding"],
    owner: "project",
    surface: "operator",
    decision: "split",
  },
  {
    source: "PlatosAgentCluster",
    targets: ["AgentCluster"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosAgentVersion",
    targets: ["AgentVersion"],
    owner: "agent",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosEndUser",
    targets: ["EndUser"],
    owner: "organization",
    surface: "subject",
    decision: "re-home",
  },
  {
    source: "PlatosEndUserIdentity",
    targets: ["EndUserIdentity"],
    owner: "organization",
    surface: "subject",
    decision: "re-home",
  },
  {
    source: "PlatosAccessKey",
    targets: ["AccessKey"],
    owner: "environment",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosPostmanTemplate",
    targets: ["PostmanTemplate"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosAgentThread",
    targets: ["Thread"],
    owner: "environment",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosAgentMessage",
    targets: ["Turn", "Step", "ToolCall"],
    owner: "thread",
    surface: "subject",
    decision: "split",
  },
  {
    source: "PlatosAgentArtifact",
    targets: ["Artifact"],
    owner: "environment",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosMessageAttachment",
    targets: ["MessageAttachment"],
    owner: "environment",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosConnectedEntity",
    targets: ["Entity"],
    owner: "project",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosChannelConnection",
    targets: ["ChannelConnection"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosChannelThread",
    targets: ["ChannelThread"],
    owner: "channelConnection",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosChannelApp",
    targets: ["ChannelApp"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosChannelInstallation",
    targets: ["ChannelInstallation"],
    owner: "channelApp",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosChannelAppThread",
    targets: ["ChannelAppThread"],
    owner: "channelInstallation",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosEntityMcpConfig",
    targets: ["EntityMcpConfig"],
    owner: "entity",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosEntityMcpClient",
    targets: ["EntityMcpClient"],
    owner: "entity",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosToolDefinition",
    targets: ["Tool"],
    owner: "global",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosEntityToolMapping",
    targets: ["EnvironmentEntityTool"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosToolHealth",
    targets: ["ToolHealth"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosToolCallAudit",
    targets: ["ToolCallAudit"],
    owner: "environment",
    surface: "subject-audit",
    decision: "rename",
  },
  {
    source: "PlatosAdminAudit",
    targets: ["AdminAudit"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosAgentApproval",
    targets: ["AgentApproval"],
    owner: "environment",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosProviderEnabled",
    targets: ["EnvironmentProvider"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosProviderKey",
    targets: ["ProviderKey"],
    owner: "environment",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosBudgetCap",
    targets: ["Budget"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosSafetyEvent",
    targets: ["SafetyEvent"],
    owner: "environment",
    surface: "subject-audit",
    decision: "rename",
  },
  {
    source: "PlatosMessageRating",
    targets: ["MessageRating"],
    owner: "environment",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosEvalCriterion",
    targets: ["EvalCriterion"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosAgentEval",
    targets: ["AgentEval"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosGoldenSet",
    targets: ["GoldenSet"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosTask",
    targets: ["Job"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosSkill",
    targets: ["Skill", "ProjectSkill", "EnvironmentSkill"],
    owner: "organization",
    surface: "operator",
    decision: "split",
  },
  {
    source: "PlatosAgentSkill",
    targets: ["AgentSkill"],
    owner: "agentVersion",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosMemory",
    targets: ["Memory"],
    owner: "agent",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosMemoryEntity",
    targets: ["MemoryEntity"],
    owner: "agent",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosMemoryRelationship",
    targets: ["MemoryRelationship"],
    owner: "agent",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosMCPToken",
    targets: ["McpToken"],
    owner: "environment",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosOrgMcpPolicy",
    targets: ["OrganizationMcpPolicy"],
    owner: "organization",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosMacro",
    targets: ["Macro"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosEvent",
    targets: ["Event"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosNotificationRule",
    targets: ["NotificationRule"],
    owner: "environment",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosPAT",
    targets: ["PersonalAccessToken"],
    owner: "user",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosCredentialAudit",
    targets: ["AdminAudit"],
    owner: "global",
    surface: "operator",
    decision: "merge",
  },
  {
    source: "PlatosOAuthClient",
    targets: ["OAuthClient"],
    owner: "organization",
    surface: "operator",
    decision: "rename",
  },
  {
    source: "PlatosOAuthAuthCode",
    targets: ["OAuthAuthorizationCode"],
    owner: "oauthClient",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosOAuthAccessToken",
    targets: ["OAuthAccessToken"],
    owner: "oauthClient",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosOAuthRefreshToken",
    targets: ["OAuthRefreshToken"],
    owner: "oauthClient",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosMcpAnonSession",
    targets: ["McpAnonymousSession"],
    owner: "environment",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosMcpOidcSession",
    targets: ["McpOidcSession"],
    owner: "environment",
    surface: "subject",
    decision: "rename",
  },
  {
    source: "PlatosEntityMcpToolAcl",
    targets: ["EntityToolPolicy"],
    owner: "entity",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosMcpBearerToken",
    targets: ["McpBearerToken"],
    owner: "entity",
    surface: "operator",
    decision: "re-home",
  },
  {
    source: "PlatosErasureOperation",
    targets: ["ErasureOperation"],
    owner: "organization",
    surface: "operator",
    decision: "rename",
  },
] as const satisfies readonly SourceModelDisposition[];

/** New support models required by the approved normalized design. */
export const supportDomainModels = [
  "AgentToolPolicy",
  "Credential",
  "CredentialAudit",
  "CredentialSecretVersion",
  "ExternalCutoverEvidence",
  "ExternalCutoverRun",
  "ObjectKeyReconciliation",
  "TokenLifecycleAudit",
] as const;

/** All source target models plus independently required clean-slate support models. */
export const domainModelNames = [
  ...new Set(sourceModelManifest.flatMap((entry) => entry.targets)),
  ...supportDomainModels.filter(
    (name) =>
      !sourceModelManifest.some((entry) => (entry.targets as readonly string[]).includes(name))
  ),
] as readonly string[];

export interface LegacyTenancyRelationDisposition {
  readonly source: `${`Platos${string}`}.${string}`;
  readonly inheritedTarget: "RuntimeEnvironment" | "Organization" | "Project";
  readonly targetPath: string;
  readonly disposition: "canonical" | "derived" | "normalized";
}

/** Exact reconciliation ledger for the corrected 30 + 6 + 6 relations. */
export const legacyTenancyRelationManifest = [
  {
    source: "PlatosAgent.organization",
    inheritedTarget: "Organization",
    targetPath: "Agent.project.organization",
    disposition: "derived",
  },
  {
    source: "PlatosAgentThread.organization",
    inheritedTarget: "Organization",
    targetPath: "Thread.environment.project.organization",
    disposition: "derived",
  },
  {
    source: "PlatosAgentArtifact.organization",
    inheritedTarget: "Organization",
    targetPath: "Artifact.environment.project.organization",
    disposition: "derived",
  },
  {
    source: "PlatosMessageAttachment.organization",
    inheritedTarget: "Organization",
    targetPath: "MessageAttachment.environment.project.organization",
    disposition: "derived",
  },
  {
    source: "PlatosConnectedEntity.organization",
    inheritedTarget: "Organization",
    targetPath: "Entity.project.organization",
    disposition: "derived",
  },
  {
    source: "PlatosSkill.organization",
    inheritedTarget: "Organization",
    targetPath: "Skill.organization",
    disposition: "canonical",
  },

  {
    source: "PlatosAgent.project",
    inheritedTarget: "Project",
    targetPath: "Agent.project",
    disposition: "canonical",
  },
  {
    source: "PlatosAgentThread.project",
    inheritedTarget: "Project",
    targetPath: "Thread.environment.project",
    disposition: "derived",
  },
  {
    source: "PlatosAgentArtifact.project",
    inheritedTarget: "Project",
    targetPath: "Artifact.environment.project",
    disposition: "derived",
  },
  {
    source: "PlatosMessageAttachment.project",
    inheritedTarget: "Project",
    targetPath: "MessageAttachment.environment.project",
    disposition: "derived",
  },
  {
    source: "PlatosConnectedEntity.project",
    inheritedTarget: "Project",
    targetPath: "Entity.project",
    disposition: "canonical",
  },
  {
    source: "PlatosSkill.project",
    inheritedTarget: "Project",
    targetPath: "ProjectSkill.project",
    disposition: "normalized",
  },

  {
    source: "PlatosAgent.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "AgentBinding.environment",
    disposition: "normalized",
  },
  {
    source: "PlatosAgentCluster.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "AgentCluster.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosEndUser.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "EndUser.organization",
    disposition: "normalized",
  },
  {
    source: "PlatosAccessKey.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Credential.environment",
    disposition: "normalized",
  },
  {
    source: "PlatosPostmanTemplate.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "PostmanTemplate.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosAgentThread.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Thread.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosAgentArtifact.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Artifact.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosMessageAttachment.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "MessageAttachment.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosEntityToolMapping.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "EnvironmentEntityTool.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosToolHealth.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "ToolHealth.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosToolCallAudit.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "ToolCallAudit.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosAdminAudit.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "AdminAudit.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosAgentApproval.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "AgentApproval.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosProviderEnabled.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "EnvironmentProvider.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosProviderKey.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Credential.environment",
    disposition: "normalized",
  },
  {
    source: "PlatosBudgetCap.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Budget.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosSafetyEvent.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "SafetyEvent.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosMessageRating.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "MessageRating.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosEvalCriterion.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "EvalCriterion.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosAgentEval.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "AgentEval.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosGoldenSet.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "GoldenSet.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosTask.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Job.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosSkill.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "EnvironmentSkill.environment",
    disposition: "normalized",
  },
  {
    source: "PlatosMemory.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Memory.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosMemoryEntity.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "MemoryEntity.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosMemoryRelationship.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "MemoryRelationship.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosMCPToken.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Credential.environment",
    disposition: "normalized",
  },
  {
    source: "PlatosOrgMcpPolicy.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "OrganizationMcpPolicy.organization",
    disposition: "normalized",
  },
  {
    source: "PlatosEvent.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "Event.environment",
    disposition: "canonical",
  },
  {
    source: "PlatosNotificationRule.environment",
    inheritedTarget: "RuntimeEnvironment",
    targetPath: "NotificationRule.environment",
    disposition: "canonical",
  },
] as const satisfies readonly LegacyTenancyRelationDisposition[];

/** Mechanical totals derived from the exact relation ledger above. */
export const legacyTenancyRelationCounts = Object.freeze({
  RuntimeEnvironment: legacyTenancyRelationManifest.filter(
    (entry) => entry.inheritedTarget === "RuntimeEnvironment"
  ).length,
  Organization: legacyTenancyRelationManifest.filter(
    (entry) => entry.inheritedTarget === "Organization"
  ).length,
  Project: legacyTenancyRelationManifest.filter((entry) => entry.inheritedTarget === "Project")
    .length,
  total: legacyTenancyRelationManifest.length,
});

export type FieldTransform =
  | "COPY"
  | "UUID_V5"
  | "UUID_V5_SPLIT"
  | "NORMALIZE_JSON_ROOT"
  | "NORMALIZE_JSON_TO_COLUMNS";

export interface SourceIdentityTransform {
  readonly source: `${`Platos${string}`}.${string}`;
  readonly targets: readonly {
    readonly field: string;
    readonly transform: "UUID_V5" | "UUID_V5_SPLIT" | "UUID_V5_REFERENCE";
    /** Fixed suffix, or a bounded ordinal grammar for repeated split children. */
    readonly suffix?: string;
    readonly mappingSourceModel?: `Platos${string}`;
  }[];
}

const sourcePrimaryKeyOverrides: Readonly<Record<string, string>> = Object.freeze({
  PlatosEntityMcpConfig: "entityPk",
  PlatosEntityMcpClient: "entityPk",
  PlatosOAuthAuthCode: "code",
  PlatosOAuthAccessToken: "tokenHash",
  PlatosOAuthRefreshToken: "tokenHash",
});

const splitTargetSuffixes: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    PlatosAgent: { AgentBinding: "agent-binding" },
    PlatosAgentMessage: { Step: "step:<ordinal>", ToolCall: "tool-call:<ordinal>" },
    PlatosSkill: { ProjectSkill: "project-skill", EnvironmentSkill: "environment-skill" },
  });

const sharedPrimaryKeyTargets: Readonly<
  Record<string, { field: string; mappingSourceModel: `Platos${string}` }>
> = Object.freeze({
  PlatosEntityMcpConfig: {
    field: "EntityMcpConfig.entityId",
    mappingSourceModel: "PlatosConnectedEntity",
  },
  PlatosEntityMcpClient: {
    field: "EntityMcpClient.entityId",
    mappingSourceModel: "PlatosConnectedEntity",
  },
});

/** Field-level identity contract for every retained Platos source model. */
export const sourceIdentityTransformManifest: readonly SourceIdentityTransform[] =
  sourceModelManifest.map((entry) => {
    const sourceField = sourcePrimaryKeyOverrides[entry.source] ?? "id";
    const suffixes = splitTargetSuffixes[entry.source] ?? {};
    const sharedPrimaryKey = sharedPrimaryKeyTargets[entry.source];
    return {
      source: `${entry.source}.${sourceField}`,
      targets: entry.targets.map((target, index) => {
        if (sharedPrimaryKey) {
          return {
            field: sharedPrimaryKey.field,
            transform: "UUID_V5_REFERENCE" as const,
            mappingSourceModel: sharedPrimaryKey.mappingSourceModel,
          };
        }
        const suffix = suffixes[target];
        return {
          field: `${target}.id`,
          transform: index === 0 && !suffix ? ("UUID_V5" as const) : ("UUID_V5_SPLIT" as const),
          ...(suffix ? { suffix } : {}),
        };
      }),
    };
  });

export interface SourceOwnershipDerivation {
  readonly sourceModel: `Platos${string}`;
  readonly owner: CanonicalOwner;
  readonly rule: "GLOBAL" | "MAP_DIRECT_OWNER" | "DERIVE_CANONICAL_ANCESTRY";
  readonly validation: "NONE" | "OWNER_ID_MAP_EXISTS" | "TARGET_ANCESTRY_MATCHES";
}

/** Ownership is never copied from a request header or denormalized source tuple. */
export const sourceOwnershipDerivationManifest: readonly SourceOwnershipDerivation[] =
  sourceModelManifest.map((entry) => ({
    sourceModel: entry.source,
    owner: entry.owner,
    rule:
      entry.owner === "global"
        ? ("GLOBAL" as const)
        : (
            [
              "organization",
              "project",
              "environment",
              "agent",
              "agentVersion",
              "thread",
              "turn",
              "step",
              "entity",
              "channelConnection",
              "channelApp",
              "channelInstallation",
              "projectSkill",
              "environmentSkill",
              "memoryEntity",
              "user",
              "oauthClient",
            ] as const
          ).includes(entry.owner as never)
        ? ("DERIVE_CANONICAL_ANCESTRY" as const)
        : ("MAP_DIRECT_OWNER" as const),
    validation: entry.owner === "global" ? ("NONE" as const) : ("TARGET_ANCESTRY_MATCHES" as const),
  }));

export interface SourceJsonTransform {
  readonly source: `${`Platos${string}`}.${string}`;
  readonly target: string;
  readonly transform: "NORMALIZE_JSON_ROOT" | "NORMALIZE_JSON_TO_COLUMNS";
  readonly acceptedSourceRoots: readonly (
    | "object"
    | "array"
    | "legacy-encoded-object"
    | "legacy-encoded-array"
  )[];
  readonly invalidPolicy: "BLOCK_CUTOVER";
}

/**
 * Bounded JSON transforms whose target shape is already enforced by the clean
 * jsonShapeRegistry. Unlisted JSON is not silently copied; later cutover code
 * must add a descriptor or export the field before it can be retained.
 */
export const sourceJsonTransformManifest = [
  {
    source: "PlatosAgentCluster.metadata",
    target: "AgentCluster.metadata",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentVersion.snapshot",
    target: "AgentVersion.promptBlocks",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array", "legacy-encoded-array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentVersion.snapshot",
    target: "AgentVersion.dynamicBlocks",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array", "legacy-encoded-array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentVersion.snapshot",
    target: "AgentVersion.toolsBlockConfig",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object", "legacy-encoded-object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentVersion.snapshot",
    target: "AgentVersion.modelRoutes",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array", "legacy-encoded-array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentVersion.snapshot",
    target: "AgentVersion.memoryConfig",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentVersion.snapshot",
    target: "AgentVersion.outputSchema",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosEndUser.metadata",
    target: "EndUserIdentity.profile",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosEndUserIdentity.metadata",
    target: "EndUserIdentity.profile",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosPostmanTemplate.sessionContext",
    target: "PostmanTemplate.sessionContext",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentThread.sessionContext",
    target: "Thread.sessionContext",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentMessage.toolCalls",
    target: "ToolCall.arguments",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentArtifact.metadata",
    target: "Artifact.metadata",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosChannelConnection.agentRouting",
    target: "ChannelConnection.agentRouting",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosChannelApp.agentRouting",
    target: "ChannelApp.agentRouting",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosChannelInstallation.agentRouting",
    target: "ChannelInstallation.agentRouting",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosEntityMcpConfig.identityProviders",
    target: "EntityMcpConfig.identityProviders",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosEntityMcpConfig.branding",
    target: "EntityMcpConfig.branding",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosEntityMcpClient.headersTemplate",
    target: "EntityMcpClient.headersTemplate",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosToolDefinition.paramSchema",
    target: "Tool.paramSchema",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosToolCallAudit.args",
    target: "ToolCallAudit.arguments",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosToolCallAudit.result",
    target: "ToolCallAudit.result",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object", "array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAdminAudit.beforeJson",
    target: "AdminAudit.before",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAdminAudit.afterJson",
    target: "AdminAudit.after",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentApproval.args",
    target: "AgentApproval.arguments",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentApproval.resolution",
    target: "AgentApproval.resolution",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosBudgetCap.alertThresholds",
    target: "Budget.alertThresholds",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosSafetyEvent.meta",
    target: "SafetyEvent.metadata",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentEval.criterionSnapshot",
    target: "AgentEval.criterionSnapshot",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosSkill.manifest",
    target: "Skill.manifest",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosAgentSkill.config",
    target: "AgentSkill.config",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosMemory.metadata",
    target: "Memory.metadata",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosMemoryEntity.metadata",
    target: "MemoryEntity.metadata",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosMemoryRelationship.metadata",
    target: "MemoryRelationship.metadata",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosOAuthAuthCode.scopeTuple",
    target: "OAuthAuthorizationCode.scopeKind",
    transform: "NORMALIZE_JSON_TO_COLUMNS",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosOAuthAccessToken.scopeTuple",
    target: "OAuthAccessToken.scopeKind",
    transform: "NORMALIZE_JSON_TO_COLUMNS",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosOAuthRefreshToken.scopeTuple",
    target: "OAuthRefreshToken.scopeKind",
    transform: "NORMALIZE_JSON_TO_COLUMNS",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosErasureOperation.scopes",
    target: "ErasureOperation.scopes",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosErasureOperation.stores",
    target: "ErasureOperation.stores",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["array"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
  {
    source: "PlatosErasureOperation.inventory",
    target: "ErasureOperation.inventory",
    transform: "NORMALIZE_JSON_ROOT",
    acceptedSourceRoots: ["object"],
    invalidPolicy: "BLOCK_CUTOVER",
  },
] as const satisfies readonly SourceJsonTransform[];

export interface SourceRequiredDefaultPolicy {
  readonly sourceModel: `Platos${string}`;
  readonly sourceIdentity: string;
  readonly identityPolicy: "PREFLIGHT_REQUIRED";
  readonly createdAtPolicy: "PRESERVE_WHEN_PRESENT";
  readonly updatedAtPolicy: "PRESERVE_WHEN_TARGET_SUPPORTS";
  readonly missingRequiredTargetPolicy: "BLOCK_CUTOVER";
}

export const sourceRequiredDefaultPolicyManifest: readonly SourceRequiredDefaultPolicy[] =
  sourceIdentityTransformManifest.map((entry) => ({
    sourceModel: entry.source.split(".")[0] as `Platos${string}`,
    sourceIdentity: entry.source,
    identityPolicy: "PREFLIGHT_REQUIRED",
    createdAtPolicy: "PRESERVE_WHEN_PRESENT",
    updatedAtPolicy: "PRESERVE_WHEN_TARGET_SUPPORTS",
    missingRequiredTargetPolicy: "BLOCK_CUTOVER",
  }));

export {
  auditFieldTransformationManifest,
  requiredTargetFieldManifest,
  sourceFieldTransformationManifest,
  type RequiredTargetFieldContract,
  type SourceFieldDisposition,
  type SourceFieldTransformation,
} from "./source-field-manifest";
