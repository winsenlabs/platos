import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import {
  booleanField,
  enumField,
  jsonArray,
  jsonObject,
  m4Mutation,
  numberField,
  stringList,
  requiredText,
} from "~/services/m4Mutation.server";
import { loadSurface } from "~/services/m4Route.server";
import { assertCredentialSafePayload, mcpManagementRequest } from "~/services/platosAgent.server";
const config = { surface: "mcp-config" as const, title: "MCP Entity", description: "Safe MCP config, bearer lifecycle and Environment-scoped Tool ACL.", endpoint: "/mcp/entity/:entityId/config", secondaryEndpoint: "/mcp/entity/:entityId/tokens", supportingEndpoint: "/mcp/entity/:entityId/tool-acl", transport: "mcp-management" as const, secondaryCollection: { defaultPageSize: 25, maxPageSize: 100, pageParam: "tokenPage", pageSizeParam: "tokenPageSize" }, supportingCollection: { defaultPageSize: 100, maxPageSize: 100, pageParam: "aclPage", pageSizeParam: "aclPageSize" }, provenance: "Canonical EntityMcpConfig, McpBearerToken and EntityToolPolicy read-back via isolated MCP management transport", notFoundAsResponse: true };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "MCP Entity management", async ({ scope, form }) => {
    const entityId = args.params.entityId;
    if (!entityId) throw new Error("Entity is required");
    const base = `/mcp/entity/${encodeURIComponent(entityId)}`;
    const intent = String(form.get("intent") ?? "config");
    if (intent === "token-create") {
      const created = await mcpManagementRequest<Record<string, unknown>>(`${base}/tokens`, scope, {
        method: "POST",
        body: {
          label: requiredText(form, "label", "Token label"),
          scopes: stringList(form, "scopes"),
          expiresIn: numberField(form, "expiresIn", { min: 60, max: 31_536_000, integer: true, fallback: 7_776_000 }),
        },
      });
      const { raw, ...metadata } = created;
      assertCredentialSafePayload(metadata);
      return { ...metadata, plaintextSecret: raw };
    }
    if (intent === "token-revoke") {
      const tokenId = requiredText(form, "tokenId", "Token id");
      return mcpManagementRequest(`${base}/tokens/${encodeURIComponent(tokenId)}`, scope, { method: "DELETE" });
    }
    if (intent === "acl-update") {
      const toolId = requiredText(form, "toolId", "Tool id");
      return mcpManagementRequest(`${base}/tool-acl/${encodeURIComponent(toolId)}`, scope, {
        method: "PATCH",
        body: {
          exposed: booleanField(form, "exposed"),
          minIdentityMode: enumField(form, "minIdentityMode", ["anonymous", "bearer", "oidc"] as const, "bearer"),
          allowedPatIds: stringList(form, "allowedPatIds"),
          scopeLabels: stringList(form, "scopeLabels"),
        },
      });
    }
    if (intent === "acl-bulk") {
      return mcpManagementRequest(`${base}/tool-acl/bulk`, scope, {
        method: "POST",
        body: {
          action: enumField(form, "bulkAction", ["expose", "hide", "set_identity"] as const),
          toolIds: stringList(form, "toolIds"),
          minIdentityMode: enumField(form, "bulkMinIdentityMode", ["anonymous", "bearer", "oidc"] as const, "bearer"),
        },
      });
    }
    return mcpManagementRequest(`${base}/config`, scope, {
      method: "PATCH",
      body: {
        enabled: booleanField(form, "enabled"),
        identityMode: enumField(form, "identityMode", ["bearer", "oidc", "anonymous", "bearer+oidc", "bearer+anonymous", "oidc+anonymous", "bearer+oidc+anonymous"] as const, "bearer"),
        identityProviders: jsonArray(form, "identityProviders"),
        branding: jsonObject(form, "branding"),
        toolAllowlist: stringList(form, "toolAllowlist"),
        redirectUriAllowlist: stringList(form, "redirectUriAllowlist"),
        rateLimitPerMinute: numberField(form, "rateLimitPerMinute", { min: 1, max: 10_000, integer: true, fallback: 60 }),
        injectMcpContext: booleanField(form, "injectMcpContext"),
      },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
