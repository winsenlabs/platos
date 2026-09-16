import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { coreData, type CoreEnvironmentVariable } from "~/services/coreApi.server";

// ENVIRONMENT VARIABLES, LISTED (WIN-257 T8, WIN-259).
//
// `database.environmentVariable.findMany` selected `value` and `credentialId`
// and this loader decided what a browser may see: `value: v.credentialId ? null :
// v.value`. That is a redaction rule, and it lived in a Remix loader, one line
// away from the raw column.
//
// `GET /api/v1/environments/:environmentId/variables` is `listEnvironmentVariables`,
// and the rule is the SECRETS CONTEXT'S now: `EnvironmentVariableMetadata`
// publishes `value` (null when the row is credential-backed) beside a `hasSecret`
// boolean. The dashboard renders what it is given and decides nothing, which is
// what WIN-259 asks of every surface that can touch a secret — a redaction a
// transport performs is a redaction a transport can forget.
//
// `present` IS DERIVED THE SAME WAY IT ALWAYS WAS: a value the operator can see,
// or a credential behind it. It is the screen's word for "this key is set".

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (!params.organizationSlug || !params.projectParam || !params.envParam) throw new Response("Invalid scope", { status: 400 });
  const { scope } = await requireEnvironmentScope({
    request,
    organizationSlug: params.organizationSlug,
    projectSlug: params.projectParam,
    environmentSlug: params.envParam,
  });
  let variables: readonly CoreEnvironmentVariable[];
  try {
    variables = await coreData<readonly CoreEnvironmentVariable[]>("environments.variables.list", {
      request,
      parameters: { environmentId: scope.environmentId },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Environment variables unavailable", { status: 503 });
  }
  return json({
    surface: "variables" as const,
    title: "Environment variables",
    description: "Clean Environment-owned values and redacted Credential references.",
    panel: {
      ok: true as const,
      data: {
        variables: variables.map((variable) => ({
          id: variable.id,
          key: variable.key,
          kind: variable.kind,
          value: variable.value,
          version: variable.version,
          updatedAt: variable.updatedAt,
          present: variable.value !== null || variable.hasSecret,
        })),
      },
    },
    provenance: "Canonical EnvironmentVariable and Credential metadata, redacted by the secrets context",
  });
}

export default function Variables(){const data=useLoaderData<typeof loader>();return <><M4Surface data={data}/><Outlet/></>;}
