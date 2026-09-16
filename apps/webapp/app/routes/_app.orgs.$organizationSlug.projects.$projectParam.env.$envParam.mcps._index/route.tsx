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
import { coreData, type CoreMintedToken } from "~/services/coreApi.server";
import { assertCredentialSafePayload, mcpManagementRequest } from "~/services/platosAgent.server";

// THE PLATFORM MCP-TOKEN MINT, RE-SERVED (WIN-259, WIN-257 T8).
//
// This is one of the two webapp actions the secret-response census counts as
// `m4-transport`: it relays a one-time bearer secret to a browser, on purpose,
// because a token that is never displayed is a token nobody can use. What the
// cutover changes is WHERE THE MINT HAPPENS.
//
// THE CREATE NOW GOES TO core-api. `POST /mcp/platform/tokens` there is
// `mintBearerCredential`, the V1 mint, and `apps/core-api/src/http/idempotency-
// policy.ts` marks it `required`: "MCP-token — mints a platform MCP token",
// under the rule that covers the eight operations returning a secret "once and
// never readable again". `coreApi.server.ts` sends an `Idempotency-Key` for every
// `required` operation and will not dispatch one without it, so a form
// resubmission that races itself is refused as in-progress instead of leaving a
// second live credential nobody holds.
//
// THE LISTING AND THE REVOCATION STAY ON THE AGENT, and that is the per-route
// cutover D11 describes rather than an oversight. `loadSurface` reads
// `/mcp/platform/tokens` through the MCP management transport, and the revoke
// posts to `/mcp/platform/tokens/:id/revoke` there. Both are served by core-api
// too; moving them is a separate route's decision, taken when the metadata those
// screens render has been compared. The mint moves first because it is the
// operation whose authorization and idempotency V1 actually improves.
//
// THE PROJECTION IS UNCHANGED, AND `assertCredentialSafePayload` STILL RUNS ON
// THE REST. The secret is split off by name and everything else is swept for
// credential-shaped fields before it reaches a page; a V1 mint answers
// `{ tokenId, token, label, permissions, tier, expiresAt, createdAt }`, and the
// sweep is what keeps that list from quietly growing a second secret.
const config = { surface: "mcp-platform" as const, title: "Platform MCP tokens", description: "Operator-managed control-plane tokens with one-time bearer reveal and Environment-scoped lifecycle.", endpoint: "/mcp/platform/tokens", transport: "mcp-management" as const, collection: { defaultPageSize: 25, maxPageSize: 100 }, provenance: "Canonical Environment-owned McpToken metadata via the isolated MCP management transport" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Platform MCP token", async ({ scope, form }) => {
    const intent = requiredText(form, "intent");
    if (intent === "create") {
      const created = await coreData<CoreMintedToken>("mcp.platformTokens.mint", {
        request: args.request,
        body: {
          environmentId: scope.environmentId,
          name: requiredText(form, "name", "Token name"),
          permissions: stringList(form, "permissions"),
          ttlSeconds: numberField(form, "ttlSeconds", { min: 60, max: 31_536_000, integer: true, fallback: 7_776_000 }),
          tier: enumField(form, "tier", ["scope", "admin"] as const, "scope"),
        },
      });
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
