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

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const model = await platosControlDatabase.model.findUnique({
    where: { id: params.modelId },
    include: { prices: { orderBy: { effectiveFrom: "desc" } } },
  });
  if (!model) return json({ error: "Model not found" }, { status: 404 });
  return json({ model });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);
  return json(
    { error: "Canonical ModelPrice history is append-only and cannot be changed through this route" },
    { status: 405 }
  );
}
