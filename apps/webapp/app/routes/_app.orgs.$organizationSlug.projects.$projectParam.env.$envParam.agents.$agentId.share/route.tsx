import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { Page } from "~/components/platos/DashboardShell";
import { Alert, Button, CodeBlock, PageHeader, Panel, PanelFailure, SectionHeader, StatusChip } from "~/components/platos/ProductPrimitives";
import { asRecord, asString } from "~/components/platos/safe";
import { MutationFeedback } from "~/components/platos/surfaces/SurfaceCommon";
import { requireEnvironmentScope } from "~/services/auth.server";
import { agentRequest, enumField, m4Mutation } from "~/services/m4Mutation.server";
import { agentPanel } from "~/services/platosAgent.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (!params.organizationSlug || !params.projectParam || !params.envParam || !params.agentId) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({ request, organizationSlug: params.organizationSlug, projectSlug: params.projectParam, environmentSlug: params.envParam });
  const shareUrl = new URL(`/embed/${encodeURIComponent(params.agentId)}`, new URL(request.url).origin);
  shareUrl.searchParams.set("environmentId", scope.environmentId);
  return json({ agent: await agentPanel(`/api/v1/agent/agents/${encodeURIComponent(params.agentId)}`, scope), environmentId: scope.environmentId, shareUrl: shareUrl.toString() });
}

export async function action(args: ActionFunctionArgs) {
  return m4Mutation(args, "Agent visibility", ({ scope, form }) => {
    if (!args.params.agentId) throw new Error("Agent ID is required");
    return agentRequest(`/api/v1/agent/agents/${encodeURIComponent(args.params.agentId)}`, scope, { method: "PATCH", body: { visibility: enumField(form, "visibility", ["private", "public-guest"] as const) } });
  });
}

export default function Share() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  if (!data.agent.ok) return <Page><PageHeader title="Share and embed" description="Configure public guest access and widget delivery." /><PanelFailure error={data.agent.error} /></Page>;
  const root = asRecord(data.agent.data);
  const agent = Object.keys(asRecord(root.agent)).length ? asRecord(root.agent) : root;
  const visibility = asString(agent.visibility, "private");
  const embedMarkup = `<iframe src="${data.shareUrl}" title="Platos Agent" loading="lazy" style="width:100%;min-height:640px;border:0"></iframe>`;
  return <Page><PageHeader title="Share and embed" description="Public guests are IP- and Agent-rate-limited and carry no verified identity claims." breadcrumbs={[{ label: "Agents", to: "../.." }, { label: asString(agent.name, "Agent") }, { label: "Share" }]} /><MutationFeedback data={actionData} /><div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]"><div className="space-y-5"><Panel><SectionHeader title="Public visibility" description="Private Agents reject guest-token minting. Public guest mode permits only the constrained embed transport." /><div className="flex flex-wrap items-center justify-between gap-4"><StatusChip tone={visibility === "public-guest" ? "good" : "muted"}>{visibility === "public-guest" ? "Public guest enabled" : "Private"}</StatusChip><Form method="post"><input type="hidden" name="visibility" value={visibility === "public-guest" ? "private" : "public-guest"} /><Button type="submit" tone={visibility === "public-guest" ? "danger" : "primary"}>{visibility === "public-guest" ? "Disable public guest" : "Enable public guest"}</Button></Form></div></Panel>{visibility === "public-guest" ? <><Panel><SectionHeader title="Embed URL" /><code className="block break-all rounded border border-grid-bright bg-[var(--bg)] p-3 text-xs">{data.shareUrl}</code></Panel><Panel><SectionHeader title="Widget markup" description="Copy this semantic iframe snippet into the host page." /><CodeBlock label="HTML embed">{embedMarkup}</CodeBlock></Panel></> : <Alert tone="warning" title="Widget unavailable">Enable public guest visibility before publishing the embed URL. Stored Agent and provider credentials remain non-revealable.</Alert>}</div><Panel><SectionHeader title="Guest security boundary" /><dl className="space-y-3 text-sm"><div><dt className="text-text-dimmed">Environment</dt><dd className="mt-1 break-all font-mono text-xs">{data.environmentId}</dd></div><div><dt className="text-text-dimmed">Identity</dt><dd className="mt-1">Unverified public guest</dd></div><div><dt className="text-text-dimmed">Financial metadata</dt><dd className="mt-1">Operator-only</dd></div><div><dt className="text-text-dimmed">Credential metadata</dt><dd className="mt-1">Operator-only</dd></div></dl></Panel></div></Page>;
}
