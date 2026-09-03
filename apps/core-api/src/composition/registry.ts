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

import { ADAPTER_BINDINGS, type AdapterName, type SuppliedAdapters } from "./adapter-bindings.js";

export interface AdapterSupplyReport {
  readonly satisfied: readonly AdapterName[];
  readonly unsatisfied: readonly AdapterName[];
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
  const declared = new Set<string>(ADAPTER_BINDINGS.map((binding) => binding.adapter));
  const satisfied: AdapterName[] = [];
  const unsatisfied: AdapterName[] = [];
  const faults: string[] = [];

  for (const key of Object.keys(supplied)) {
    if (!declared.has(key)) {
      faults.push(`adapter "${key}" is supplied but is not one of the ${declared.size} declared bindings`);
    }
  }

  for (const binding of ADAPTER_BINDINGS) {
    const instance = supplied[binding.adapter];
    if (instance === undefined) {
      unsatisfied.push(binding.adapter);
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
    satisfied.push(binding.adapter);
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
