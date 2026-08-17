import {
  CheckBadgeIcon,
  IdentificationIcon,
  UsersIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
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
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Connected Accounts | Platos" }];

// UNIT D (MCP consumption / Surface 4) — read-only per-user connected-accounts
// view. Lists the PlatosEndUsers in this scope with their adopted
// `linkedExternalId` (the Composio user_id, preferred as {{endUserId}}) and
// their verified channel identities (email/slack/…). The actual binding
// happens via Walle's finish-setup flow — this page is operator visibility
// only, so there is no action(). Queries Prisma directly (mirrors the
// toolMappings query in agent-entities._index), which keeps the page working
// even when the agent service is down.
const MAX_ACCOUNTS = 200;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
  };

  type AccountRow = {
    id: string;
    externalUserId: string;
    linkedExternalId: string | null;
    displayName: string | null;
    email: string | null;
    threadCount: number;
    lastActiveAt: string;
    identities: Array<{
      id: string;
      channel: string;
      handle: string;
      verified: boolean;
      sourceEntityId: string | null;
    }>;
  };

  let accounts: AccountRow[] = [];
  try {
    const rows = await prisma.platosEndUser.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      orderBy: { lastActiveAt: "desc" },
      take: MAX_ACCOUNTS,
      select: {
        id: true,
        externalUserId: true,
        linkedExternalId: true,
        displayName: true,
        email: true,
        threadCount: true,
        lastActiveAt: true,
        identities: {
          select: {
            id: true,
            channel: true,
            handle: true,
            verified: true,
            sourceEntityId: true,
          },
          orderBy: [{ verified: "desc" }, { channel: "asc" }],
        },
      },
    });
    accounts = rows.map((r) => ({
      id: r.id,
      externalUserId: r.externalUserId,
      linkedExternalId: r.linkedExternalId,
      displayName: r.displayName,
      email: r.email,
      threadCount: r.threadCount,
      lastActiveAt: r.lastActiveAt.toISOString(),
      identities: r.identities,
    }));
  } catch {
    // DB temporarily unavailable — render the empty state rather than 500.
  }

  return typedjson({ accounts });
}

// UNIT D — per-channel colour so the identity badges read at a glance. Falls
// back to a neutral chip for unknown channels.
const CHANNEL_COLORS: Record<string, string> = {
  email: "border-blue-700/40 bg-blue-900/30 text-blue-300",
  slack: "border-violet-700/40 bg-violet-900/30 text-violet-300",
  teams: "border-indigo-700/40 bg-indigo-900/30 text-indigo-300",
  whatsapp: "border-emerald-700/40 bg-emerald-900/30 text-emerald-300",
  telegram: "border-sky-700/40 bg-sky-900/30 text-sky-300",
  discord: "border-indigo-700/40 bg-indigo-900/30 text-indigo-300",
  phone: "border-teal-700/40 bg-teal-900/30 text-teal-300",
  web: "border-charcoal-600 bg-charcoal-800 text-text-dimmed",
};

function IdentityBadge({
  identity,
}: {
  identity: { channel: string; handle: string; verified: boolean };
}) {
  const cls =
    CHANNEL_COLORS[identity.channel] ??
    "border-charcoal-600 bg-charcoal-800 text-text-dimmed";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${cls}`}
      title={`${identity.channel}: ${identity.handle}${identity.verified ? " (verified)" : " (unverified)"}`}
    >
      {identity.verified && <CheckBadgeIcon className="size-3" />}
      <span className="font-medium">{identity.channel}</span>
      <span className="opacity-70 font-mono truncate max-w-[160px]">{identity.handle}</span>
    </span>
  );
}

export default function AgentAccountsPage() {
  const { accounts } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Connected Accounts"
          icon={<UsersIcon className="size-5 text-blue-500" />}
        />
        <PageAccessories>
          <DocsLink slug="connected-entities" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <Paragraph variant="small" className="mb-4 max-w-3xl">
          End-users seen in this environment, with their adopted external id
          (the Composio <span className="font-mono">user_id</span>, preferred as{" "}
          <code className="font-mono text-xs">{"{{endUserId}}"}</code> when set)
          and their linked channel identities. Binding happens automatically via
          the entity's finish-setup flow — this view is read-only.
        </Paragraph>

        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <IdentificationIcon className="size-12 text-charcoal-500" />
            <Paragraph variant="base/bright" className="text-center max-w-md">
              No connected accounts yet. End-users appear here after their first
              conversation or identity assertion in this environment.
            </Paragraph>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell>Linked external id</TableHeaderCell>
                <TableHeaderCell>Identities</TableHeaderCell>
                <TableHeaderCell>Threads</TableHeaderCell>
                <TableHeaderCell>Last active</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      {a.displayName && (
                        <span className="text-sm font-medium text-text-bright">
                          {a.displayName}
                        </span>
                      )}
                      {a.email && (
                        <span className="text-xs text-emerald-400">{a.email}</span>
                      )}
                      <span className="text-xs text-text-dimmed font-mono truncate max-w-[220px]">
                        {a.externalUserId}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {a.linkedExternalId ? (
                      <span className="text-xs font-mono text-text-bright break-all">
                        {a.linkedExternalId}
                      </span>
                    ) : (
                      <Badge variant="small" className="border-charcoal-600 bg-charcoal-800 text-text-dimmed">
                        not adopted
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {a.identities.length === 0 ? (
                      <span className="text-text-dimmed text-xs">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1 max-w-[380px]">
                        {a.identities.map((idn) => (
                          <IdentityBadge key={idn.id} identity={idn} />
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{a.threadCount}</TableCell>
                  <TableCell className="text-text-dimmed text-xs whitespace-nowrap">
                    {new Date(a.lastActiveAt).toLocaleString(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PageBody>
    </PageContainer>
  );
}
