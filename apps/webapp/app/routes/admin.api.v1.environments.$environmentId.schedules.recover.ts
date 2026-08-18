import { ActionFunctionArgs, json } from "@remix-run/server-runtime";

export async function action({ request, params }: ActionFunctionArgs) {
  void request;
  void params;
  return json({ error: { code: "EXTERNAL_TRIGGER_REQUIRED" } }, { status: 409 });
}
