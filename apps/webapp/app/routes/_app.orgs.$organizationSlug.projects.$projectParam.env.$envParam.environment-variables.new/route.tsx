import { json, type ActionFunctionArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { Page } from "~/components/platos/DashboardShell";
import { requireEnvironmentScope } from "~/services/auth.server";
import { coreData } from "~/services/coreApi.server";

// WRITING A PLAIN ENVIRONMENT VALUE (WIN-257 T8, WIN-259).
//
// `database.environmentVariable.upsert` — with `kind: EnvironmentVariableKind.
// PLAIN`, `credentialId: null`, `lastUpdatedBy` and `version: { increment: 1 }`
// assembled in this file — becomes
// `PUT /api/v1/environments/:environmentId/variables/:key`, which is
// `setEnvironmentVariable`. Every one of those four fields is the secrets
// context's decision now: the kind follows from `secret`, the version is its
// counter, and the last writer is the authenticated operator rather than a value
// this route passes about itself.
//
// `secret: false` IS SENT EXPLICITLY, AND IT IS THIS SCREEN'S ONLY CLAIM. The
// form is "Add plain environment value" and its own copy says provider secrets
// are created through Credential-backed screens and never redisplayed here.
// Omitting the field would take the same default; sending it says the screen
// means it.
//
// THE SUBMITTED VALUE IS NEVER ECHOED. The response is `{"ok":true}` — not the
// resource — because the resource carries the plaintext back for a PLAIN row, and
// a form POST that answered with the value it was given would put it in a
// browser's history, a proxy's log and any screenshot of the tab. The access
// level asked for is `secret:mutate`, which is the gate the old route asked for
// and the one `authorizeVault` re-derives on the other side.

export async function action({ request, params }: ActionFunctionArgs) {
  if (!params.organizationSlug || !params.projectParam || !params.envParam) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({
    request,
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectParam,
    environmentSlug: params.envParam,
    access: "secret:mutate",
  });
  const form = await request.formData();
  const key = String(form.get("key") ?? "").trim();
  const value = String(form.get("value") ?? "");
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return json({ ok: false, error: "Use uppercase environment key syntax" }, { status: 400 });
  try {
    await coreData("environments.variables.set", {
      request,
      parameters: { environmentId: scope.environmentId, key },
      body: { value, secret: false },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    return json({ ok: false, error: "Unable to save environment value" }, { status: 503 });
  }
  return json({ ok: true });
}

export default function NewVariable(){return <Page><Form method="post" className="max-w-xl rounded-lg border border-grid-bright bg-background-bright p-5"><h1 className="text-xl font-semibold">Add plain environment value</h1><p className="mt-2 text-sm text-text-dimmed">Provider secrets are created through Credential-backed provider screens and never redisplayed here.</p><input name="key" placeholder="KEY_NAME" className="mt-5 w-full rounded border border-grid-bright bg-charcoal-900 px-3 py-2"/><textarea name="value" className="mt-3 min-h-28 w-full rounded border border-grid-bright bg-charcoal-900 px-3 py-2"/><button className="mt-3 rounded bg-indigo-500 px-4 py-2">Save</button></Form></Page>;}
