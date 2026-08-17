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
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { getAgent, isAgentServiceAvailable } from "~/services/platosAgent.server";
import { env } from "~/env.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Share agent | Platos" }];

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

function isAgentNotFoundError(error: unknown) {
  return error instanceof Error && error.message.includes("Platos Agent API error: 404");
}

function scopeHeaders(scope: Scope) {
  return {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };
}

async function resolveAgent(
  agentId: string,
  scope: Scope,
): Promise<{
  id: string;
  name: string;
  visibility: string;
} | null> {
  const agent = await getAgent(agentId, scope);
  return {
    id: agent.id,
    name: agent.name,
    visibility: typeof agent.visibility === "string" ? agent.visibility : "private",
  };
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
    userId,
  };
  let agent: Awaited<ReturnType<typeof resolveAgent>> = null;
  let agentServiceAvailable = false;
  let agentFound = true;
  if (await isAgentServiceAvailable()) {
    try {
      agent = await resolveAgent(agentId, scope);
      agentServiceAvailable = true;
    } catch (error) {
      agentFound = !isAgentNotFoundError(error);
    }
  }

  const appOrigin = env.APP_ORIGIN;
  const embedUrl = agent
    ? `${appOrigin.replace(/\/$/, "")}/embed/${encodeURIComponent(agent.id)}`
    : null;

  return typedjson({
    agent,
    embedUrl,
    appOrigin,
    agentServiceAvailable,
    agentFound,
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
    userId,
  };
  if (!(await isAgentServiceAvailable())) {
    return typedjson({ error: "Agent service unavailable for the selected scope" }, { status: 503 });
  }
  try {
    await resolveAgent(agentId, scope);
  } catch (error) {
    return typedjson(
      {
        error: isAgentNotFoundError(error)
          ? "Agent unavailable in the selected scope"
          : "Agent service unavailable for the selected scope",
      },
      { status: isAgentNotFoundError(error) ? 404 : 503 },
    );
  }

  const fd = await request.formData();
  const intent = fd.get("intent");
  if (intent !== "set-visibility") return { error: `unknown intent: ${String(intent)}` };
  const visibility = String(fd.get("visibility") || "");
  if (visibility !== "private" && visibility !== "public-guest") {
    return { error: `invalid visibility value: ${visibility}` };
  }

  try {
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const response = await fetch(`${AGENT_API_URL}/api/v1/agent/agents/${agentId}`, {
      method: "PATCH",
      headers: scopeHeaders(scope),
      body: JSON.stringify({ visibility }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return typedjson(
        {
          error:
            response.status === 404
              ? "Agent unavailable in the selected scope"
              : "Visibility update unavailable",
        },
        { status: response.status === 404 ? 404 : 503 },
      );
    }
  } catch {
    return typedjson({ error: "Visibility update unavailable" }, { status: 503 });
  }

  return { ok: true, visibility };
}

export default function SharePage() {
  const { agent, embedUrl, agentServiceAvailable, agentFound } =
    useTypedLoaderData<typeof loader>();
  const actionData = useActionData<{ ok?: boolean; visibility?: string; error?: string }>();
  const [copied, setCopied] = useState<string | null>(null);

  if (!agentServiceAvailable || !agent || !embedUrl) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Share agent" />
        </NavBar>
        <PageBody>
          <Callout variant={agentFound ? "warning" : "error"}>
            {agentFound
              ? "Agent sharing is temporarily unavailable. Your selected scope is unchanged; try again when the agent service is reachable."
              : "Agent unavailable in the selected scope."}
          </Callout>
        </PageBody>
      </PageContainer>
    );
  }

  const currentVisibility =
    actionData?.visibility ?? agent.visibility;
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

        {actionData?.error && (
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
