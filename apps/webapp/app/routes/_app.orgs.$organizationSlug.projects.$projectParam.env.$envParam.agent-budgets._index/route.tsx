import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface } from "~/services/m4Route.server";
import { agentRequest, booleanField, enumField, m4Mutation, numberField, optionalText, requiredText, stringList } from "~/services/m4Mutation.server";
const config = { surface: "budgets" as const, title: "Budgets", description: "Cache-aware budget status, enforcement and once-only threshold events.", endpoint: "/api/v1/agent/budgets/status", secondaryEndpoint: "/api/v1/agent/budgets", collection: { defaultPageSize: 25, maxPageSize: 100 }, secondaryCollection: { defaultPageSize: 25, maxPageSize: 100 }, provenance: "Canonical clean database ancestry and platos-agent API" };
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Budget mutation", async ({ scope, form }) => {
    const intent = optionalText(form, "intent") ?? "save";
    if (intent === "delete") {
      const capId = requiredText(form, "capId", "Budget cap");
      return agentRequest(`/api/v1/agent/budgets/${encodeURIComponent(capId)}`, scope, { method: "DELETE" });
    }
    if (intent === "override") {
      const capId = requiredText(form, "capId", "Budget cap");
      return agentRequest(`/api/v1/agent/budgets/${encodeURIComponent(capId)}/override`, scope, {
        method: "POST",
        body: { minutes: numberField(form, "minutes", { min: 0, max: 10_080, integer: true }) },
      });
    }
    const scopeType = enumField(form, "scopeType", ["scope", "agent", "user"] as const, "scope");
    const targetId = optionalText(form, "targetId");
    if (scopeType !== "scope" && !targetId) throw new Error("targetId is required for agent and user budgets");
    const tier = enumField(form, "tier", ["llm", "skill"] as const, "llm");
    const thresholds = stringList(form, "alertThresholds").map(Number);
    if (thresholds.some((value) => !Number.isFinite(value) || value <= 0 || value > 100)) {
      throw new Error("alertThresholds must contain percentages from 1 to 100");
    }
    return agentRequest("/api/v1/agent/budgets", scope, {
      method: "POST",
      body: {
        scopeType,
        targetId: scopeType === "scope" ? undefined : targetId,
        period: enumField(form, "period", ["day", "week", "month"] as const, "month"),
        limitCents: numberField(form, "limitCents", { min: 0 }),
        runsLimit: numberField(form, "runsLimit", { min: 0, integer: true, fallback: 0 }),
        alertThresholds: thresholds.length ? thresholds : [50, 80, 100],
        alertWebhookUrl: optionalText(form, "alertWebhookUrl") ?? null,
        alertEmails: optionalText(form, "alertEmails") ?? null,
        enabled: booleanField(form, "enabled"),
        tier,
        skillSlug: tier === "skill" ? optionalText(form, "skillSlug") ?? null : null,
        agentId: optionalText(form, "agentId") ?? null,
      },
    });
  });
}

export default function Route() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
