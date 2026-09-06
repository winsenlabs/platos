// Validating what an install actually wired, before it serves anything.
//
// The composition root's failure mode is not "an adapter is missing" — that is
// visible. It is "an adapter is in the wrong slot", which type-checks whenever
// two adapters share a port shape (`notifier-email` and `notifier-webhook` both
// implement `Notifier`) and then silently sends every cost alert down the wrong
// channel. Every adapter interface carries a literal `adapterName`, so the slot
// and its occupant can be compared at run time, and they are.
//
// FAIL CLOSED, BUT AT THE RIGHT MOMENT. A mis-wire is a startup failure: it can
// only be a programming error and no amount of waiting fixes it. A MISSING
// binding is not — at M2.1b every binding is missing because no adapter has an
// implementation yet — so it degrades readiness instead, and the process stays
// alive and honest about what it cannot do.

import {
  ADAPTER_BINDINGS,
  type AdapterBinding,
  type AdapterName,
  type SuppliedAdapters,
} from "./adapter-bindings.js";

/**
 * `<adapter>:<Port>` — one per BINDING, not per directory.
 *
 * WIN-258 T2 (ADR M0.3 §15). This report used to be a list of directory names,
 * which was the same list either way while every directory had exactly one
 * port. It is not any more: `postgres-tenancy` satisfies two, so a
 * directory-named report would list it TWICE, and `describeAdapterSupply` would
 * say "13/13 satisfied" while twelve objects were wired. Reporting the binding
 * rather than the directory keeps the count truthful and tells an operator WHICH
 * port is missing rather than only which package is.
 */
export type BindingKey = `${AdapterName}:${string}`;

export function bindingKey(binding: AdapterBinding): BindingKey {
  return `${binding.adapter}:${binding.port}`;
}

export interface AdapterSupplyReport {
  readonly satisfied: readonly BindingKey[];
  readonly unsatisfied: readonly BindingKey[];
  /** Programming errors. A non-empty list must prevent the process starting. */
  readonly faults: readonly string[];
}

/** Anything an adapter package publishes carries its own directory name. */
function declaredName(instance: unknown): string | null {
  if (typeof instance !== "object" || instance === null) return null;
  const value = (instance as { readonly adapterName?: unknown }).adapterName;
  return typeof value === "string" ? value : null;
}

export function reportAdapterSupply(supplied: SuppliedAdapters): AdapterSupplyReport {
  // The DIRECTORIES an install may wire, de-duplicated: a two-port directory is
  // one object, supplied once, and a caller that supplied it twice would be
  // supplying the same key twice, which is not representable.
  const declared = new Set<string>(ADAPTER_BINDINGS.map((binding) => binding.adapter));
  const satisfied: BindingKey[] = [];
  const unsatisfied: BindingKey[] = [];
  const faults: string[] = [];

  for (const key of Object.keys(supplied)) {
    if (!declared.has(key)) {
      faults.push(`adapter "${key}" is supplied but is not one of the ${declared.size} declared adapters`);
    }
  }

  for (const binding of ADAPTER_BINDINGS) {
    const instance = supplied[binding.adapter];
    if (instance === undefined) {
      unsatisfied.push(bindingKey(binding));
      continue;
    }
    const name = declaredName(instance);
    if (name === null) {
      faults.push(`adapter "${binding.adapter}" is supplied without an adapterName and cannot be identified`);
      continue;
    }
    if (name !== binding.adapter) {
      faults.push(`adapter slot "${binding.adapter}" holds "${name}" — the ${binding.port} binding is mis-wired`);
      continue;
    }
    // A directory that satisfies two ports satisfies BOTH bindings with one
    // object, and both are reported — which is the honest answer, because both
    // ports are now served.
    satisfied.push(bindingKey(binding));
  }

  return {
    satisfied: Object.freeze(satisfied),
    unsatisfied: Object.freeze(unsatisfied),
    faults: Object.freeze(faults),
  };
}

/** The one-line summary the startup and readiness logs both use. */
export function describeAdapterSupply(report: AdapterSupplyReport): string {
  return `${report.satisfied.length}/${ADAPTER_BINDINGS.length} adapter bindings satisfied`;
}
