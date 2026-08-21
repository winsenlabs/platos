import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { Page } from "~/components/platos/DashboardShell";
import { asArray, asRecord, asString } from "~/components/platos/safe";
import { requireEnvironmentScope } from "~/services/auth.server";
import { credentialErrorMessage, credentialPanel, credentialRequest } from "~/services/platosAgent.server";

async function environmentScope(args: LoaderFunctionArgs | ActionFunctionArgs, access?: "metadata" | "secret:mutate") {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) {
    throw new Response("Invalid scope", { status: 400 });
  }
  return requireEnvironmentScope({
    request: args.request,
    organizationSlug,
    projectSlug,
    environmentSlug,
    ...(access ? { access } : {}),
  });
}

export async function loader(args: LoaderFunctionArgs) {
  const { scope } = await environmentScope(args, "metadata");
  return json({ panel: await credentialPanel("/api/v1/agent/access-key", scope) });
}

export async function action(args: ActionFunctionArgs) {
  const { scope } = await environmentScope(args, "secret:mutate");
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  const submittedFields = [...form.keys()];

  try {
    if (intent === "rotate") {
      if (submittedFields.some((field) => !["intent", "keyHash", "keyPrefix"].includes(field))) {
        return json({ ok: false, error: "Raw key material is not accepted" }, { status: 400 });
      }
      const keyHash = String(form.get("keyHash") ?? "");
      const keyPrefix = String(form.get("keyPrefix") ?? "");
      if (!/^[a-f0-9]{64}$/.test(keyHash) || !/^platos_live_[A-Za-z0-9_-]{1,12}$/.test(keyPrefix)) {
        return json({ ok: false, error: "Invalid generated key metadata" }, { status: 400 });
      }
      const result = await credentialRequest("/api/v1/agent/access-key", scope, {
        method: "POST",
        body: { keyHash, keyPrefix },
      });
      return json({ ok: true, result });
    }

    if (intent === "origins") {
      const origins = String(form.get("origins") ?? "")
        .split(/\r?\n/)
        .map((origin) => origin.trim())
        .filter(Boolean);
      const result = await credentialRequest("/api/v1/agent/access-key/origins", scope, {
        method: "POST",
        body: { origins },
      });
      return json({ ok: true, result });
    }

    if (intent === "revoke") {
      const result = await credentialRequest("/api/v1/agent/access-key", scope, { method: "DELETE" });
      return json({ ok: true, result });
    }

    return json({ ok: false, error: "Unsupported operation" }, { status: 400 });
  } catch (error) {
    return json({ ok: false, error: credentialErrorMessage(error, "API key operation") }, { status: 400 });
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function generateAccessKey(): Promise<{ rawKey: string; keyHash: string; keyPrefix: string }> {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  const rawKey = `platos_live_${base64Url(secret)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  const keyHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { rawKey, keyHash, keyPrefix: rawKey.slice(0, 24) };
}

export default function ApiKeysRoute() {
  const { panel } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const accessKeys = panel.ok ? asRecord(panel.data) : {};
  const metadata = asRecord(accessKeys.key);
  const retiringKey = asRecord(accessKeys.retiringKey);
  const origins = asArray(metadata.allowedOrigins).filter((value): value is string => typeof value === "string");
  const active = typeof metadata.id === "string";
  const busy = fetcher.state !== "idle" || generating;

  async function rotate() {
    setGenerating(true);
    try {
      const generated = await generateAccessKey();
      setRevealedKey(generated.rawKey);
      fetcher.submit(
        { intent: "rotate", keyHash: generated.keyHash, keyPrefix: generated.keyPrefix },
        { method: "post" },
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Page>
      <header className="mb-6">
        <div className="text-xs uppercase tracking-widest text-text-dimmed">Platos / Security</div>
        <h1 className="mt-1 text-2xl font-semibold">Environment API key</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-dimmed">
          The browser generates the bearer with Web Crypto. Platos receives only its SHA-256 hash and display prefix.
        </p>
      </header>

      {!panel.ok ? (
        <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4 text-sm text-red-200">
          {panel.error.message} <code className="ml-2 text-xs">{panel.error.code}</code>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
          <section className="rounded-lg border border-grid-bright bg-background-bright p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">Hash-only credential</h2>
                <p className="mt-1 text-sm text-text-dimmed">
                  Prefix: <code>{asString(metadata.keyPrefix, "No active key")}</code>
                </p>
                <p className="mt-1 text-xs text-text-dimmed">Created {asString(metadata.createdAt, "—")}</p>
                <p className="mt-1 text-xs text-text-dimmed">
                  Prior key {asString(retiringKey.keyPrefix, "none")} · overlap ends {asString(retiringKey.validUntil, "not rotating")}
                </p>
              </div>
              <span className="rounded-full bg-green-500/15 px-2 py-1 text-xs text-green-300">
                {active ? "Active" : "Not configured"}
              </span>
            </div>

            {revealedKey && (
              <div className="mt-5 rounded-lg border border-amber-400/50 bg-amber-950/20 p-4">
                <div className="text-sm font-semibold text-amber-200">Copy this key now</div>
                <p className="mt-1 text-xs text-amber-100/80">It exists only in this browser tab and cannot be retrieved again.</p>
                <code className="mt-3 block break-all rounded bg-charcoal-950 p-3 text-sm text-amber-100">{revealedKey}</code>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="rounded bg-amber-300 px-3 py-2 text-xs font-medium text-black" onClick={() => navigator.clipboard.writeText(revealedKey)}>Copy</button>
                  <button type="button" className="rounded border border-amber-300/40 px-3 py-2 text-xs" onClick={() => setRevealedKey(null)}>I saved it</button>
                </div>
              </div>
            )}

            <div className="mt-5 flex gap-2">
              <button type="button" disabled={busy} onClick={rotate} className="rounded bg-indigo-500 px-4 py-2 text-sm text-white disabled:opacity-50">
                {active ? "Rotate key" : "Generate key"}
              </button>
              {active && (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="revoke" />
                  <button disabled={busy} className="rounded border border-red-500/50 px-4 py-2 text-sm text-red-200 disabled:opacity-50">Revoke</button>
                </fetcher.Form>
              )}
            </div>
            {fetcher.data && fetcher.data.ok === false && <p className="mt-3 text-sm text-red-300">{asString(asRecord(fetcher.data).error, "API key operation failed")}</p>}
          </section>

          <fetcher.Form method="post" className="rounded-lg border border-grid-bright bg-background-bright p-5">
            <input type="hidden" name="intent" value="origins" />
            <h2 className="font-semibold">Allowed browser origins</h2>
            <p className="mt-1 text-xs text-text-dimmed">One exact HTTPS origin per line. Origin checks apply after key verification.</p>
            <textarea name="origins" defaultValue={origins.join("\n")} className="mt-4 min-h-44 w-full rounded border border-grid-bright bg-charcoal-950 p-3 font-mono text-xs" placeholder="https://app.example.com" />
            <button disabled={busy} className="mt-3 rounded border border-grid-bright px-3 py-2 text-sm disabled:opacity-50">Save origins</button>
          </fetcher.Form>
        </div>
      )}
    </Page>
  );
}
