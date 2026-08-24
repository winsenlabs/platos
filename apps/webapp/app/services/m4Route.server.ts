import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireEnvironmentScope } from "./auth.server";
import { agentPanel, mcpManagementPanel } from "./platosAgent.server";
import type { SurfaceName } from "~/components/platos/surfaces/SurfaceCommon";
import { parseCollectionQuery, withCollectionQuery, type CollectionConfig } from "./pagination.server";

export type SurfaceConfig = {
  surface: SurfaceName;
  title: string;
  description: string;
  endpoint: string | ((params: Record<string, string | undefined>, url: URL) => string);
  secondaryEndpoint?: string | ((params: Record<string, string | undefined>, url: URL) => string);
  supportingEndpoint?: string | ((params: Record<string, string | undefined>, url: URL) => string);
  selectionEndpoint?: string;
  supportingUsesPinnedScope?: boolean;
  provenance?: string;
  notFoundAsResponse?: boolean;
  parameterAliases?: Record<string, string>;
  agentPinQueryParam?: string;
  requireAgentPin?: boolean;
  collection?: CollectionConfig;
  secondaryCollection?: CollectionConfig;
  transport?: "agent" | "mcp-management";
};

function interpolate(
  path: string,
  params: Record<string, string | undefined>,
  parameterAliases?: Record<string, string>,
) {
  return path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const parameter = params[key] ?? params[parameterAliases?.[key] ?? ""] ?? "";
    return encodeURIComponent(parameter);
  });
}
function endpoint(config: SurfaceConfig["endpoint"], params: Record<string, string | undefined>, url: URL, aliases?: Record<string, string>) {
  return typeof config === "function" ? config(params, url) : interpolate(config, params, aliases);
}

export async function loadSurface(args: LoaderFunctionArgs, config: SurfaceConfig) {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) throw new Response("Invalid scope", { status: 400 });
  const { scope: environmentScope } = await requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug });
  const url = new URL(args.request.url);
  const collectionQuery = config.collection ? parseCollectionQuery(url, config.collection) : undefined;
  const secondaryCollectionQuery = config.secondaryCollection ? parseCollectionQuery(url, config.secondaryCollection) : undefined;
  const agentId = config.agentPinQueryParam
    ? url.searchParams.get(config.agentPinQueryParam)?.trim()
    : undefined;
  const scope = agentId ? { ...environmentScope, agentId } : environmentScope;
  const panelRequest = config.transport === "mcp-management" ? mcpManagementPanel : agentPanel;
  const panel = config.requireAgentPin && !agentId
    ? { ok: true as const, data: { requiresAgentContext: true } }
    : await panelRequest(
        collectionQuery
          ? withCollectionQuery(endpoint(config.endpoint, args.params, url, config.parameterAliases), collectionQuery, config.collection!)
          : endpoint(config.endpoint, args.params, url, config.parameterAliases),
        scope,
      );
  if (!panel.ok && config.notFoundAsResponse && panel.error.status === 404) {
    throw new Response(panel.error.message, { status: 404, statusText: "Not Found" });
  }
  const secondary = config.secondaryEndpoint
    ? await panelRequest(
        secondaryCollectionQuery
          ? withCollectionQuery(endpoint(config.secondaryEndpoint, args.params, url, config.parameterAliases), secondaryCollectionQuery, config.secondaryCollection!)
          : endpoint(config.secondaryEndpoint, args.params, url, config.parameterAliases),
        environmentScope,
      )
    : undefined;
  const supporting = config.supportingEndpoint
    ? await panelRequest(
        endpoint(config.supportingEndpoint, args.params, url, config.parameterAliases),
        config.supportingUsesPinnedScope ? scope : environmentScope,
      )
    : undefined;
  const selection = config.selectionEndpoint && agentId
    ? await panelRequest(
        interpolate(config.selectionEndpoint, { ...args.params, selectedAgentId: agentId }, config.parameterAliases),
        environmentScope,
      )
    : undefined;
  return json({ ...config, endpoint: undefined, secondaryEndpoint: undefined, supportingEndpoint: undefined, selectionEndpoint: undefined, supportingUsesPinnedScope: undefined, notFoundAsResponse: undefined, parameterAliases: undefined, agentPinQueryParam: undefined, requireAgentPin: undefined, transport: undefined, collection: collectionQuery, secondaryCollection: secondaryCollectionQuery, panel, secondary, supporting, selection });
}
