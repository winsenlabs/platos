/**
 * EOBD.97 — wire-test page for a connected entity.
 *
 * Developer workflow:
 *   - Register entity, see it green (connected) on the list.
 *   - Click "Wire test" → this page.
 *   - Click "Dispatch test call" → browser POSTs this route's action.
 *   - Action proxies a signed test tool-call through the agent's
 *     tool executor (real live WS to the entity backend when
 *     connected; HTTP callback fallback otherwise).
 *   - Page renders: outbound request body, HMAC timestamp + nonce,
 *     signature, entity's response, total latency, and any error.
 *
 * Saves a first-time integrator ~10 minutes of "did my backend
 * actually connect?" uncertainty.
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
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Wire test | Platos" }];

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });

  const entityId = params.entityId;
  if (!entityId) throw new Response(undefined, { status: 404 });

  const entity = await prisma.platosConnectedEntity.findFirst({
    where: {
      organizationId: project.organizationId,
      projectId: project.id,
      entityId,
    },
    select: {
      id: true,
      entityId: true,
      connectionStatus: true,
      lastConnectedAt: true,
    },
  });
  if (!entity) throw new Response(undefined, { status: 404 });

  // Pre-pick a tool that looks like a reasonable health-check target:
  // any enabled mapping for this entity — the agent will resolve the
  // tool name from the mapping. Operator can override via form input.
  const mapping = await prisma.platosEntityToolMapping.findFirst({
    where: {
      environmentId: environment.id,
      entityId: entity.id,
      enabled: true,
    },
    orderBy: [{ enabled: "desc" }],
    select: { toolId: true },
  });

  return typedjson({
    entity,
    suggestedTool: mapping?.toolId ?? "ping",
  });
}

interface WireTestResult {
  status: "success" | "failed" | "timeout";
  latencyMs: number;
  result?: unknown;
  error?: string;
  request: {
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  response?: {
    status?: number;
    body?: unknown;
  };
}

export async function action({ params, request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return { error: "project not found" };
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) return { error: "environment not found" };

  const entityId = params.entityId;
  if (!entityId) return { error: "entity id missing" };
  const entity = await prisma.platosConnectedEntity.findFirst({
    where: {
      organizationId: project.organizationId,
      projectId: project.id,
      entityId,
    },
    select: { id: true, entityId: true },
  });
  if (!entity) return { error: "entity not found in scope" };

  const fd = await request.formData();
  const toolName = String(fd.get("toolName") || "ping").trim();
  let paramsJson: Record<string, unknown> = {};
  try {
    const raw = String(fd.get("params") || "{}");
    paramsJson = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (err: any) {
    return { error: `Invalid JSON for params: ${err?.message}` };
  }

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  // Proxy the call through the agent's existing admin wire-test endpoint.
  // The endpoint (a small POST /api/v1/agent/entities/:entityId/wire-test
  // handler in the agent) dispatches via ToolExecutorService — same
  // code path real tool calls take — and returns the request/response
  // transcript.
  const AGENT_API_URL =
    process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const startedAt = Date.now();
  try {
    const res = await fetch(
      `${AGENT_API_URL}/api/v1/agent/entities/${encodeURIComponent(entity.entityId)}/wire-test`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Organization-Id": scope.organizationId,
          "X-Platos-Project-Id": scope.projectId,
          "X-Platos-Environment-Id": scope.environmentId,
          "X-Platos-User-Id": scope.userId,
        },
        body: JSON.stringify({ toolName, params: paramsJson }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = await res.json().catch(() => ({}));
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      void telemetry.platos.entityWireTest({ organizationId: scope.organizationId, entityId: entity.entityId, success: false });
      return {
        ok: false,
        result: {
          status: "failed",
          latencyMs,
          error: (body as any)?.error || `HTTP ${res.status}`,
          request: (body as any)?.request ?? {
            url: "(agent-internal)",
            headers: {},
            body: JSON.stringify({ toolName, params: paramsJson }),
          },
          response: { status: res.status, body },
        } satisfies WireTestResult,
      };
    }
    void telemetry.platos.entityWireTest({ organizationId: scope.organizationId, entityId: entity.entityId, success: true });
    return { ok: true, result: body as WireTestResult };
  } catch (err: any) {
    return {
      ok: false,
      result: {
        status: "timeout" as const,
        latencyMs: Date.now() - startedAt,
        error: err?.message || String(err),
        request: {
          url: `${AGENT_API_URL}/api/v1/agent/entities/${entity.entityId}/wire-test`,
          headers: {},
          body: JSON.stringify({ toolName, params: paramsJson }),
        },
      } satisfies WireTestResult,
    };
  }
}

export default function WireTestPage() {
  const { entity, suggestedTool } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [toolName, setToolName] = useState<string>(suggestedTool);
  const [paramsInput, setParamsInput] = useState<string>("{}");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={`Wire test · ${entity.entityId}`} />
      </NavBar>
      <PageBody>
        <Paragraph>
          Dispatch a signed test tool-call through the same code path production
          turns use. Catches HMAC mismatches, callback-URL reachability issues,
          and response-shape surprises before you ever attach a tool to an
          agent.
        </Paragraph>
        <div
          style={{
            marginTop: 12,
            padding: 8,
            borderRadius: 6,
            background: "rgba(255,255,255,0.05)",
            fontSize: 12,
          }}
        >
          <div>
            Connection status: <code>{entity.connectionStatus || "unknown"}</code>
          </div>
          <div>
            Last connected:{" "}
            <code>
              {entity.lastConnectedAt
                ? new Date(entity.lastConnectedAt).toISOString()
                : "never"}
            </code>
          </div>
        </div>

        <Header2 className="mt-8">Dispatch a test call</Header2>
        <Form method="post">
          <div style={{ marginTop: 8 }}>
            <label>
              Tool name:{" "}
              <input
                name="toolName"
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid #374151",
                }}
              />
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={{ display: "block", marginBottom: 4 }}>
              Params (JSON):
            </label>
            <textarea
              name="params"
              value={paramsInput}
              onChange={(e) => setParamsInput(e.target.value)}
              rows={4}
              style={{
                width: "100%",
                fontFamily: "monospace",
                padding: 8,
                borderRadius: 6,
                border: "1px solid #374151",
              }}
            />
          </div>
          <Button variant="primary/medium" type="submit" className="mt-3">
            Dispatch test call
          </Button>
        </Form>

        {actionData && "error" in actionData && (
          <Paragraph>
            <span style={{ color: "#ef4444" }}>Error: {actionData.error}</span>
          </Paragraph>
        )}
        {actionData && "result" in actionData && (
          <>
            <Header3 className="mt-8">Result</Header3>
            <pre
              style={{
                padding: 12,
                background: "rgba(255,255,255,0.05)",
                borderRadius: 6,
                overflowX: "auto",
              }}
            >
              {JSON.stringify(actionData.result, null, 2)}
            </pre>
          </>
        )}
      </PageBody>
    </PageContainer>
  );
}
