import type { ActionFunctionArgs } from "@remix-run/node";
import {
  agentRequest,
  booleanField,
  enumField,
  jsonArray,
  jsonObject,
  m4Mutation,
  optionalText,
  requiredText,
} from "~/services/m4Mutation.server";

export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Channel connection mutation", ({ scope, form }) => {
    const intent = String(form.get("intent") ?? "create");
    if (intent === "delete") {
      const id = requiredText(form, "id", "Channel connection ID");
      return agentRequest(`/api/v1/agent/channels/${encodeURIComponent(id)}`, scope, {
        method: "DELETE",
      });
    }

    const body = {
      agentId: requiredText(form, "agentId", "Agent ID"),
      ...(optionalText(form, "displayName") !== undefined
        ? { displayName: optionalText(form, "displayName") }
        : {}),
      agentRouting: jsonArray(form, "agentRouting"),
      config: jsonObject(form, "config"),
      credentials: jsonObject(form, "credentials"),
      ...(intent === "update" ? { enabled: booleanField(form, "enabled") } : {}),
    };

    if (intent === "update") {
      const id = requiredText(form, "id", "Channel connection ID");
      return agentRequest(`/api/v1/agent/channels/${encodeURIComponent(id)}`, scope, {
        method: "PATCH",
        body,
      });
    }

    return agentRequest("/api/v1/agent/channels", scope, {
      method: "POST",
      body: {
        provider: enumField(
          form,
          "provider",
          ["slack", "telegram", "whatsapp", "discord"] as const,
        ),
        ...body,
      },
    });
  });
}
