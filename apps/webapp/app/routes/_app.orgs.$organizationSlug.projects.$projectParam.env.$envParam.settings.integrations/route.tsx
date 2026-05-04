import { Outlet, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Tabs } from "~/components/primitives/Tabs";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import { requireUserId } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3ProjectSettingsIntegrationsPath,
  v3ProjectSettingsIntegrationsMcpPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Integrations · Platos" }];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireUserId(request);
  EnvironmentParamSchema.parse(params);
  return null;
};

export default function IntegrationsLayout() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const appsPath = v3ProjectSettingsIntegrationsPath(organization, project, environment);
  const mcpPath = v3ProjectSettingsIntegrationsMcpPath(organization, project, environment);

  return (
    <div className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <div className="w-full px-6 py-6">
        <Tabs
          layoutId="settings-integrations"
          className="mb-6"
          tabs={[
            { label: "Apps", to: appsPath },
            { label: "MCP", to: mcpPath },
          ]}
        />
        <Outlet />
      </div>
    </div>
  );
}
