import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { coreRequest, type CoreEndUser } from "~/services/coreApi.server";
import { collectionMetadata, parseCollectionQuery } from "~/services/pagination.server";

// THE ENDUSER ACCOUNTS PAGE (WIN-257 T8).
//
// `database.endUser.findMany` and `database.endUser.count` — a `where` assembled
// in this file out of `organizationId`, a `disabledAt` branch and a
// case-insensitive `contains` over the display name and every identity subject —
// become `GET /api/v1/environments/:environmentId/end-users`, which is
// `listEndUsers`. The filter is the contract's now; this route sends the three
// parameters and renders what comes back.
//
// THE SCREEN STAYS PAGE-NUMBERED, AND THAT COST A DECISION ON THE OTHER SIDE.
// Its controls are `?page=&pageSize=`, its Previous/Next links are built from a
// page number and it prints "Page 3 of 12". V1 pages with a cursor the contract
// calls OPAQUE — "send back a nextCursor this service issued" — so constructing
// one here would be this file guessing at another deployable's format, and
// echoing one would leave the screen able to walk forward and nothing else.
// `environment-end-users.controller.ts` therefore publishes `offset` as well,
// and refuses the two together; its banner carries the reasoning. This loader
// sends the offset the screen asked for, and `total` comes off the page block,
// which is what `database.endUser.count` used to answer.

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
  let users: readonly CoreEndUser[];
  let total: number;
  try {
    const answer = await coreRequest<readonly CoreEndUser[]>("environments.endUsers.list", {
      request,
      parameters: { environmentId: scope.environmentId },
      query: {
        limit: query.pageSize,
        offset: query.offset,
        ...(status ? { status } : {}),
        ...(query.search ? { search: query.search } : {}),
      },
    });
    users = answer.data;
    total = answer.page?.total ?? answer.data.length;
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("EndUser accounts unavailable", { status: 503 });
  }
  const pagination = collectionMetadata(total, query);
  return json({
    surface: "accounts" as const,
    title: "EndUser accounts",
    description: "EndUser identities are a distinct principal tier from canonical operator accounts and memberships.",
    panel: {
      ok: true as const,
      data: {
        users: users.map((user) => ({
          id: user.endUserId,
          displayName: user.displayName,
          disabledAt: user.disabledAt,
          createdAt: user.createdAt,
          identities: user.identities,
        })),
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
    provenance: "Canonical Organization-scoped EndUser and EndUserIdentity rows, served by the V1 end-user route",
  });
}

export default function Accounts() {
  return <M4Surface data={useLoaderData<typeof loader>()} />;
}
