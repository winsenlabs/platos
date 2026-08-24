import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import {
  enumField,
  m4Mutation,
  numberField,
  requiredText,
  stringList,
} from "~/services/m4Mutation.server";
import { loadSurface } from "~/services/m4Route.server";
import { assertCredentialSafePayload, mcpManagementRequest } from "~/services/platosAgent.server";
const config = { surface: "mcp-platform" as const, title: "Platform MCP tokens", description: "Operator-managed control-plane tokens with one-time bearer reveal and Environment-scoped lifecycle.", endpoint: "/mcp/platform/tokens", transport: "mcp-management" as const, collection: { defaultPageSize: 25, maxPageSize: 100 }, provenance: "Canonical Environment-owned McpToken metadata via the isolated MCP management transport" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Platform MCP token", async ({ scope, form }) => {
    const intent = requiredText(form, "intent");
    if (intent === "create") {
      const created = await mcpManagementRequest<Record<string, unknown>>(
        "/mcp/platform/tokens",
        scope,
        {
          method: "POST",
          body: {
            name: requiredText(form, "name", "Token name"),
            permissions: stringList(form, "permissions"),
            ttlSeconds: numberField(form, "ttlSeconds", { min: 60, max: 31_536_000, integer: true, fallback: 7_776_000 }),
            tier: enumField(form, "tier", ["scope", "admin"] as const, "scope"),
          },
        },
      );
      const { token, ...metadata } = created;
      assertCredentialSafePayload(metadata);
      return { ...metadata, plaintextSecret: token };
    }
    if (intent === "revoke") {
      const tokenId = requiredText(form, "tokenId", "Token id");
      return mcpManagementRequest(
        `/mcp/platform/tokens/${encodeURIComponent(tokenId)}/revoke`,
        scope,
        { method: "POST" },
      );
    }
    throw new Error("Unsupported Platform MCP token action");
  });
}
export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
