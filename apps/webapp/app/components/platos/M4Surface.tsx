import { Form, useActionData, useNavigation } from "@remix-run/react";
import type { ReactNode } from "react";
import { Page } from "./DashboardShell";
import { Button, PageHeader, PanelFailure, ProvenanceNote } from "./ProductPrimitives";
import {
  AgentConfigSurface,
  AgentContextSurface,
  AgentsSurface,
  AgentToolsSurface,
  CanarySurface,
  VersionsSurface,
} from "./surfaces/AgentSurfaces";
import {
  AuditSurface,
  BudgetsSurface,
  CostSurface,
  EvalsSurface,
  GovernanceSurface,
  HomeSurface,
  MonitoringSurface,
  MonitoringUsersSurface,
} from "./surfaces/OperationsSurfaces";
import {
  EntitiesSurface,
  EntityCreateSurface,
  EntitySecretSurface,
  McpConfigSurface,
  McpPlatformSurface,
  PostmanSurface,
  SkillsSurface,
  ToolRegistrySurface,
  WireTestSurface,
} from "./surfaces/RegistrySurfaces";
import {
  AccountsSurface,
  ChannelsSurface,
  ClustersSurface,
  FilesAttachmentsSurface,
  FilesConversationsSurface,
  FilesSurface,
  FilesUsersSurface,
  JobsSurface,
  MemoryGraphSurface,
  MemorySurface,
  SettingsSurface,
  VariablesSurface,
} from "./surfaces/SecondarySurfaces";
import { ThreadSurface, ThreadsSurface, TraceSurface } from "./surfaces/ThreadSurfaces";
import {
  MutationFeedback,
  type MutationData,
  type SurfaceName,
  type SurfaceData,
  type SurfaceProps,
} from "./surfaces/SurfaceCommon";

export type { PanelResult, SurfaceData } from "./surfaces/SurfaceCommon";

type SurfaceRenderer = (props: SurfaceProps) => ReactNode;

const renderers: Record<SurfaceName, SurfaceRenderer> = {
  home: (props) => <HomeSurface {...props} />,
  agents: (props) => <AgentsSurface {...props} />,
  "agent-create": (props) => <AgentConfigSurface {...props} />,
  "agent-config": (props) => <AgentConfigSurface {...props} />,
  context: (props) => <AgentContextSurface {...props} />,
  "agent-tools": (props) => <AgentToolsSurface {...props} />,
  versions: (props) => <VersionsSurface {...props} />,
  canary: (props) => <CanarySurface {...props} />,
  conversations: (props) => <ThreadsSurface {...props} />,
  thread: (props) => <ThreadSurface {...props} />,
  trace: (props) => <TraceSurface {...props} />,
  tools: (props) => <ToolRegistrySurface {...props} />,
  entities: (props) => <EntitiesSurface {...props} />,
  "entity-create": () => <EntityCreateSurface />,
  "entity-secret": () => <EntitySecretSurface />,
  "wire-test": () => <WireTestSurface />,
  "mcp-config": (props) => <McpConfigSurface {...props} />,
  "mcp-platform": (props) => <McpPlatformSurface {...props} />,
  skills: (props) => <SkillsSurface {...props} />,
  postman: (props) => <PostmanSurface {...props} />,
  monitoring: (props) => <MonitoringSurface {...props} />,
  "monitoring-users": (props) => <MonitoringUsersSurface {...props} />,
  cost: (props) => <CostSurface {...props} />,
  budgets: (props) => <BudgetsSurface {...props} />,
  governance: (props) => <GovernanceSurface {...props} />,
  evals: (props) => <EvalsSurface {...props} />,
  audit: (props) => <AuditSurface {...props} />,
  clusters: (props) => <ClustersSurface {...props} />,
  jobs: (props) => <JobsSurface {...props} />,
  channels: (props) => <ChannelsSurface {...props} />,
  accounts: (props) => <AccountsSurface {...props} />,
  files: (props) => <FilesSurface {...props} />,
  "files-users": (props) => <FilesUsersSurface {...props} />,
  "files-conversations": (props) => <FilesConversationsSurface {...props} />,
  "files-attachments": (props) => <FilesAttachmentsSurface {...props} />,
  memories: (props) => <MemorySurface {...props} />,
  "memory-graph": (props) => <MemoryGraphSurface {...props} />,
  settings: (props) => <SettingsSurface {...props} />,
  variables: (props) => <VariablesSurface {...props} />,
};

export function M4Surface({ data }: { data: SurfaceData }) {
  const navigation = useNavigation();
  const actionData = useActionData<MutationData>();
  const content = data.panel.ok ? data.panel.data : null;
  const secondary = data.secondary?.ok ? data.secondary.data : null;
  const supporting = data.supporting?.ok ? data.supporting.data : null;
  const selection = data.selection?.ok ? data.selection.data : null;
  const renderer = renderers[data.surface];
  const props = { data: content, secondary, supporting, selection, title: data.title, mutation: actionData };

  return (
    <Page>
      <PageHeader
        title={data.title}
        description={data.description}
        breadcrumbs={[{ label: "Platos", to: ".." }, { label: data.title }]}
        actions={<Form method="get"><Button type="submit" disabled={navigation.state !== "idle"}>{navigation.state === "idle" ? "Refresh" : "Loading…"}</Button></Form>}
      />
      <MutationFeedback data={actionData} />
      {data.panel.ok ? renderer(props) : <PanelFailure error={data.panel.error} />}
      {data.secondary && !data.secondary.ok && <div className="mt-5"><PanelFailure error={data.secondary.error} /></div>}
      {data.supporting && !data.supporting.ok && <div className="mt-5"><PanelFailure error={data.supporting.error} /></div>}
      {data.selection && !data.selection.ok && <div className="mt-5"><PanelFailure error={data.selection.error} /></div>}
      {data.provenance && <ProvenanceNote>{data.provenance}</ProvenanceNote>}
    </Page>
  );
}
