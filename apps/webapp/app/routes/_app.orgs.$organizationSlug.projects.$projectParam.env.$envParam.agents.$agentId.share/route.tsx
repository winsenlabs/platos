/**
 * EOBD.89 — `/agents/:agentId/share` — toggle `visibility` + show
 * the share URL + iframe snippet.
 */

import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { Form, useActionData, type MetaFunction } from "@remix-run/react";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Share agent | Platos" }];

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

async function resolveAgent(
  agentId: string,
  scope: Scope,
): Promise<{
  id: string;
  name: string;
  visibility: string;
} | null> {
  return prisma.platosAgent.findFirst({
    where: {
      id: agentId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
    select: { id: true, name: true, visibility: true },
  });
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404 });

  const agentId = params.agentId;
  if (!agentId) throw new Response(undefined, { status: 404 });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
  };
  const agent = await resolveAgent(agentId, scope);
  if (!agent) throw new Response(undefined, { status: 404 });

  const appOrigin = env.APP_ORIGIN;
  const embedUrl = `${appOrigin.replace(/\/$/, "")}/embed/${encodeURIComponent(agent.id)}`;

  return typedjson({
    agent,
    embedUrl,
    appOrigin,
  });
}

export async function action({ params, request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return { error: "project not found" };
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) return { error: "environment not found" };

  const agentId = params.agentId;
  if (!agentId) return { error: "agent id missing" };

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
  };
  const existing = await resolveAgent(agentId, scope);
  if (!existing) return { error: "agent not found in scope" };

  const fd = await request.formData();
  const intent = fd.get("intent");
  if (intent !== "set-visibility") return { error: `unknown intent: ${String(intent)}` };
  const visibility = String(fd.get("visibility") || "");
  if (visibility !== "private" && visibility !== "public-guest") {
    return { error: `invalid visibility value: ${visibility}` };
  }

  await prisma.platosAgent.update({
    where: { id: agentId },
    data: { visibility },
  });

  return { ok: true, visibility };
}

export default function SharePage() {
  const { agent, embedUrl } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [copied, setCopied] = useState<string | null>(null);

  const currentVisibility =
    (actionData as any)?.visibility ?? agent.visibility;
  const isPublic = currentVisibility === "public-guest";

  const iframeSnippet = `<script src="${embedUrl.replace(/\/embed\/.+$/, "/embed.js")}"></script>\n<platos-agent\n  base-url="${embedUrl.replace(/\/embed\/.+$/, "")}"\n  agent-id="${agent.id}"\n  theme="auto"></platos-agent>`;

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={`Share · ${agent.name}`} />
      </NavBar>
      <PageBody>
        <Header2>Visibility</Header2>
        <Paragraph>
          A <strong>public-guest</strong> agent accepts anonymous chat from the
          embedded widget. Platos rate-limits guest traffic per IP + per agent and
          enforces the agent&apos;s budget caps on every turn.
        </Paragraph>

        <Form method="post" style={{ marginTop: 16 }}>
          <input type="hidden" name="intent" value="set-visibility" />
          <input
            type="hidden"
            name="visibility"
            value={isPublic ? "private" : "public-guest"}
          />
          <Button variant="primary/medium" type="submit">
            {isPublic ? "Make private" : "Make public"}
          </Button>
          <span style={{ marginLeft: 16, opacity: 0.7 }}>
            Currently: <code>{currentVisibility}</code>
          </span>
        </Form>

        {actionData && "error" in actionData && (
          <Paragraph>
            <span style={{ color: "#ef4444" }}>Error: {actionData.error}</span>
          </Paragraph>
        )}

        {isPublic && (
          <>
            <Header2 className="mt-8">Share URL</Header2>
            <Paragraph>Direct link to the embedded chat:</Paragraph>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <code
                style={{
                  flex: 1,
                  padding: 8,
                  background: "rgba(255,255,255,0.05)",
                  borderRadius: 6,
                  overflowX: "auto",
                }}
              >
                {embedUrl}
              </code>
              <Button
                variant="secondary/medium"
                onClick={() => copy(embedUrl, "url")}
              >
                {copied === "url" ? "Copied!" : "Copy"}
              </Button>
            </div>

            <Header2 className="mt-8">Embed snippet</Header2>
            <Paragraph>
              Drop this into any HTML page. Requires the{" "}
              <code>@platosdev/embed</code> bundle to be served at{" "}
              <code>/embed.js</code>.
            </Paragraph>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <pre
                style={{
                  flex: 1,
                  padding: 12,
                  background: "rgba(255,255,255,0.05)",
                  borderRadius: 6,
                  overflowX: "auto",
                }}
              >
                {iframeSnippet}
              </pre>
              <Button
                variant="secondary/medium"
                onClick={() => copy(iframeSnippet, "snippet")}
              >
                {copied === "snippet" ? "Copied!" : "Copy"}
              </Button>
            </div>
          </>
        )}
      </PageBody>
    </PageContainer>
  );
}
