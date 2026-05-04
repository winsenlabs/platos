/**
 * Theme K.9 — revoke a Platos PAT.
 *
 *   POST /api/v1/user/pat/:id/revoke
 *
 * Soft-revoke: sets `revokedAt`. Revoked PATs fail `verifyPAT` and are
 * still visible in `listPATs` (so the operator can see history) but no
 * longer grant access. Only the PAT's owner may revoke.
 */

import {
  json,
  type ActionFunctionArgs,
} from "@remix-run/server-runtime";
import { authenticateRequestWithPAT } from "~/services/apiAuth.server";
import { revokePAT } from "~/services/patService.server";

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: `Method ${request.method} not allowed` }, { status: 405 });
  }

  const auth = await authenticateRequestWithPAT(request);
  if (!auth) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = params.id;
  if (!id) {
    return json({ error: "Missing PAT id" }, { status: 400 });
  }

  const res = await revokePAT(id, auth.userId);
  if (!res.ok) {
    // Owner mismatch OR already revoked OR unknown id — return 404 to
    // avoid leaking existence to a non-owner.
    return json({ error: "PAT not found or already revoked" }, { status: 404 });
  }

  return json({ ok: true, id });
}
