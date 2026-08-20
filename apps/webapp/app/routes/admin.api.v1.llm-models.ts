import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPAT } from "~/services/patService.server";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";

async function requireAdmin(request: Request) {
  const authResult = await authenticateApiRequestWithPAT(request);
  if (!authResult) throw json({ error: "Invalid or Missing API key" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: authResult.userId } });
  if (!user?.admin) {
    throw json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }
}

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const url = new URL(request.url);
  const page = boundedInteger(url.searchParams.get("page"), 1, 1);
  const pageSize = boundedInteger(url.searchParams.get("pageSize"), 50, 1, 200);
  const [models, total] = await Promise.all([
    platosControlDatabase.model.findMany({
      include: { prices: { orderBy: { effectiveFrom: "desc" }, take: 1 } },
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    platosControlDatabase.model.count(),
  ]);
  return json({ models, total, page, pageSize });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);
  return json(
    { error: "Canonical model metadata and append-only prices are refreshed by the authenticated LiteLLM callback" },
    { status: 405 }
  );
}
