import { mintSessionToken } from "@platos/token-mint";
import { NextResponse } from "next/server";

/**
 * POST /platos/token — returns a short-lived Platos session token the
 * client can pass to PlatosClient. Replace the demo userId resolution
 * with your real auth.
 */
export async function POST() {
  const {
    PLATOS_ORG_ID,
    PLATOS_PROJECT_ID,
    PLATOS_ENV_ID,
    PLATOS_ENTITY_ID,
    PLATOS_ENTITY_SERVICE_SECRET,
  } = process.env;
  if (
    !PLATOS_ORG_ID ||
    !PLATOS_PROJECT_ID ||
    !PLATOS_ENV_ID ||
    !PLATOS_ENTITY_ID ||
    !PLATOS_ENTITY_SERVICE_SECRET
  ) {
    return NextResponse.json(
      { error: "Platos env vars missing — see .env.example" },
      { status: 500 },
    );
  }

  // TODO: replace with your auth. Demo always resolves to a fixed user.
  const userId = "demo-user";

  const token = mintSessionToken({
    serviceSecret: PLATOS_ENTITY_SERVICE_SECRET,
    claims: {
      organizationId: PLATOS_ORG_ID,
      projectId: PLATOS_PROJECT_ID,
      environmentId: PLATOS_ENV_ID,
      userId,
      entityId: PLATOS_ENTITY_ID,
    },
    ttlSeconds: 3600,
  });

  return NextResponse.json({ token });
}
