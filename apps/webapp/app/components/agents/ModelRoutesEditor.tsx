/**
 * Per-agent model routing editor.
 *
 * Renders a list of named model routes (label → provider+model+key). Operators
 * can add, remove, and reorder routes, set a default, and label each one
 * (e.g. "alpha", "bravo", "fast", "smart").
 *
 * Emits a JSON-serialized array on the hidden input `name` prop so it can be
 * read by the parent form's action handler unchanged.
 *
 * Falls back gracefully: when `initialRoutes` is empty AND `legacyModel` is set,
 * seeds a single "default" route pre-filled with the legacy model so existing
 * agents don't lose their config on first open.
 */

import { PlusIcon, TrashIcon } from "@heroicons/react/20/solid";
import { useEffect, useState } from "react";
import type { ProviderForPicker } from "./ModelPicker";

export interface ModelRoute {
  label: string;
  model: string;
  providerKeyId?: string | null;
  isDefault: boolean;
}

export interface ProviderKeyForEditor {
  id: string;
  label: string;
  provider: string;
  envVarName: string;
}

interface Props {
  /** Hidden input name — receives the JSON-serialised routes array. */
  name: string;
  /** Current routes from the agent (empty for new agents). */
  initialRoutes?: ModelRoute[];
  /** Legacy single-model value — used to seed the first route when routes is empty. */
  legacyModel?: string;
  /** Legacy single providerKeyId — used to seed the first route. */
  legacyProviderKeyId?: string | null;
  providers: ProviderForPicker[];
  providerKeys: ProviderKeyForEditor[];
  providersPath: string;
}

const LABEL_RE = /^[a-z0-9_-]{1,32}$/;

function allModels(providers: ProviderForPicker[]): string[] {
  return providers.flatMap((p) => (p.envReady && p.enabled ? p.models : []));
}

function defaultLabel(routes: ModelRoute[]): string {
  // Suggest the next Greek letter not already in use
  const used = new Set(routes.map((r) => r.label));
  for (const l of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) {
    if (!used.has(l)) return l;
  }
  return `route-${routes.length + 1}`;
}

export function ModelRoutesEditor({
  name,
  initialRoutes,
  legacyModel,
  legacyProviderKeyId,
  providers,
  providerKeys,
  providersPath,
}: Props) {
  const models = allModels(providers);

  const seed = (): ModelRoute[] => {
    if (initialRoutes && initialRoutes.length > 0) return initialRoutes;
    if (legacyModel) {
      return [{ label: "default", model: legacyModel, providerKeyId: legacyProviderKeyId ?? null, isDefault: true }];
    }
    if (models.length > 0) {
      return [{ label: "default", model: models[0], providerKeyId: null, isDefault: true }];
    }
    return [];
  };

  const [routes, setRoutes] = useState<ModelRoute[]>(seed);
  const [errors, setErrors] = useState<Record<number, string>>({});

  // Keep exactly one default at all times.
  const ensureOneDefault = (rs: ModelRoute[]): ModelRoute[] => {
    const hasDefault = rs.some((r) => r.isDefault);
    if (hasDefault || rs.length === 0) return rs;
    return rs.map((r, i) => (i === 0 ? { ...r, isDefault: true } : r));
  };

  const update = (next: ModelRoute[]) => setRoutes(ensureOneDefault(next));

  const addRoute = () => {
    const label = defaultLabel(routes);
    update([...routes, { label, model: models[0] ?? "", providerKeyId: null, isDefault: routes.length === 0 }]);
  };

  const removeRoute = (i: number) => {
    const next = routes.filter((_, idx) => idx !== i);
    setErrors((prev) => { const e = { ...prev }; delete e[i]; return e; });
    update(next);
  };

  const patchRoute = (i: number, patch: Partial<ModelRoute>) => {
    update(routes.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const setDefault = (i: number) => {
    update(routes.map((r, idx) => ({ ...r, isDefault: idx === i })));
  };

  const validate = () => {
    const errs: Record<number, string> = {};
    const labels = new Set<string>();
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      if (!LABEL_RE.test(r.label)) {
        errs[i] = "Label must be 1–32 lowercase letters, numbers, _ or -.";
      } else if (labels.has(r.label)) {
        errs[i] = "Duplicate label.";
      } else {
        labels.add(r.label);
      }
      if (!r.model) errs[i] = (errs[i] ? errs[i] + " " : "") + "Model required.";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  useEffect(() => {
    if (Object.keys(errors).length > 0) validate();
  }, [routes]);

  const keysForProvider = (modelStr: string) => {
    const provider = modelStr.split(":")[0] ?? "";
    return providerKeys.filter((k) => k.provider === provider);
  };

  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-sm text-amber-400">
          No models available — link at least one provider on the{" "}
          <a href={providersPath} className="underline">Providers page</a>.
        </p>
        <input type="hidden" name={name} value="[]" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {routes.map((route, i) => {
        const provKeys = keysForProvider(route.model);
        return (
          <div
            key={i}
            className={`rounded-lg border ${route.isDefault ? "border-emerald-500/50 bg-emerald-500/5" : "border-charcoal-700 bg-charcoal-800/40"} p-3 space-y-2`}
          >
            <div className="flex items-center gap-2">
              {/* Default radio */}
              <button
                type="button"
                title={route.isDefault ? "Default route" : "Set as default"}
                onClick={() => setDefault(i)}
                className={`shrink-0 h-4 w-4 rounded-full border-2 transition-colors ${
                  route.isDefault
                    ? "border-emerald-400 bg-emerald-400"
                    : "border-charcoal-500 hover:border-emerald-500"
                }`}
              />
              {/* Label */}
              <input
                type="text"
                placeholder="label (e.g. alpha)"
                value={route.label}
                onChange={(e) => patchRoute(i, { label: e.target.value.toLowerCase() })}
                className="w-32 rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 text-xs font-mono text-text-bright"
              />
              <span className="text-xs text-text-dimmed">→</span>
              {/* Model */}
              <select
                value={route.model}
                onChange={(e) => patchRoute(i, { model: e.target.value, providerKeyId: null })}
                className="flex-1 rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
              >
                {providers.map((p) =>
                  p.envReady && p.enabled && p.models.length > 0 ? (
                    <optgroup key={p.id} label={p.displayName}>
                      {p.models.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </optgroup>
                  ) : null,
                )}
              </select>
              {/* Remove */}
              {routes.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRoute(i)}
                  className="shrink-0 text-charcoal-500 hover:text-red-400 transition-colors"
                >
                  <TrashIcon className="size-4" />
                </button>
              )}
            </div>

            {/* Provider key (optional) */}
            {provKeys.length > 0 && (
              <div className="flex items-center gap-2 pl-6">
                <span className="text-xs text-text-dimmed w-20 shrink-0">API key:</span>
                <select
                  value={route.providerKeyId ?? ""}
                  onChange={(e) => patchRoute(i, { providerKeyId: e.target.value || null })}
                  className="flex-1 rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
                >
                  <option value="">Scope default</option>
                  {provKeys.map((k) => (
                    <option key={k.id} value={k.id}>{k.label}</option>
                  ))}
                </select>
              </div>
            )}

            {errors[i] && (
              <p className="pl-6 text-xs text-red-400">{errors[i]}</p>
            )}

            {route.isDefault && (
              <p className="pl-6 text-[11px] text-emerald-400/70">Default — used when no label is specified</p>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addRoute}
        className="flex items-center gap-1.5 text-xs text-text-dimmed hover:text-text-bright transition-colors"
      >
        <PlusIcon className="size-4" /> Add model route
      </button>

      {/* Hidden input carries the serialised routes to the form action */}
      <input type="hidden" name={name} value={JSON.stringify(routes)} />
    </div>
  );
}
