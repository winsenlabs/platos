import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type WhoAmIResponse } from "@platos/core/v3";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { authenticateRequest } from "~/services/apiAuth.server";
import { type VerifiedPAT } from "~/services/patService.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateRequest(request, {
    personalAccessToken: true,
    apiKey: false,
  });

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const result = await getIdentityFromPAT(authenticationResult.result);
  if (!result.success) {
    if (result.error === "user_not_found") {
      return json({ error: "User not found" }, { status: 404 });
    }

    return json({ error: result.error }, { status: 401 });
  }

  return json(result.result);
}

async function getIdentityFromPAT(
  pat: VerifiedPAT
): Promise<
  { success: true; result: WhoAmIResponse } | { success: false; error: "user_not_found" }
> {
  const userId = pat.userId;
  const user = await prisma.user.findFirst({
    select: {
      email: true,
    },
    where: {
      id: userId,
    },
  });

  if (!user) {
    return { success: false, error: "user_not_found" };
  }

  return {
    success: true,
    result: {
      userId,
      email: user.email,
      dashboardUrl: env.APP_ORIGIN,
    },
  };
}
