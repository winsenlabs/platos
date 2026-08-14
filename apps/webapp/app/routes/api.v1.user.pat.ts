/**
 * Theme K.9 — PAT (Platos Personal Access Token) endpoints.
 *
 *   GET  /api/v1/user/pat        — list the caller's PATs
 *   POST /api/v1/user/pat        — mint a new PAT
 *
 * Revocation lives at `/api/v1/user/pat/:id/revoke` (see
 * `api.v1.user.pat.$id.revoke.ts`).
 *
 * Auth: session cookie or a Platos PAT for listing. Minting requires a browser
 * session; PAT-authenticated child minting is prohibited to prevent role or
 * scope escalation. We only return the raw value once and store sha256(raw).
 */

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateRequestWithPAT } from "~/services/apiAuth.server";
import { listPATs, mintPAT, type PATRole } from "~/services/patService.server";

const RoleSchema = z.enum(["admin", "write", "read"]).optional();

const MintBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: RoleSchema,
  scope: z
    .object({
      orgId: z.string().nullable().optional(),
      projectId: z.string().nullable().optional(),
      envId: z.string().nullable().optional(),
    })
    .optional(),
  /** 0 or omitted → no expiry. Capped at 365 days for sanity. */
  ttlDays: z.number().int().min(0).max(365).optional(),
});

function serializeRow<
  T extends {
    createdAt: Date;
    expiresAt: Date | null;
    lastUsedAt?: Date | null;
    revokedAt?: Date | null;
  },
>(r: T) {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await authenticateRequestWithPAT(request);
  if (!auth) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await listPATs(auth.userId);
  return json({
    tokens: rows.map((r) => serializeRow(r)),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: `Method ${request.method} not allowed` }, { status: 405 });
  }

  const auth = await authenticateRequestWithPAT(request);
  if (!auth) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.pat) {
    return json({ error: "PAT-authenticated requests cannot mint child PATs" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = MintBodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "Invalid request body", issues: parsed.error.issues }, { status: 400 });
  }

  const { name, role, scope, ttlDays } = parsed.data;
  const ttlSeconds = ttlDays && ttlDays > 0 ? ttlDays * 86400 : 0;

  const minted = await mintPAT({
    userId: auth.userId,
    name,
    role: role as PATRole | undefined,
    orgId: scope?.orgId ?? null,
    projectId: scope?.projectId ?? null,
    envId: scope?.envId ?? null,
    ttlSeconds,
  });

  // Raw `token` is returned here ONCE — the client is responsible for
  // storing it. We never log or persist the plaintext.
  return json(
    {
      id: minted.id,
      token: minted.token,
      name: minted.name,
      role: minted.role,
      scope: {
        orgId: minted.organizationId,
        projectId: minted.projectId,
        envId: minted.environmentId,
      },
      expiresAt: minted.expiresAt ? minted.expiresAt.toISOString() : null,
      createdAt: minted.createdAt.toISOString(),
    },
    { status: 201 }
  );
}
