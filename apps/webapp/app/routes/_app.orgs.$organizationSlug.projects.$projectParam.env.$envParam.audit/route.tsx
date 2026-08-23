import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { loadSurface, type SurfaceConfig } from "~/services/m4Route.server";

const safe = (value: string | null, pattern: RegExp, fallback: string) => value && pattern.test(value) ? value : fallback;
const config: SurfaceConfig = {
  surface: "audit" as const,
  title: "Audit log",
  description: "Immutable Tool Call dispatch, provider outcome and scope identity from the canonical audit store.",
  endpoint: (_params, url) => {
    const query = new URLSearchParams();
    query.set("limit", safe(url.searchParams.get("limit"), /^(?:[1-9]\d?|1\d\d|200)$/, "100"));
    query.set("offset", safe(url.searchParams.get("offset"), /^\d{1,6}$/, "0"));
    query.set("sinceDays", safe(url.searchParams.get("sinceDays"), /^(?:[1-9]|[1-8]\d|90)$/, "30"));
    for (const key of ["agentId", "threadId", "entityId", "toolName", "status"] as const) {
      const value = url.searchParams.get(key);
      if (value && /^[A-Za-z0-9_.:-]{1,100}$/.test(value)) query.set(key, value);
    }
    return `/api/v1/agent/monitoring/tool-audit?${query}`;
  },
  provenance: "Canonical scoped Tool audit rows; newest first",
};
export async function loader(args: LoaderFunctionArgs) { return loadSurface(args, config); }
export default function AuditRoute() { return <M4Surface data={useLoaderData<typeof loader>()} />; }
