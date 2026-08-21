import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { requireEnvironmentScope } from "./auth.server";
import { agentPanel } from "./platosAgent.server";

export type SurfaceConfig = {
  surface: string;
  title: string;
  description: string;
  endpoint: string | ((params: Record<string, string | undefined>, url: URL) => string);
  secondaryEndpoint?: string | ((params: Record<string, string | undefined>, url: URL) => string);
  supportingEndpoint?: string | ((params: Record<string, string | undefined>, url: URL) => string);
  provenance?: string;
  notFoundAsResponse?: boolean;
  parameterAliases?: Record<string, string>;
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
  const { scope } = await requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug });
  const url = new URL(args.request.url);
  const panel = await agentPanel(endpoint(config.endpoint, args.params, url, config.parameterAliases), scope);
  if (!panel.ok && config.notFoundAsResponse && panel.error.status === 404) {
    throw new Response(panel.error.message, { status: 404, statusText: "Not Found" });
  }
  const secondary = config.secondaryEndpoint
    ? await agentPanel(endpoint(config.secondaryEndpoint, args.params, url, config.parameterAliases), scope)
    : undefined;
  const supporting = config.supportingEndpoint
    ? await agentPanel(endpoint(config.supportingEndpoint, args.params, url, config.parameterAliases), scope)
    : undefined;
  return json({ ...config, endpoint: undefined, secondaryEndpoint: undefined, supportingEndpoint: undefined, notFoundAsResponse: undefined, parameterAliases: undefined, panel, secondary, supporting });
}
