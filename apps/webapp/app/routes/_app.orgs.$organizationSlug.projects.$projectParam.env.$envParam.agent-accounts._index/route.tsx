import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { database } from "~/services/database.server";
import { collectionMetadata, parseCollectionQuery } from "~/services/pagination.server";

const collection = { defaultPageSize: 25, maxPageSize: 100, search: true, filters: ["status"] };

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (!params.organizationSlug || !params.projectParam || !params.envParam) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({
    request,
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectParam,
    environmentSlug: params.envParam,
  });
  const query = parseCollectionQuery(new URL(request.url), collection);
  const status = query.filters.status;
  if (status && status !== "active" && status !== "disabled") {
    throw new Response("status must be active or disabled", { status: 400, statusText: "Malformed filter" });
  }
  const where = {
    organizationId: scope.organizationId,
    ...(status === "active" ? { disabledAt: null } : status === "disabled" ? { disabledAt: { not: null } } : {}),
    ...(query.search ? {
      OR: [
        { displayName: { contains: query.search, mode: "insensitive" as const } },
        { identities: { some: { subject: { contains: query.search, mode: "insensitive" as const } } } },
      ],
    } : {}),
  };
  const [users, total] = await Promise.all([
    database.endUser.findMany({
      where,
      select: {
        id: true,
        displayName: true,
        disabledAt: true,
        createdAt: true,
        identities: { select: { issuer: true, channel: true, subject: true, verifiedAt: true, disabledAt: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.pageSize,
      skip: query.offset,
    }),
    database.endUser.count({ where }),
  ]);
  const pagination = collectionMetadata(total, query);
  return json({
    surface: "accounts" as const,
    title: "EndUser accounts",
    description: "EndUser identities are a distinct principal tier from canonical operator accounts and memberships.",
    panel: {
      ok: true as const,
      data: {
        users,
        items: users,
        total,
        limit: query.pageSize,
        offset: query.offset,
        hasMore: pagination.hasNext,
        pagination,
        filters: { search: query.search || null, status: status ?? null },
      },
    },
    collection: query,
    provenance: "Canonical Organization-scoped EndUser and EndUserIdentity rows",
  });
}

export default function Accounts() {
  return <M4Surface data={useLoaderData<typeof loader>()} />;
}
