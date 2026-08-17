import { CheckBadgeIcon, IdentificationIcon, UsersIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
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

// Read-only operator view over canonical, organization-owned EndUsers that
// have activity in this Environment. Environment membership is derived through
// Thread rather than copied onto the person or identity rows.
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
    displayName: string | null;
    email: string | null;
    threadCount: number;
    lastActiveAt: string | null;
    identities: Array<{
      id: string;
      channel: string;
      handle: string;
      verified: boolean;
    }>;
  };

  let accounts: AccountRow[] = [];
  let accountsAvailable = true;
  try {
    const rows = await prisma.endUser.findMany({
      where: {
        organizationId: scope.organizationId,
        disabledAt: null,
        threads: { some: { environmentId: scope.environmentId } },
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_ACCOUNTS,
      select: {
        id: true,
        displayName: true,
        identities: {
          where: { disabledAt: null },
          select: {
            id: true,
            channel: true,
            subject: true,
            verifiedAt: true,
          },
          orderBy: [{ verifiedAt: "desc" }, { channel: "asc" }],
        },
        threads: {
          where: { environmentId: scope.environmentId },
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: { updatedAt: true },
        },
        _count: {
          select: {
            threads: { where: { environmentId: scope.environmentId } },
          },
        },
      },
    });
    accounts = rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      email: r.identities.find((identity) => identity.channel === "email")?.subject ?? null,
      threadCount: r._count.threads,
      lastActiveAt: r.threads[0]?.updatedAt.toISOString() ?? null,
      identities: r.identities.map((identity) => ({
        id: identity.id,
        channel: identity.channel,
        handle: identity.subject,
        verified: identity.verifiedAt !== null,
      })),
    }));
  } catch {
    accountsAvailable = false;
  }

  return typedjson({ accounts, accountsAvailable });
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
    CHANNEL_COLORS[identity.channel] ?? "border-charcoal-600 bg-charcoal-800 text-text-dimmed";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${cls}`}
      title={`${identity.channel}: ${identity.handle}${
        identity.verified ? " (verified)" : " (unverified)"
      }`}
    >
      {identity.verified && <CheckBadgeIcon className="size-3" />}
      <span className="font-medium">{identity.channel}</span>
      <span className="max-w-[160px] truncate font-mono opacity-70">{identity.handle}</span>
    </span>
  );
}

export default function AgentAccountsPage() {
  const { accounts, accountsAvailable } = useTypedLoaderData<typeof loader>();

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
          Canonical end-users with thread activity in this environment. Identity records are
          organization-owned and shown here read-only; activity and counts remain scoped to the
          selected environment.
        </Paragraph>

        {!accountsAvailable ? (
          <Callout variant="warning">
            Connected accounts are temporarily unavailable. Your selected scope is unchanged; try
            again when the database is reachable.
          </Callout>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <IdentificationIcon className="size-12 text-charcoal-500" />
            <Paragraph variant="base/bright" className="max-w-md text-center">
              No connected accounts yet. End-users appear here after their first conversation or
              identity assertion in this environment.
            </Paragraph>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell>Account ID</TableHeaderCell>
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
                      {a.email && <span className="text-xs text-emerald-400">{a.email}</span>}
                      <span className="max-w-[220px] truncate font-mono text-xs text-text-dimmed">
                        {a.id}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="break-all font-mono text-xs text-text-bright">{a.id}</span>
                  </TableCell>
                  <TableCell>
                    {a.identities.length === 0 ? (
                      <span className="text-xs text-text-dimmed">—</span>
                    ) : (
                      <div className="flex max-w-[380px] flex-wrap gap-1">
                        {a.identities.map((idn) => (
                          <IdentityBadge key={idn.id} identity={idn} />
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{a.threadCount}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-text-dimmed">
                    {a.lastActiveAt
                      ? new Date(a.lastActiveAt).toLocaleString(undefined, {
                          dateStyle: "short",
                          timeStyle: "short",
                        })
                      : "—"}
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
