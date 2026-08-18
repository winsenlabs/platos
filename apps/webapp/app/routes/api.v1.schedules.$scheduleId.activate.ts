import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";

export async function action(_args: ActionFunctionArgs) {
  return json({ error: { code: "EXTERNAL_TRIGGER_REQUIRED" } }, { status: 409 });
}
