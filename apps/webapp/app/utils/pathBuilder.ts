import { z } from "zod";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";
export type OrgForPath = Pick<Organization, "slug">;
export type ProjectForPath = Pick<Project, "slug">;
export type EnvironmentForPath = { id: string };

export const OrganizationParamsSchema = z.object({
  organizationSlug: z.string(),
});

export const ProjectParamSchema = OrganizationParamsSchema.extend({
  projectParam: z.string(),
});

export const EnvironmentParamSchema = ProjectParamSchema.extend({
  envParam: z.string().uuid(),
});

export function rootPath() {
  return `/`;
}

/** Given a path, it makes it an impersonation path */
export function impersonate(path: string) {
  return `/@${path}`;
}

export function accountPath() {
  return `/account`;
}

export function apiTokensPath() {
  return `/account/api-tokens`;
}

export function accountSecurityPath() {
  return `/account/security`;
}

export function invitesPath() {
  return `/invites`;
}

export function confirmBasicDetailsPath() {
  return `/confirm-basic-details`;
}

export function acceptInvitePath(token: string) {
  return `/invite-accept?token=${token}`;
}

export function resendInvitePath() {
  return `/invite-resend`;
}

export function logoutPath() {
  return `/logout`;
}

export function revokeInvitePath() {
  return `/invite-revoke`;
}

// Org
export function organizationPath(organization: OrgForPath) {
  return `/orgs/${organizationParam(organization)}`;
}

export function newOrganizationPath() {
  return `/orgs/new`;
}

export function selectPlanPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/select-plan`;
}

export function organizationTeamPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings/team`;
}

export function inviteTeamMemberPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/invite`;
}

export function organizationBillingPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/billing`;
}

export function organizationSettingsPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings`;
}

function organizationParam(organization: OrgForPath) {
  return organization.slug;
}

// Project
export function newProjectPath(organization: OrgForPath, message?: string) {
  return `${organizationPath(organization)}/projects/new${
    message ? `?message=${encodeURIComponent(message)}` : ""
  }`;
}

function projectParam(project: ProjectForPath) {
  return project.slug;
}

function environmentParam(environment: EnvironmentForPath) {
  return environment.id;
}

//v3 project
export function v3ProjectPath(organization: OrgForPath, project: ProjectForPath) {
  return `/orgs/${organizationParam(organization)}/projects/${projectParam(project)}`;
}

export function v3EnvironmentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `/orgs/${organizationParam(organization)}/projects/${projectParam(
    project
  )}/env/${environmentParam(environment)}`;
}

export function v3ApiKeysPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/apikeys`;
}

export function v3ProjectSettingsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/settings`;
}

export function v3ProjectSettingsGeneralPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3ProjectSettingsPath(organization, project, environment)}/general`;
}

export function v3ProjectSettingsIntegrationsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3ProjectSettingsPath(organization, project, environment)}/integrations`;
}

export function v3ProjectSettingsIntegrationsMcpPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3ProjectSettingsIntegrationsPath(organization, project, environment)}/mcp`;
}

export function v3PromptsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/prompts`;
}

export function v3PromptPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  promptSlug: string,
  version?: string | number
) {
  const base = `${v3PromptsPath(organization, project, environment)}/${promptSlug}`;
  return version != null ? `${base}?version=${version}` : base;
}

export function v3ModelsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/models`;
}

export function v3ModelDetailPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  modelId: string
) {
  return `${v3ModelsPath(organization, project, environment)}/${modelId}`;
}

export function v3ModelComparePath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3ModelsPath(organization, project, environment)}/compare`;
}

export function v3BillingPath(organization: OrgForPath, message?: string) {
  return `${organizationPath(organization)}/settings/billing${
    message ? `?message=${encodeURIComponent(message)}` : ""
  }`;
}

export function v3BillingAlertsPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings/billing-alerts`;
}

export function v3PrivateConnectionsPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings/private-connections`;
}

export function v3NewPrivateConnectionPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings/private-connections/new`;
}

export function v3StripePortalPath(organization: OrgForPath) {
  return `/resources/${organization.slug}/subscription/portal`;
}

export function v3UsagePath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings/usage`;
}

// Docs
// TODO(Theme-P): repoint `docsRoot()` at https://docs.platos.dev once the docs
// site ships. Until then, every doc link falls back to the Platos GitHub
// README (which itself anchors at the engine trigger.dev docs where the
// underlying run-engine / schedule-engine / CLI concepts are still accurate).
export function docsRoot() {
  return "https://github.com/platos-dev/platos#docs";
}

export function docsPath(path: string) {
  // TODO(Theme-P): switch to `${docsRoot()}/${path}` once docs.platos.dev mirrors
  // the trigger.dev doc tree. For now the GitHub README is a flat anchor, so we
  // discard the sub-path and link to the README; Theme P will re-enable
  // per-page deep links.
  return docsRoot();
}

export function docsTroubleshootingPath(path: string) {
  // TODO(Theme-P): point at docs.platos.dev/troubleshooting once docs site ships.
  return docsRoot();
}

export function adminPath() {
  return `/@`;
}

// ═══════════════════════════════════════════════════════
// Platos Agent Routes
// ═══════════════════════════════════════════════════════

export function agentsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agents`;
}

export function agentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentsPath(organization, project, environment)}/${agentId}`;
}

export function agentBasicPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/basic`;
}

export function agentChatPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/chat`;
}

export function agentConversationsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/conversations`;
}

export function agentConversationPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string,
  threadId: string
) {
  return `${agentConversationsPath(organization, project, environment, agentId)}/${threadId}`;
}

export function agentVersionsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/versions`;
}

export function agentCanaryPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/canary`;
}

export function agentTracePath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string,
  threadId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/trace/${threadId}`;
}

export function agentToolsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-tools`;
}

export function agentEntitiesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-entities`;
}

// UNIT D (MCP consumption) — per-user connected-accounts view. Lists the
// PlatosEndUsers in this scope with their adopted linkedExternalId (Composio
// user_id) + verified channel identities. Read-only operator visibility.
export function agentAccountsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-accounts`;
}

export function agentMonitoringPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-monitoring`;
}

export function agentClustersPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-clusters`;
}

export function agentClusterPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  clusterId: string
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-clusters/${clusterId}`;
}

export function agentMcpsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
) {
  return `${v3EnvironmentPath(organization, project, environment)}/mcps`;
}

export function agentMcpEntityPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  entityId: string,
) {
  return `${agentMcpsPath(organization, project, environment)}/${entityId}`;
}

export function agentFilesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
) {
  return `${v3EnvironmentPath(organization, project, environment)}/files`;
}

export function agentMonitoringUsersPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  userId?: string,
) {
  const base = `${agentMonitoringPath(organization, project, environment)}/users`;
  return userId ? `${base}?userId=${encodeURIComponent(userId)}` : base;
}

// Theme H.10 — Governance dashboard (safety events + budget status + agent risk).
export function agentGovernancePath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-governance`;
}

// MCP approval-UI — dedicated approvals queue + per-approval detail.
// The MCP router's pending-approval response embeds these URLs so an
// operator can open the dashboard straight from the JSON-RPC error
// data.
export function approvalsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
) {
  return `${v3EnvironmentPath(organization, project, environment)}/approvals`;
}

export function approvalDetailPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  approvalId: string,
) {
  return `${approvalsPath(organization, project, environment)}/${approvalId}`;
}

// Theme H.5 — Budget cap configuration.
export function agentBudgetsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-budgets`;
}

export function agentProvidersPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-providers`;
}

export function agentConnectPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-connect`;
}

// Agent-scoped Connect landing — deep-links the picker to a specific agent via
// the `?agentId=` search param the Connect loader reads.
export function agentConnectAgentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentConnectPath(organization, project, environment)}?agentId=${encodeURIComponent(
    agentId
  )}`;
}

// Resource route the Connect page's channel CRUD fetchers POST to. Sibling of
// the Connect landing (`.../agent-connect/channels`), matching the existing
// `agent-connect/mint-token` resource-route convention.
export function agentConnectChannelsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${agentConnectPath(organization, project, environment)}/channels`;
}

// EOBD.89 — per-agent share route (visibility toggle + embed snippet). The
// Connect page's Web card posts its visibility toggle to this existing route's
// action via a fetcher rather than duplicating the update logic.
export function agentSharePath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/share`;
}

// Theme S — skill library + authoring.
export function skillsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/skills`;
}

export function newSkillPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${skillsPath(organization, project, environment)}/new`;
}

export function agentSkillsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agent: { id: string }
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agents/${agent.id}/skills`;
}

// Theme CTX.6 — Tools tab: per-tool mapping UI + declared-key editor.
// Note: `agentToolsPath` (plural, env-level) is the pre-existing route for
// the org-wide tool matrix page. This one is per-agent — keep the names
// distinct so the linker doesn't complain.
export function agentToolMappingsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agent: { id: string }
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agents/${agent.id}/tools`;
}

// Theme J — eval framework routes.
export function evalCriteriaPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/eval-criteria`;
}

export function agentEvalsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/agent-evals`;
}

export function agentEvalsABPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/evals-ab`;
}

export function agentPostmanTemplatesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  agentId: string
) {
  return `${agentPath(organization, project, environment, agentId)}/postman-templates`;
}

// Theme O — memory editor + graph viewer.
export function memoriesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/memories`;
}

export function memoriesGraphPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${memoriesPath(organization, project, environment)}/graph`;
}

// PIFSP-12 — Platos custom task authoring routes.
export function platosTasksPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/platos-tasks`;
}
