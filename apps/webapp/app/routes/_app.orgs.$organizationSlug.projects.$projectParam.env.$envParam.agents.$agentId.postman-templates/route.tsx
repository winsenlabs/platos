import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { randomUUID } from "node:crypto";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import {
  agentRequest,
  booleanField,
  jsonObject,
  m4Mutation,
  requiredText,
} from "~/services/m4Mutation.server";
import { loadSurface } from "~/services/m4Route.server";
const config = { surface: "postman" as const, title: "Postman templates", description: "Debug assembled prompt blocks, Tool Calls and Entity round-trips against clean Agent endpoints.", endpoint: "/api/v1/agent/postman-templates?agentId=:agentId", collection: { defaultPageSize: 25, maxPageSize: 100, search: true }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Postman template mutation", ({ scope, form }) => {
    const agentId = args.params.agentId;
    if (!agentId) throw new Error("Agent is required");
    const intent = String(form.getAll("intent").at(-1) ?? "create");
    if (intent === "execute") {
      const templateId = requiredText(form, "templateId", "Template ID");
      return agentRequest(`/api/v1/agent/postman-templates/${encodeURIComponent(templateId)}/execute`, scope, {
        method: "POST",
        body: {
          message: requiredText(form, "message", "Message"),
          sessionContextOverride: jsonObject(form, "sessionContextOverride"),
          requestId: randomUUID(),
        },
        signal: AbortSignal.timeout(120_000),
      });
    }
    if (intent === "delete") {
      const templateId = requiredText(form, "templateId", "Template ID");
      return agentRequest(`/api/v1/agent/postman-templates/${encodeURIComponent(templateId)}`, scope, {
        method: "DELETE",
      });
    }
    const body = {
      name: requiredText(form, "name"),
      simulateUserId: requiredText(form, "simulateUserId", "Simulated user ID"),
      sessionContext: jsonObject(form, "sessionContext"),
      isDefault: booleanField(form, "isDefault"),
    };
    if (intent === "update") {
      const templateId = requiredText(form, "templateId", "Template ID");
      return agentRequest(`/api/v1/agent/postman-templates/${encodeURIComponent(templateId)}`, scope, {
        method: "PUT",
        body,
      });
    }
    return agentRequest("/api/v1/agent/postman-templates", scope, {
      method: "POST",
      body: { agentId, ...body },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
