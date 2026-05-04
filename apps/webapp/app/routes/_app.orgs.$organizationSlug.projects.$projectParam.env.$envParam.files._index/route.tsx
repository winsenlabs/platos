/**
 * PIFSP-16 — File System tab.
 * 4-level drill-down: Agents → Users → Conversations → Attachments.
 * Level is determined by URL search params: agentId, userId, threadId.
 */
import {
  FolderIcon,
  DocumentIcon,
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon,
  PhotoIcon,
  ArrowLeftIcon,
} from "@heroicons/react/20/solid";
import { Link, useNavigate, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  agentConversationPath,
  agentFilesPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Files | Platos" }];

// ─── Types ────────────────────────────────────────────────────────────────

type AgentEntry = { agentId: string; name: string; attachmentCount: number; lastAttachmentAt: string | null };
type UserEntry = { userId: string; attachmentCount: number; distinctThreads: number; lastAttachmentAt: string | null };
type ConvEntry = { threadId: string; title: string | null; attachmentCount: number; lastActivityAt: string | null };
type AttachmentEntry = {
  id: string; filename: string; mimeType: string; kind: string;
  bytes: number; uploadedAt: string; messageId: string | null; downloadUrl: string | null;
};

type LoaderData = {
  level: "agents" | "users" | "conversations" | "attachments";
  agents: AgentEntry[];
  users: UserEntry[];
  conversations: ConvEntry[];
  attachments: AttachmentEntry[];
  agentId: string | null;
  agentName: string | null;
  userId: string | null;
  threadId: string | null;
  org: { slug: string };
  project: { slug: string };
  environment: { slug: string };
};

// ─── Loader ───────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const headers = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };

  const url = new URL(request.url);
  const agentId = url.searchParams.get("agentId");
  const paramUserId = url.searchParams.get("userId");
  const threadId = url.searchParams.get("threadId");

  const base = {
    agents: [] as AgentEntry[],
    users: [] as UserEntry[],
    conversations: [] as ConvEntry[],
    attachments: [] as AttachmentEntry[],
    agentId: agentId as string | null,
    agentName: url.searchParams.get("agentName") as string | null,
    userId: paramUserId as string | null,
    threadId: threadId as string | null,
    org: { slug: organizationSlug },
    project: { slug: projectParam },
    environment: { slug: envParam },
  };

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (!(await isAgentServiceAvailable())) {
      return typedjson({ ...base, level: "agents" as const });
    }

    const fetchJSON = async (path: string): Promise<Record<string, unknown> | null> => {
      const res = await fetch(`${AGENT_API_URL}${path}`, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      return res.json() as Promise<Record<string, unknown>>;
    };

    if (threadId) {
      const resp = await fetchJSON(`/api/v1/agent/files/threads/${encodeURIComponent(threadId)}/attachments?limit=200`);
      return typedjson({
        ...base,
        level: "attachments" as const,
        attachments: (resp?.attachments as AttachmentEntry[]) ?? [],
      });
    }

    if (paramUserId && agentId) {
      const resp = await fetchJSON(
        `/api/v1/agent/files/agents/${encodeURIComponent(agentId)}/users/${encodeURIComponent(paramUserId)}/conversations?limit=200`,
      );
      return typedjson({
        ...base,
        level: "conversations" as const,
        conversations: (resp?.conversations as ConvEntry[]) ?? [],
      });
    }

    if (agentId) {
      const resp = await fetchJSON(`/api/v1/agent/files/agents/${encodeURIComponent(agentId)}/users?limit=200`);
      return typedjson({
        ...base,
        level: "users" as const,
        users: (resp?.users as UserEntry[]) ?? [],
      });
    }

    const resp = await fetchJSON("/api/v1/agent/files/agents?limit=200");
    return typedjson({
      ...base,
      level: "agents" as const,
      agentId: null,
      agents: (resp?.agents as AgentEntry[]) ?? [],
    });
  } catch {
    return typedjson({ ...base, level: "agents" as const });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MimeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <PhotoIcon className="size-4 text-sky-400" />;
  return <DocumentIcon className="size-4 text-text-dimmed" />;
}

// ─── Route ────────────────────────────────────────────────────────────────

export default function FilesPage() {
  const data = useTypedLoaderData<typeof loader>();
  const navigate = useNavigate();
  const org = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [search, setSearch] = useState("");

  const filesBase = agentFilesPath(
    { slug: data.org.slug },
    { slug: data.project.slug },
    { slug: data.environment.slug },
  );

  // Breadcrumb
  const breadcrumbs = [
    { label: "Files", href: filesBase },
    ...(data.agentId
      ? [{ label: data.agentName ?? data.agentId, href: `${filesBase}?agentId=${encodeURIComponent(data.agentId)}&agentName=${encodeURIComponent(data.agentName ?? "")}` }]
      : []),
    ...(data.userId && data.agentId
      ? [{ label: data.userId, href: `${filesBase}?agentId=${encodeURIComponent(data.agentId)}&agentName=${encodeURIComponent(data.agentName ?? "")}&userId=${encodeURIComponent(data.userId)}` }]
      : []),
    ...(data.threadId ? [{ label: data.threadId.slice(0, 12) + "…", href: "#" }] : []),
  ];

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Files" />
        <PageAccessories>
          <DocsLink slug="attachments-and-files" />
        </PageAccessories>
      </NavBar>

      <PageBody>
        <div className="flex flex-col gap-4">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 text-sm">
            {breadcrumbs.map((b, i) => (
              <span key={b.href} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRightIcon className="size-3 text-text-dimmed" />}
                {i === breadcrumbs.length - 1 ? (
                  <span className="text-text-bright font-medium">{b.label}</span>
                ) : (
                  <Link to={b.href} className="text-text-dimmed hover:text-text-bright">
                    {b.label}
                  </Link>
                )}
              </span>
            ))}
          </nav>

          {/* Back button (not on level 1) */}
          {data.level !== "agents" && (
            <button
              onClick={() => navigate(-1)}
              className="flex items-center gap-1.5 text-xs text-text-dimmed hover:text-text-bright w-fit"
            >
              <ArrowLeftIcon className="size-3" />
              Back
            </button>
          )}

          {/* Search */}
          <Input
            placeholder={
              data.level === "agents" ? "Search agents…" :
              data.level === "users" ? "Search users…" :
              data.level === "conversations" ? "Search conversations…" :
              "Search by filename or type…"
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-80"
          />

          {/* Level 1 — Agents */}
          {data.level === "agents" && (
            data.agents.length === 0 ? (
              <EmptyState message="No file uploads yet. When users attach files to a conversation, they'll appear here." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Agent</TableHeaderCell>
                    <TableHeaderCell>Attachments</TableHeaderCell>
                    <TableHeaderCell>Last upload</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.agents
                    .filter((a) => !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.agentId.toLowerCase().includes(search.toLowerCase()))
                    .map((a) => (
                      <TableRow
                        key={a.agentId}
                        className="cursor-pointer hover:bg-charcoal-800/50"
                        onClick={() => navigate(`${filesBase}?agentId=${encodeURIComponent(a.agentId)}&agentName=${encodeURIComponent(a.name)}`)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <FolderIcon className="size-4 text-sky-400" />
                            <span className="text-text-bright">{a.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>{a.attachmentCount}</TableCell>
                        <TableCell className="text-text-dimmed text-xs">
                          {a.lastAttachmentAt ? new Date(a.lastAttachmentAt).toLocaleDateString() : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            )
          )}

          {/* Level 2 — Users */}
          {data.level === "users" && (
            data.users.length === 0 ? (
              <EmptyState message="No users with uploads for this agent." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>User</TableHeaderCell>
                    <TableHeaderCell>Attachments</TableHeaderCell>
                    <TableHeaderCell>Conversations</TableHeaderCell>
                    <TableHeaderCell>Last upload</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.users
                    .filter((u) => !search || u.userId.toLowerCase().includes(search.toLowerCase()))
                    .map((u) => (
                      <TableRow
                        key={u.userId}
                        className="cursor-pointer hover:bg-charcoal-800/50"
                        onClick={() => navigate(`${filesBase}?agentId=${encodeURIComponent(data.agentId!)}&agentName=${encodeURIComponent(data.agentName ?? "")}&userId=${encodeURIComponent(u.userId)}`)}
                      >
                        <TableCell className="font-mono text-xs text-text-bright">{u.userId}</TableCell>
                        <TableCell>{u.attachmentCount}</TableCell>
                        <TableCell>{u.distinctThreads}</TableCell>
                        <TableCell className="text-text-dimmed text-xs">
                          {u.lastAttachmentAt ? new Date(u.lastAttachmentAt).toLocaleDateString() : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            )
          )}

          {/* Level 3 — Conversations */}
          {data.level === "conversations" && (
            data.conversations.length === 0 ? (
              <EmptyState message="No conversations with uploads for this user." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Conversation</TableHeaderCell>
                    <TableHeaderCell>Attachments</TableHeaderCell>
                    <TableHeaderCell>Last activity</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.conversations
                    .filter((c) => !search || (c.title ?? "").toLowerCase().includes(search.toLowerCase()) || c.threadId.toLowerCase().includes(search.toLowerCase()))
                    .map((c) => (
                      <TableRow
                        key={c.threadId}
                        className="cursor-pointer hover:bg-charcoal-800/50"
                        onClick={() => navigate(`${filesBase}?agentId=${encodeURIComponent(data.agentId!)}&agentName=${encodeURIComponent(data.agentName ?? "")}&userId=${encodeURIComponent(data.userId!)}&threadId=${encodeURIComponent(c.threadId)}`)}
                      >
                        <TableCell>
                          <span className="text-text-bright">{c.title ?? <span className="text-text-dimmed italic">Untitled</span>}</span>
                        </TableCell>
                        <TableCell>{c.attachmentCount}</TableCell>
                        <TableCell className="text-text-dimmed text-xs">
                          {c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleDateString() : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            )
          )}

          {/* Level 4 — Attachments */}
          {data.level === "attachments" && (
            data.attachments.length === 0 ? (
              <EmptyState message="No attachments visible. Archived attachments might still be recoverable — contact an admin." />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.attachments
                  .filter((a) => {
                    if (!search) return true;
                    const q = search.toLowerCase();
                    return a.filename.toLowerCase().includes(q) || a.mimeType.toLowerCase().includes(q);
                  })
                  .map((a) => (
                    <div key={a.id} className="border border-charcoal-700 rounded-lg p-3 flex flex-col gap-2 bg-charcoal-800/30">
                      {/* Thumbnail for images */}
                      {a.mimeType.startsWith("image/") && a.downloadUrl ? (
                        <img
                          src={a.downloadUrl}
                          alt={a.filename}
                          className="w-full h-32 object-cover rounded"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-20 flex items-center justify-center bg-charcoal-800 rounded">
                          <MimeIcon mimeType={a.mimeType} />
                        </div>
                      )}

                      {/* Metadata */}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-text-bright truncate" title={a.filename}>
                          {a.filename}
                        </p>
                        <p className="text-xs text-text-dimmed">
                          {a.mimeType} · {formatBytes(a.bytes)}
                        </p>
                        <p className="text-xs text-text-dimmed">
                          {new Date(a.uploadedAt).toLocaleString()}
                        </p>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2">
                        {a.downloadUrl && (
                          <a
                            href={a.downloadUrl}
                            download={a.filename}
                            className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
                          >
                            <ArrowDownTrayIcon className="size-3" />
                            Download
                          </a>
                        )}
                        {data.agentId && a.messageId && (
                          <Link
                            to={agentConversationPath(
                              { slug: data.org.slug },
                              { slug: data.project.slug },
                              { slug: data.environment.slug },
                              data.agentId,
                              data.threadId!,
                            )}
                            target="_blank"
                            className="flex items-center gap-1 text-xs text-text-dimmed hover:text-text-bright ml-auto"
                          >
                            <ArrowTopRightOnSquareIcon className="size-3" />
                            Open
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-text-dimmed gap-3">
      <FolderIcon className="size-10 opacity-40" />
      <Paragraph variant="small" className="text-center max-w-sm">{message}</Paragraph>
    </div>
  );
}
