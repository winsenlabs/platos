import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page } from "~/components/platos/DashboardShell";
import { MutationFeedback } from "~/components/platos/surfaces/SurfaceCommon";
import { asArray, asBoolean, asRecord, asString, firstArray, stableJson } from "~/components/platos/safe";
import { requireEnvironmentScope } from "~/services/auth.server";
import { agentPanel, agentRequest } from "~/services/platosAgent.server";

async function scoped(args: LoaderFunctionArgs | ActionFunctionArgs, access: "metadata" | "secret:mutate") {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) throw new Response("Invalid scope", { status: 400 });
  return requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug, access });
}

function id(value: FormDataEntryValue | null): string {
  const result = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(result)) throw new Error("Invalid Skill id");
  return result;
}

export async function loader(args: LoaderFunctionArgs) {
  const { scope } = await scoped(args, "metadata");
  const agentId = args.params.agentId;
  if (!agentId) throw new Response("Agent not found", { status: 404 });
  const [enabled, registry] = await Promise.all([
    agentPanel(`/api/v1/agent/skills/agent/${encodeURIComponent(agentId)}`, scope),
    agentPanel("/api/v1/agent/skills", scope),
  ]);
  return json({ agentId, enabled, registry });
}

export async function action(args: ActionFunctionArgs) {
  const { scope } = await scoped(args, "secret:mutate");
  const agentId = args.params.agentId;
  if (!agentId) throw new Response("Agent not found", { status: 404 });
  const form = await args.request.formData();
  const skillId = id(form.get("skillId"));
  const enabled = form.get("enabled") === "true";
  try {
    const result = await agentRequest(`/api/v1/agent/skills/agent/${encodeURIComponent(agentId)}/${encodeURIComponent(skillId)}`, scope, { method: enabled ? "POST" : "DELETE" });
    return json({ ok: true, result });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Skill update failed" }, { status: 400 });
  }
}

export default function AgentSkillsRoute() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const available = data.registry.ok ? firstArray(asRecord(data.registry.data), "skills", "items") : [];
  const enabledRows = data.enabled.ok ? firstArray(asRecord(data.enabled.data), "skills", "items") : [];
  const enabledIds = new Set(enabledRows.map((value) => asString(asRecord(value).id, "")).filter(Boolean));

  return (
    <Page>
      <header className="mb-6"><div className="text-xs uppercase tracking-widest text-text-dimmed">Platos / Agent</div><h1 className="mt-1 text-2xl font-semibold">Effective Skills</h1><p className="mt-1 text-sm text-text-dimmed">Official Skills render their embedded effective configuration. Changes invalidate the prompt cache and affect the next Turn.</p></header>
      {!data.registry.ok ? <div className="rounded border border-red-500/40 p-4 text-red-300">{data.registry.error.message}</div> : (
        <div className="space-y-3">{available.map((value, index) => { const skill = asRecord(value); const skillId = asString(skill.id, `skill-${index}`); const enabled = enabledIds.has(skillId); const requiredEnv = asArray(skill.requiredEnv).filter((entry): entry is string => typeof entry === "string"); return <article key={skillId} className="rounded-lg border border-grid-bright bg-background-bright p-4"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h2 className="font-semibold">{asString(skill.name, skillId)}</h2>{asBoolean(skill.isOfficial) && <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-xs text-indigo-200">Official</span>}</div><p className="mt-1 text-sm text-text-dimmed">{asString(skill.description, "No description")}</p></div><fetcher.Form method="post"><input type="hidden" name="skillId" value={skillId} /><input type="hidden" name="enabled" value={enabled ? "false" : "true"} /><button disabled={fetcher.state !== "idle"} className={`rounded px-3 py-2 text-sm ${enabled ? "border border-grid-bright" : "bg-indigo-500 text-white"}`}>{enabled ? "Disable" : "Enable"}</button></fetcher.Form></div><div className="mt-4 grid gap-3 md:grid-cols-3"><div className="rounded border border-grid-bright p-3 text-xs"><div className="text-text-dimmed">Environment readiness</div><div className="mt-1">{asBoolean(skill.envReady) || !requiredEnv.length ? "Ready" : `Missing ${requiredEnv.join(", ")}`}</div></div><div className="rounded border border-grid-bright p-3 text-xs"><div className="text-text-dimmed">Tool schemas</div><div className="mt-1">{asArray(skill.tools).length} embedded Tool{asArray(skill.tools).length === 1 ? "" : "s"}</div></div><div className="rounded border border-grid-bright p-3 text-xs"><div className="text-text-dimmed">Effective source</div><div className="mt-1">{asBoolean(skill.isOfficial) ? "Embedded official manifest" : asString(skill.origin, "Custom")}</div></div></div><details className="mt-3 text-xs text-text-dimmed"><summary>Effective configuration</summary><pre className="mt-2 max-h-72 overflow-auto rounded bg-charcoal-950 p-3">{stableJson(skill.effectiveConfig ?? skill.manifest ?? skill)}</pre></details></article>; })}</div>
      )}
      <div className="mt-4"><MutationFeedback data={fetcher.data} /></div>
    </Page>
  );
}
