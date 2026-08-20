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
  { source: "PlatosAgent", targets: ["Agent", "AgentBinding"], owner: "project", surface: "operator", decision: "split" },
  { source: "PlatosAgentCluster", targets: ["AgentCluster"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosAgentVersion", targets: ["AgentVersion"], owner: "agent", surface: "operator", decision: "rename" },
  { source: "PlatosEndUser", targets: ["EndUser"], owner: "organization", surface: "subject", decision: "re-home" },
  { source: "PlatosEndUserIdentity", targets: ["EndUserIdentity"], owner: "organization", surface: "subject", decision: "re-home" },
  { source: "PlatosAccessKey", targets: ["AccessKey"], owner: "environment", surface: "operator", decision: "re-home" },
  { source: "PlatosPostmanTemplate", targets: ["PostmanTemplate"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosAgentThread", targets: ["Thread"], owner: "environment", surface: "subject", decision: "rename" },
  { source: "PlatosAgentMessage", targets: ["Turn", "Step", "ToolCall"], owner: "thread", surface: "subject", decision: "split" },
  { source: "PlatosAgentArtifact", targets: ["Artifact"], owner: "environment", surface: "subject", decision: "rename" },
  { source: "PlatosMessageAttachment", targets: ["MessageAttachment"], owner: "environment", surface: "subject", decision: "rename" },
  { source: "PlatosConnectedEntity", targets: ["Entity"], owner: "project", surface: "operator", decision: "rename" },
  { source: "PlatosChannelConnection", targets: ["ChannelConnection"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosChannelThread", targets: ["ChannelThread"], owner: "channelConnection", surface: "subject", decision: "rename" },
  { source: "PlatosChannelApp", targets: ["ChannelApp"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosChannelInstallation", targets: ["ChannelInstallation"], owner: "channelApp", surface: "operator", decision: "rename" },
  { source: "PlatosChannelAppThread", targets: ["ChannelAppThread"], owner: "channelInstallation", surface: "subject", decision: "rename" },
  { source: "PlatosEntityMcpConfig", targets: ["EntityMcpConfig"], owner: "entity", surface: "operator", decision: "rename" },
  { source: "PlatosEntityMcpClient", targets: ["EntityMcpClient"], owner: "entity", surface: "operator", decision: "rename" },
  { source: "PlatosToolDefinition", targets: ["Tool"], owner: "global", surface: "operator", decision: "rename" },
  { source: "PlatosEntityToolMapping", targets: ["EnvironmentEntityTool"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosToolHealth", targets: ["ToolHealth"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosToolCallAudit", targets: ["ToolCallAudit"], owner: "environment", surface: "subject-audit", decision: "rename" },
  { source: "PlatosAdminAudit", targets: ["AdminAudit"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosAgentApproval", targets: ["AgentApproval"], owner: "environment", surface: "subject", decision: "rename" },
  { source: "PlatosProviderEnabled", targets: ["EnvironmentProvider"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosProviderKey", targets: ["ProviderKey"], owner: "environment", surface: "operator", decision: "re-home" },
  { source: "PlatosBudgetCap", targets: ["Budget"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosSafetyEvent", targets: ["SafetyEvent"], owner: "environment", surface: "subject-audit", decision: "rename" },
  { source: "PlatosMessageRating", targets: ["MessageRating"], owner: "environment", surface: "subject", decision: "rename" },
  { source: "PlatosEvalCriterion", targets: ["EvalCriterion"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosAgentEval", targets: ["AgentEval"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosGoldenSet", targets: ["GoldenSet"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosTask", targets: ["Job"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosSkill", targets: ["Skill", "ProjectSkill", "EnvironmentSkill"], owner: "organization", surface: "operator", decision: "split" },
  { source: "PlatosAgentSkill", targets: ["AgentSkill"], owner: "agentVersion", surface: "operator", decision: "re-home" },
  { source: "PlatosMemory", targets: ["Memory"], owner: "agent", surface: "subject", decision: "rename" },
  { source: "PlatosMemoryEntity", targets: ["MemoryEntity"], owner: "agent", surface: "subject", decision: "rename" },
  { source: "PlatosMemoryRelationship", targets: ["MemoryRelationship"], owner: "agent", surface: "subject", decision: "rename" },
  { source: "PlatosMCPToken", targets: ["McpToken"], owner: "environment", surface: "operator", decision: "re-home" },
  { source: "PlatosOrgMcpPolicy", targets: ["OrganizationMcpPolicy"], owner: "organization", surface: "operator", decision: "re-home" },
  { source: "PlatosMacro", targets: ["Macro"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosEvent", targets: ["Event"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosNotificationRule", targets: ["NotificationRule"], owner: "environment", surface: "operator", decision: "rename" },
  { source: "PlatosPAT", targets: ["PersonalAccessToken"], owner: "user", surface: "operator", decision: "re-home" },
  { source: "PlatosCredentialAudit", targets: ["AdminAudit"], owner: "global", surface: "operator", decision: "merge" },
  { source: "PlatosOAuthClient", targets: ["OAuthClient"], owner: "organization", surface: "operator", decision: "rename" },
  { source: "PlatosOAuthAuthCode", targets: ["OAuthAuthorizationCode"], owner: "oauthClient", surface: "operator", decision: "re-home" },
  { source: "PlatosOAuthAccessToken", targets: ["OAuthAccessToken"], owner: "oauthClient", surface: "operator", decision: "re-home" },
  { source: "PlatosOAuthRefreshToken", targets: ["OAuthRefreshToken"], owner: "oauthClient", surface: "operator", decision: "re-home" },
  { source: "PlatosMcpAnonSession", targets: ["McpAnonymousSession"], owner: "environment", surface: "subject", decision: "rename" },
  { source: "PlatosMcpOidcSession", targets: ["McpOidcSession"], owner: "environment", surface: "subject", decision: "rename" },
  { source: "PlatosEntityMcpToolAcl", targets: ["EntityToolPolicy"], owner: "entity", surface: "operator", decision: "re-home" },
  { source: "PlatosMcpBearerToken", targets: ["McpBearerToken"], owner: "environment", surface: "operator", decision: "re-home" },
  { source: "PlatosErasureOperation", targets: ["ErasureOperation"], owner: "organization", surface: "operator", decision: "rename" },
] as const satisfies readonly SourceModelDisposition[];

/** New support models required by the approved normalized design. */
export const supportDomainModels = [
  "AgentToolPolicy",
  "AlertChannel",
  "AlertChannelConfiguration",
  "AlertDelivery",
  "AlertDeliveryAttempt",
  "BudgetThresholdEvent",
  "ChannelEventInbox",
  "Credential",
  "CredentialAudit",
  "CredentialSecretVersion",
  "EnvironmentVariable",
  "ErasureTombstone",
  "OAuthConsentTransaction",
  "Model",
  "ModelPrice",
] as const;

/** All source target models plus independently required clean-slate support models. */
export const domainModelNames = [
  ...new Set(sourceModelManifest.flatMap((entry) => entry.targets)),
  ...supportDomainModels.filter(
    (name) => !sourceModelManifest.some((entry) => (entry.targets as readonly string[]).includes(name))
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
  { source: "PlatosAgent.organization", inheritedTarget: "Organization", targetPath: "Agent.project.organization", disposition: "derived" },
  { source: "PlatosAgentThread.organization", inheritedTarget: "Organization", targetPath: "Thread.environment.project.organization", disposition: "derived" },
  { source: "PlatosAgentArtifact.organization", inheritedTarget: "Organization", targetPath: "Artifact.environment.project.organization", disposition: "derived" },
  { source: "PlatosMessageAttachment.organization", inheritedTarget: "Organization", targetPath: "MessageAttachment.environment.project.organization", disposition: "derived" },
  { source: "PlatosConnectedEntity.organization", inheritedTarget: "Organization", targetPath: "Entity.project.organization", disposition: "derived" },
  { source: "PlatosSkill.organization", inheritedTarget: "Organization", targetPath: "Skill.organization", disposition: "canonical" },

  { source: "PlatosAgent.project", inheritedTarget: "Project", targetPath: "Agent.project", disposition: "canonical" },
  { source: "PlatosAgentThread.project", inheritedTarget: "Project", targetPath: "Thread.environment.project", disposition: "derived" },
  { source: "PlatosAgentArtifact.project", inheritedTarget: "Project", targetPath: "Artifact.environment.project", disposition: "derived" },
  { source: "PlatosMessageAttachment.project", inheritedTarget: "Project", targetPath: "MessageAttachment.environment.project", disposition: "derived" },
  { source: "PlatosConnectedEntity.project", inheritedTarget: "Project", targetPath: "Entity.project", disposition: "canonical" },
  { source: "PlatosSkill.project", inheritedTarget: "Project", targetPath: "ProjectSkill.project", disposition: "normalized" },

  { source: "PlatosAgent.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "AgentBinding.environment", disposition: "normalized" },
  { source: "PlatosAgentCluster.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "AgentCluster.environment", disposition: "canonical" },
  { source: "PlatosEndUser.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "EndUser.organization", disposition: "normalized" },
  { source: "PlatosAccessKey.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Credential.environment", disposition: "normalized" },
  { source: "PlatosPostmanTemplate.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "PostmanTemplate.environment", disposition: "canonical" },
  { source: "PlatosAgentThread.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Thread.environment", disposition: "canonical" },
  { source: "PlatosAgentArtifact.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Artifact.environment", disposition: "canonical" },
  { source: "PlatosMessageAttachment.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "MessageAttachment.environment", disposition: "canonical" },
  { source: "PlatosEntityToolMapping.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "EnvironmentEntityTool.environment", disposition: "canonical" },
  { source: "PlatosToolHealth.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "ToolHealth.environment", disposition: "canonical" },
  { source: "PlatosToolCallAudit.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "ToolCallAudit.environment", disposition: "canonical" },
  { source: "PlatosAdminAudit.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "AdminAudit.environment", disposition: "canonical" },
  { source: "PlatosAgentApproval.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "AgentApproval.environment", disposition: "canonical" },
  { source: "PlatosProviderEnabled.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "EnvironmentProvider.environment", disposition: "canonical" },
  { source: "PlatosProviderKey.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Credential.environment", disposition: "normalized" },
  { source: "PlatosBudgetCap.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Budget.environment", disposition: "canonical" },
  { source: "PlatosSafetyEvent.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "SafetyEvent.environment", disposition: "canonical" },
  { source: "PlatosMessageRating.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "MessageRating.environment", disposition: "canonical" },
  { source: "PlatosEvalCriterion.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "EvalCriterion.environment", disposition: "canonical" },
  { source: "PlatosAgentEval.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "AgentEval.environment", disposition: "canonical" },
  { source: "PlatosGoldenSet.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "GoldenSet.environment", disposition: "canonical" },
  { source: "PlatosTask.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Job.environment", disposition: "canonical" },
  { source: "PlatosSkill.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "EnvironmentSkill.environment", disposition: "normalized" },
  { source: "PlatosMemory.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Memory.environment", disposition: "canonical" },
  { source: "PlatosMemoryEntity.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "MemoryEntity.environment", disposition: "canonical" },
  { source: "PlatosMemoryRelationship.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "MemoryRelationship.environment", disposition: "canonical" },
  { source: "PlatosMCPToken.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Credential.environment", disposition: "normalized" },
  { source: "PlatosOrgMcpPolicy.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "OrganizationMcpPolicy.organization", disposition: "normalized" },
  { source: "PlatosEvent.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "Event.environment", disposition: "canonical" },
  { source: "PlatosNotificationRule.environment", inheritedTarget: "RuntimeEnvironment", targetPath: "NotificationRule.environment", disposition: "canonical" },
] as const satisfies readonly LegacyTenancyRelationDisposition[];

/** Mechanical totals derived from the exact relation ledger above. */
export const legacyTenancyRelationCounts = Object.freeze({
  RuntimeEnvironment: legacyTenancyRelationManifest.filter(
    (entry) => entry.inheritedTarget === "RuntimeEnvironment"
  ).length,
  Organization: legacyTenancyRelationManifest.filter(
    (entry) => entry.inheritedTarget === "Organization"
  ).length,
  Project: legacyTenancyRelationManifest.filter(
    (entry) => entry.inheritedTarget === "Project"
  ).length,
  total: legacyTenancyRelationManifest.length,
});
