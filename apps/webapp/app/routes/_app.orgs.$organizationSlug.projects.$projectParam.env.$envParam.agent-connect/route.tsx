import { LinkIcon, ClipboardIcon, CheckIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { listAgents } from "~/services/platosAgent.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Connect Your Frontend | Platos" }];

type AgentSummary = {
  id: string;
  name: string;
  model?: string;
};

type ConnectionDetails = {
  websocket?: { url?: string };
  rest?: {
    baseUrl?: string;
    auth?: { headers?: Record<string, string> };
  };
  toolSync?: { url?: string };
};

// Theme I.8 + I.9 — dynamic per-agent playbook + dev-mode mint-token.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  let connectionDetails: ConnectionDetails | null = null;
  let agents: AgentSummary[] = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/connect`, {
        headers: {
          "X-Platos-Organization-Id": scope.organizationId,
          "X-Platos-Project-Id": scope.projectId,
          "X-Platos-Environment-Id": scope.environmentId,
          "X-Platos-User-Id": scope.userId,
        },
      });
      if (res.ok) connectionDetails = (await res.json()) as ConnectionDetails;

      try {
        const listed = (await listAgents(scope)) as { agents?: AgentSummary[] };
        agents = Array.isArray(listed?.agents) ? listed.agents : [];
      } catch {
        agents = [];
      }
    }
  } catch {
    // Agent service offline — fall back to placeholder snippets.
  }

  // Dev-mode mint-token (Theme I.9): only enabled when PLATOS_TEST_MODE=true.
  // We surface an in-browser button that hits the /agent-connect/mint-token
  // loader (see the `mint-token.ts` resource route sibling). Rendering the
  // button conditionally here lets the ConnectPage show it without a
  // client-side env probe.
  const devMintEnabled = process.env.PLATOS_TEST_MODE === "true";

  return typedjson({
    connectionDetails,
    scope,
    agents,
    devMintEnabled,
  });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="p-1.5 rounded hover:bg-charcoal-700 transition-colors"
      title="Copy"
    >
      {copied ? (
        <CheckIcon className="size-4 text-green-500" />
      ) : (
        <ClipboardIcon className="size-4 text-text-dimmed" />
      )}
    </button>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="relative rounded-lg border border-charcoal-700 bg-charcoal-850 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-charcoal-700 bg-charcoal-800">
        <span className="text-xs text-text-dimmed">{language}</span>
        <CopyButton text={code} />
      </div>
      <pre className="px-4 py-3 text-sm text-text-bright overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MintTokenButton() {
  const [state, setState] = useState<"idle" | "loading" | "minted" | "error">("idle");
  const [token, setToken] = useState<string | null>(null);

  async function onClick() {
    setState("loading");
    try {
      const res = await fetch("./mint-token", { method: "POST" });
      if (!res.ok) throw new Error("mint failed");
      const json = (await res.json()) as { token?: string };
      if (!json.token) throw new Error("no token");
      setToken(json.token);
      setState("minted");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="rounded-lg border border-indigo-700 bg-indigo-950/30 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="text-xs font-semibold text-indigo-300">Dev mode — mint a test session token</span>
          <p className="text-xs text-text-dimmed mt-1">
            Returns a 5-minute session token signed with{" "}
            <code className="px-1 bg-charcoal-700 rounded">PLATOS_SESSION_SECRET</code>. Paste it
            into <code className="px-1 bg-charcoal-700 rounded">X-Platos-Session-Token</code> to
            poke the agent directly. Disabled in production (<code className="px-1 bg-charcoal-700 rounded">PLATOS_TEST_MODE=true</code> only).
          </p>
        </div>
        <button
          onClick={onClick}
          disabled={state === "loading"}
          className="rounded border border-indigo-500 bg-indigo-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
        >
          {state === "loading" ? "Minting…" : state === "minted" ? "Re-mint" : "Mint"}
        </button>
      </div>
      {token && (
        <div className="mt-3">
          <CodeBlock language="Session token (5 min)" code={token} />
        </div>
      )}
      {state === "error" && (
        <p className="mt-2 text-xs text-red-400">Mint failed — check the server logs.</p>
      )}
    </div>
  );
}

export default function ConnectPage() {
  const { connectionDetails, agents, devMintEnabled } = useTypedLoaderData<typeof loader>();

  // Theme I.8 — agent picker. Default to the first agent (or a placeholder
  // when the list is empty). Snippets below interpolate the selected agent
  // id into the trigger payload.
  const agentIds = useMemo(
    () => (agents.length > 0 ? agents : ([{ id: "your-agent-id", name: "Default Agent" }] as AgentSummary[])),
    [agents],
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    agentIds[0]?.id ?? "your-agent-id",
  );

  const wsUrl = connectionDetails?.websocket?.url || "ws://localhost:3100/agent";
  const httpUrl = connectionDetails?.rest?.baseUrl || "http://localhost:3100/api/v1/agent";
  const organizationId =
    connectionDetails?.rest?.auth?.headers?.["X-Platos-Organization-Id"] || "your-organization-id";
  const projectId =
    connectionDetails?.rest?.auth?.headers?.["X-Platos-Project-Id"] || "your-project-id";
  const environmentId =
    connectionDetails?.rest?.auth?.headers?.["X-Platos-Environment-Id"] || "your-environment-id";

  const agentId = selectedAgentId;

  const tsSnippet = `import { PlatosClient } from "@platosdev/client";

const client = new PlatosClient({
  baseUrl: "${httpUrl.replace(/\/api\/v1\/agent$/, "")}",
  sessionToken: process.env.PLATOS_SESSION_TOKEN!, // mint on your backend
});

const thread = await client.threads.create(undefined, { agentId: "${agentId}" });
for await (const event of client.threads.send(thread.id, "Hello!")) {
  if (event.type === "token") process.stdout.write(event.text);
  if (event.type === "done") break;
}`;

  const pythonSnippet = `import asyncio, os
from platos_client import PlatosClient

async def main():
    async with PlatosClient(
        base_url="${httpUrl.replace(/\/api\/v1\/agent$/, "")}",
        session_token=os.environ["PLATOS_SESSION_TOKEN"],
    ) as client:
        thread = await client.threads.create(agent_id="${agentId}")
        async for event in client.threads.send(thread["id"], "Hello!"):
            if event["type"] == "token":
                print(event["text"], end="", flush=True)
            if event["type"] == "done":
                break

asyncio.run(main())`;

  const curlCreateThread = `curl -X POST ${httpUrl}/threads \\
  -H "Content-Type: application/json" \\
  -H "X-Platos-Organization-Id: ${organizationId}" \\
  -H "X-Platos-Project-Id: ${projectId}" \\
  -H "X-Platos-Environment-Id: ${environmentId}" \\
  -H "X-Platos-User-Id: your-user-id" \\
  -d '{"agentId": "${agentId}", "title": "My Conversation"}'`;

  const curlSendMessage = `curl -X POST ${httpUrl}/threads/THREAD_ID/messages \\
  -H "Content-Type: application/json" \\
  -H "X-Platos-Organization-Id: ${organizationId}" \\
  -H "X-Platos-Project-Id: ${projectId}" \\
  -H "X-Platos-Environment-Id: ${environmentId}" \\
  -H "X-Platos-User-Id: your-user-id" \\
  -d '{"message": "Hello!"}'`;

  const curlListThreads = `curl ${httpUrl}/threads?agentId=${agentId} \\
  -H "X-Platos-Organization-Id: ${organizationId}" \\
  -H "X-Platos-Project-Id: ${projectId}" \\
  -H "X-Platos-Environment-Id: ${environmentId}" \\
  -H "X-Platos-User-Id: your-user-id"`;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Connect Your Frontend" icon={<LinkIcon className="size-5 text-blue-500" />} />
        <PageAccessories>
          <DocsLink slug="sdks" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className="max-w-3xl space-y-8">
          {/* Agent picker (I.8) — drives the snippets below. */}
          <section>
            <Header3>Select an agent</Header3>
            <Paragraph variant="small" className="mt-1 mb-3">
              Snippets below are rewritten to use this agent's id + hostname. If no agents are
              listed, create one on the Agents page and come back.
            </Paragraph>
            <div className="flex items-center gap-3">
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-text-bright"
                data-testid="agent-picker"
              >
                {agentIds.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} {a.model ? `— ${a.model}` : ""}
                  </option>
                ))}
              </select>
              <code className="text-xs text-text-dimmed">agent_id = {agentId}</code>
            </div>
          </section>

          {devMintEnabled && <MintTokenButton />}

          {/* TypeScript SDK */}
          <section>
            <Header3>@platosdev/client (TypeScript)</Header3>
            <Paragraph variant="small" className="mt-1 mb-4">
              Official Node/browser SDK. Handles retry, 401 refresh, and WS reconnection.
            </Paragraph>
            <CodeBlock language="TypeScript" code={tsSnippet} />
          </section>

          {/* Python SDK */}
          <section>
            <Header3>platos-client (Python)</Header3>
            <Paragraph variant="small" className="mt-1 mb-4">
              Async Python SDK. Same surface as the TypeScript one.
            </Paragraph>
            <CodeBlock language="Python" code={pythonSnippet} />
          </section>

          {/* WebSocket (raw) */}
          <section>
            <Header3>Raw WebSocket (no SDK)</Header3>
            <Paragraph variant="small" className="mt-1 mb-4">
              Real-time streaming — tokens arrive as they're generated. Use this if you need to
              integrate with a runtime the SDKs don't ship for yet.
            </Paragraph>
            <CodeBlock
              language="JavaScript"
              code={`import { io } from "socket.io-client";

const socket = io("${wsUrl}", {
  auth: {
    organizationId: "${organizationId}",
    projectId: "${projectId}",
    environmentId: "${environmentId}",
    userId: "your-user-id",
  },
  transports: ["websocket"],
});

socket.emit("message", {
  message: "Hello! What can you help me with?",
  agentId: "${agentId}",
});

socket.on("agent_event", (event) => {
  if (event.type === "token") process.stdout.write(event.text);
  if (event.type === "done") socket.disconnect();
});`}
            />
          </section>

          {/* REST API (fallback) */}
          <section>
            <Header3>REST API (non-streaming)</Header3>
            <Paragraph variant="small" className="mt-1 mb-4">
              For environments without WebSocket support. Each snippet targets agent{" "}
              <code className="px-1 bg-charcoal-700 rounded">{agentId}</code>.
            </Paragraph>
            <div className="space-y-4">
              <div>
                <div className="mb-1 text-xs text-text-dimmed">Create a thread</div>
                <CodeBlock language="cURL" code={curlCreateThread} />
              </div>
              <div>
                <div className="mb-1 text-xs text-text-dimmed">Send a message</div>
                <CodeBlock language="cURL" code={curlSendMessage} />
              </div>
              <div>
                <div className="mb-1 text-xs text-text-dimmed">List this agent's threads</div>
                <CodeBlock language="cURL" code={curlListThreads} />
              </div>
            </div>
          </section>

          {/* Auth info */}
          <section>
            <Header3>Authentication</Header3>
            <Paragraph className="text-xs text-text-dimmed mb-3">
              Three auth modes, used in different contexts. Pick one per request — do not combine.
            </Paragraph>
            <div className="rounded-lg border border-charcoal-700 p-4 space-y-4">
              <div>
                <span className="text-xs font-semibold text-text-bright">
                  1. Direct headers <span className="text-text-dimmed">(browser → Platos API)</span>
                </span>
                <p className="text-xs text-text-dimmed mt-1">
                  Send{" "}
                  <code className="px-1 bg-charcoal-700 rounded">X-Platos-Organization-Id</code>,{" "}
                  <code className="px-1 bg-charcoal-700 rounded">X-Platos-Project-Id</code>,{" "}
                  <code className="px-1 bg-charcoal-700 rounded">X-Platos-Environment-Id</code> and{" "}
                  <code className="px-1 bg-charcoal-700 rounded">X-Platos-User-Id</code> on every REST/WS request.
                </p>
              </div>
              <div>
                <span className="text-xs font-semibold text-text-bright">
                  2. Session token <span className="text-text-dimmed">(third-party frontend → Platos API)</span>
                </span>
                <p className="text-xs text-text-dimmed mt-1">
                  Send{" "}
                  <code className="px-1 bg-charcoal-700 rounded">X-Platos-Session-Token</code> — a
                  short-lived JWT that YOUR backend signs with your entity's service secret
                  (HS256). Claims required:{" "}
                  <code className="px-1 bg-charcoal-700 rounded">organizationId</code>,{" "}
                  <code className="px-1 bg-charcoal-700 rounded">projectId</code>,{" "}
                  <code className="px-1 bg-charcoal-700 rounded">environmentId</code>,{" "}
                  <code className="px-1 bg-charcoal-700 rounded">userId</code>,{" "}
                  <code className="px-1 bg-charcoal-700 rounded">exp</code>.
                </p>
              </div>
              <div>
                <span className="text-xs font-semibold text-text-bright">
                  3. Service secret <span className="text-text-dimmed">(backend → Platos WebSocket)</span>
                </span>
                <p className="text-xs text-text-dimmed mt-1">
                  Send{" "}
                  <code className="px-1 bg-charcoal-700 rounded">Authorization: Bearer &lt;secret&gt;</code>{" "}
                  on the WebSocket upgrade request for{" "}
                  <code className="px-1 bg-charcoal-700 rounded">/tools/sync</code>.
                </p>
              </div>
            </div>
          </section>
        </div>
      </PageBody>
    </PageContainer>
  );
}
