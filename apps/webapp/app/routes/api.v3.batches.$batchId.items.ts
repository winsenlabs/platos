import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";

export async function action(_args: ActionFunctionArgs) {
  return json(
    { error: { code: "EXTERNAL_TRIGGER_REQUIRED" } },
    { status: 409, headers: { "x-should-retry": "false" } }
  );
}

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    {
      error: "Method not allowed. Use POST to stream batch items.",
    },
    { status: 405 }
  );
}
