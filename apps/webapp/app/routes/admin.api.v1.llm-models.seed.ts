import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPAT } from "~/services/patService.server";

export async function action({ request }: ActionFunctionArgs) {
  const authResult = await authenticateApiRequestWithPAT(request);
  if (!authResult) return json({ error: "Invalid or Missing API key" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: authResult.userId } });
  if (!user?.admin) {
    return json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }
  return json(
    { error: "Static legacy model seeding was removed; use the canonical daily LiteLLM refresh" },
    { status: 410 }
  );
}
