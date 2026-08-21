import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page } from "~/components/platos/DashboardShell";
import { asArray, asBoolean, asRecord, asString, firstArray, stableJson } from "~/components/platos/safe";
import { requireEnvironmentScope } from "~/services/auth.server";
import { credentialErrorMessage, credentialPanel, credentialRequest } from "~/services/platosAgent.server";

async function scoped(args: LoaderFunctionArgs | ActionFunctionArgs, access: "metadata" | "secret:mutate") {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) throw new Response("Invalid scope", { status: 400 });
  return requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug, access });
}

export async function loader(args: LoaderFunctionArgs) {
  const { scope } = await scoped(args, "metadata");
  const [providers, keys, models] = await Promise.all([
    credentialPanel("/api/v1/agent/providers", scope),
    credentialPanel("/api/v1/agent/providers/keys", scope),
    credentialPanel("/api/v1/agent/providers/models", scope),
  ]);
  return json({ providers, keys, models });
}

function safeProvider(value: FormDataEntryValue | null): string {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,48}$/.test(provider)) throw new Error("Invalid provider");
  return provider;
}

function safeId(value: FormDataEntryValue | null): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid key id");
  return id;
}

export async function action(args: ActionFunctionArgs) {
  const { scope } = await scoped(args, "secret:mutate");
  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");
  if ([...form.keys()].some((key) => /secret|apiKey|rawKey|credentialValue/i.test(key))) {
    return json({ ok: false, error: "Provider key material is not accepted by this route" }, { status: 400 });
  }

  try {
    let result: unknown;
    if (intent === "create-key") {
      result = await credentialRequest("/api/v1/agent/providers/keys", scope, {
        method: "POST",
        body: {
          provider: safeProvider(form.get("provider")),
          label: String(form.get("label") ?? "").trim(),
          envVarName: String(form.get("envVarName") ?? "").trim(),
          isDefault: form.get("isDefault") === "on",
        },
      });
    } else if (intent === "create-secret") {
      const plaintext = String(form.get("plaintext") ?? "");
      if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid provider secret");
      result = await credentialRequest("/api/v1/agent/providers/keys/byok", scope, {
        method: "POST",
        body: {
          provider: safeProvider(form.get("provider")),
          label: String(form.get("label") ?? "").trim(),
          envVarName: String(form.get("envVarName") ?? "").trim(),
          plaintext,
          isDefault: form.get("isDefault") === "on",
        },
      });
    } else if (intent === "rotate-secret") {
      const plaintext = String(form.get("plaintext") ?? "");
      if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid provider secret");
      result = await credentialRequest(
        `/api/v1/agent/providers/keys/${encodeURIComponent(safeId(form.get("keyId")))}/rotate-secret`,
        scope,
        { method: "POST", body: { plaintext } },
      );
    } else if (intent === "default-key") {
      result = await credentialRequest(`/api/v1/agent/providers/keys/${encodeURIComponent(safeId(form.get("keyId")))}`, scope, {
        method: "PATCH",
        body: { isDefault: true },
      });
    } else if (intent === "delete-key") {
      result = await credentialRequest(`/api/v1/agent/providers/keys/${encodeURIComponent(safeId(form.get("keyId")))}`, scope, { method: "DELETE" });
    } else if (intent === "probe") {
      result = await credentialRequest(`/api/v1/agent/providers/${encodeURIComponent(safeProvider(form.get("provider")))}/health`, scope);
    } else if (intent === "link" || intent === "unlink") {
      result = await credentialRequest(`/api/v1/agent/providers/${encodeURIComponent(safeProvider(form.get("provider")))}/link`, scope, { method: intent === "link" ? "POST" : "DELETE" });
    } else if (intent === "toggle") {
      result = await credentialRequest(`/api/v1/agent/providers/${encodeURIComponent(safeProvider(form.get("provider")))}`, scope, {
        method: "PATCH",
        body: { enabled: form.get("enabled") === "true" },
      });
    } else {
      return json({ ok: false, error: "Unsupported provider operation" }, { status: 400 });
    }
    return json({ ok: true, result });
  } catch (error) {
    return json({ ok: false, error: credentialErrorMessage(error, "Provider operation") }, { status: 400 });
  }
}

function Failure({ panel }: { panel: { ok: false; error: { code: string; message: string } } }) {
  return <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4 text-sm text-red-200">{panel.error.message} <code className="ml-2 text-xs">{panel.error.code}</code></div>;
}

export default function ProvidersRoute() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const providerRows = data.providers.ok ? firstArray(asRecord(data.providers.data), "providers", "items") : [];
  const keyRows = data.keys.ok ? firstArray(asRecord(data.keys.data), "keys", "items") : [];
  const models = data.models.ok ? data.models.data : null;
  const busy = fetcher.state !== "idle";

  return (
    <Page>
      <header className="mb-6">
        <div className="text-xs uppercase tracking-widest text-text-dimmed">Platos / Models</div>
        <h1 className="mt-1 text-2xl font-semibold">Providers and model routes</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-dimmed">Credential-backed readiness, explicit probe models, strict route arrays, and reserved compaction resolution.</p>
      </header>

      {!data.providers.ok ? <Failure panel={data.providers} /> : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providerRows.map((value, index) => {
            const provider = asRecord(value);
            const id = asString(provider.provider, asString(provider.id, asString(provider.name, `provider-${index + 1}`)));
            const linked = asBoolean(provider.linked) || asBoolean(provider.enabled);
            return (
              <article key={id} className="rounded-lg border border-grid-bright bg-background-bright p-4">
                <div className="flex items-center justify-between"><h2 className="font-semibold">{id}</h2><span className={`rounded-full px-2 py-1 text-xs ${asBoolean(provider.envReady) ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-200"}`}>{asBoolean(provider.envReady) ? "Credential ready" : "Credential required"}</span></div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><dt className="text-text-dimmed">Probe model</dt><dd className="mt-1 font-mono">{asString(provider.probeModel, "catalog default")}</dd></div><div><dt className="text-text-dimmed">State</dt><dd className="mt-1">{linked ? "Linked" : "Not linked"}</dd></div></dl>
                <fetcher.Form method="post" className="mt-4 flex flex-wrap gap-2">
                  <input type="hidden" name="provider" value={id} />
                  <button name="intent" value="probe" disabled={busy} className="rounded border border-grid-bright px-2 py-1 text-xs">Run live probe</button>
                  <button name="intent" value={linked ? "unlink" : "link"} disabled={busy} className="rounded border border-grid-bright px-2 py-1 text-xs">{linked ? "Unlink" : "Link"}</button>
                  {linked && <button name="intent" value="toggle" disabled={busy} className="rounded border border-grid-bright px-2 py-1 text-xs"><input type="hidden" name="enabled" value={asBoolean(provider.enabled) ? "false" : "true"} />{asBoolean(provider.enabled) ? "Disable" : "Enable"}</button>}
                </fetcher.Form>
              </article>
            );
          })}
        </section>
      )}

      <div className="mt-6 grid gap-5 xl:grid-cols-[1fr_24rem]">
        <section>
          <h2 className="mb-3 font-semibold">Credential references</h2>
          {!data.keys.ok ? <Failure panel={data.keys} /> : (
            <div className="overflow-x-auto rounded-lg border border-grid-bright">
              <table className="w-full text-left text-sm"><thead className="bg-background-bright text-xs uppercase text-text-dimmed"><tr><th className="px-3 py-2">Provider</th><th className="px-3 py-2">Label</th><th className="px-3 py-2">Credential name</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Actions</th></tr></thead><tbody>{keyRows.map((value, index) => { const key = asRecord(value); const id = asString(key.id, `key-${index}`); return <tr key={id} className="border-t border-grid-bright"><td className="px-3 py-2">{asString(key.provider)}</td><td className="px-3 py-2">{asString(key.label)}</td><td className="px-3 py-2 font-mono text-xs">{asString(key.environmentKeyName, asString(key.envVarName))}</td><td className="px-3 py-2">{asBoolean(key.isDefault) ? "Default" : "Available"}</td><td className="px-3 py-2"><fetcher.Form method="post" className="flex gap-2"><input type="hidden" name="keyId" value={id} />{!asBoolean(key.isDefault) && <button name="intent" value="default-key" className="text-xs text-indigo-300">Make default</button>}<button name="intent" value="delete-key" className="text-xs text-red-300">Delete</button></fetcher.Form></td></tr>; })}</tbody></table>
            </div>
          )}
        </section>

        <fetcher.Form method="post" className="rounded-lg border border-grid-bright bg-background-bright p-4">
          <input type="hidden" name="intent" value="create-key" />
          <h2 className="font-semibold">Link a stored credential</h2>
          <p className="mt-1 text-xs text-text-dimmed">Enter a same-Environment Credential name. Secret material is created and rotated in the Environment credential store, never here.</p>
          <label className="mt-4 block text-xs">Provider<input required name="provider" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2" placeholder="anthropic" /></label>
          <label className="mt-3 block text-xs">Label<input required name="label" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2" placeholder="Primary" /></label>
          <label className="mt-3 block text-xs">Credential reference<input required name="envVarName" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 font-mono" placeholder="ANTHROPIC_API_KEY" /></label>
          <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="isDefault" /> Default for this provider</label>
          <button disabled={busy} className="mt-4 rounded bg-indigo-500 px-3 py-2 text-sm text-white">Link credential</button>
        </fetcher.Form>

        <fetcher.Form method="post" className="rounded-lg border border-grid-bright bg-background-bright p-4">
          <input type="hidden" name="intent" value="create-secret" />
          <h2 className="font-semibold">Create a BYOK credential</h2>
          <p className="mt-1 text-xs text-text-dimmed">The secret is encrypted by the Platos Environment credential store and is never returned in provider payloads.</p>
          <label className="mt-4 block text-xs">Provider<input required name="provider" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2" placeholder="anthropic" /></label>
          <label className="mt-3 block text-xs">Label<input required name="label" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2" placeholder="Primary" /></label>
          <label className="mt-3 block text-xs">Credential name<input required name="envVarName" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 font-mono" placeholder="ANTHROPIC_API_KEY" /></label>
          <label className="mt-3 block text-xs">Provider secret<input required type="password" autoComplete="new-password" name="plaintext" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 font-mono" /></label>
          <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="isDefault" /> Default for this provider</label>
          <button disabled={busy} className="mt-4 rounded bg-indigo-500 px-3 py-2 text-sm text-white">Encrypt and link credential</button>
        </fetcher.Form>

        <fetcher.Form method="post" className="rounded-lg border border-grid-bright bg-background-bright p-4">
          <input type="hidden" name="intent" value="rotate-secret" />
          <h2 className="font-semibold">Rotate a BYOK credential</h2>
          <p className="mt-1 text-xs text-text-dimmed">Rotation replaces the encrypted active version; no reveal response is produced.</p>
          <label className="mt-4 block text-xs">ProviderKey ID<input required name="keyId" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 font-mono" /></label>
          <label className="mt-3 block text-xs">Replacement secret<input required type="password" autoComplete="new-password" name="plaintext" className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 font-mono" /></label>
          <button disabled={busy} className="mt-4 rounded border border-grid-bright px-3 py-2 text-sm">Rotate encrypted credential</button>
        </fetcher.Form>
      </div>

      {fetcher.data && <pre className={`mt-5 overflow-auto rounded border p-3 text-xs ${fetcher.data.ok ? "border-grid-bright" : "border-red-500/40 text-red-300"}`}>{stableJson(fetcher.data)}</pre>}
      <details className="mt-5 text-xs text-text-dimmed"><summary>Available model catalogue</summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-charcoal-950 p-3">{stableJson(models)}</pre></details>
    </Page>
  );
}
