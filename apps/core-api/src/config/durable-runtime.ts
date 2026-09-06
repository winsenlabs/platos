// The DURABLE RUNTIME section — the background execution service.
//
// ON THE NAME. ADR M0.3 §4 calls this port `DurableRuntime` and its adapter
// directory `packages/adapters/durable-runtime`, and every V1 surface follows
// that. The vendor's own product name is a token the repository vocabulary
// boundary (WIN-292) reserves, and `scripts/arch/boundary-rules.mjs` already
// writes its package scope through a character class for exactly this reason.
// This section is named after the PORT rather than after the vendor, which is
// also the more honest name: the port is what the platform depends on, and the
// service behind it is a supplier choice recorded in ADR M0.3 §7 decision 10.
//
// ONE GROUP, THREE VARIABLES, AND THE SECRET IS REQUIRED WITH THE ANCHOR. An
// endpoint with no key is the failure mode worth designing against: the process
// boots, the adapter is constructed, every dispatch is refused by the service as
// unauthenticated, and the symptom presents as "background work silently stopped
// happening" rather than as a configuration error. Pairing them in the group
// makes it a startup refusal that names the missing variable.
//
// WHAT IS NOT HERE. Nothing about WHICH work runs there. A schedule, a queue
// name or a concurrency limit is a property of the workload, and the `jobs`
// context owns those as rows. This section holds only what it takes to REACH the
// service, which is the part an install decides once.

import type { ConfigFieldSpec, ConfigSectionSpec } from "./schema.js";
import type { GroupPresence, SectionReader } from "./stores.js";

const apiUrl: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_DURABLE_RUNTIME_API_URL",
  kind: "url",
  required: false,
  defaultValue: null,
  // Not a secret. It is a hostname, it is the value an operator most needs
  // echoed back when a dispatch is going to the wrong install, and the key
  // beside it is where the sensitivity actually lives.
  secret: false,
  describe: "the durable execution service this process dispatches background work to",
  schemes: Object.freeze(["http:", "https:"]),
});

export const DURABLE_RUNTIME_SECTION: ConfigSectionSpec = Object.freeze({
  id: "durableRuntime",
  describe: "the durable execution service behind the DurableRuntime port",
  groups: Object.freeze([
    Object.freeze({
      id: "durableRuntime",
      describe: "the durable execution service",
      anchor: apiUrl,
      requiredWithAnchor: Object.freeze([
        Object.freeze({
          name: "PLATOS_DURABLE_RUNTIME_SECRET_KEY",
          kind: "string",
          required: false,
          defaultValue: null,
          secret: true,
          describe: "the key this process authenticates to the durable service with",
          minimumLength: 16,
        }),
      ]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_DURABLE_RUNTIME_NAMESPACE",
          kind: "string",
          required: false,
          // Two installs sharing one durable service is the ordinary shape for a
          // staging environment. Without a namespace they share a work queue,
          // and a staging dispatch executed against production data is not a bug
          // any test of either install would find.
          defaultValue: "platos",
          secret: false,
          describe: "the namespace that keeps two installs on one service apart",
          minimumLength: 1,
          pattern: "[a-z0-9][a-z0-9-]*",
          patternDescribe: "lower-case letters, digits and hyphens, starting with a letter or digit",
        }),
        Object.freeze({
          name: "PLATOS_DURABLE_RUNTIME_DISPATCH_TIMEOUT_MS",
          kind: "integer",
          required: false,
          // This bounds the DISPATCH — the call that hands work over — not the
          // work. A durable service exists precisely so the work can outlive
          // this process, so a timeout that bounded execution would be a
          // contradiction of the port's whole purpose.
          defaultValue: "15000",
          secret: false,
          describe: "how long handing work over may take before the dispatch is abandoned",
          minimum: 100,
          maximum: 120000,
        }),
      ]),
    }),
  ]),
});

export interface DurableRuntimeConfiguration {
  readonly apiUrl: string;
  readonly secretKey: string;
  readonly namespace: string;
  readonly dispatchTimeoutMs: number;
}

export interface DurableRuntimeSectionConfiguration {
  readonly durableRuntime: DurableRuntimeConfiguration | null;
}

export function assembleDurableRuntime(
  read: SectionReader,
  declared: GroupPresence,
): DurableRuntimeSectionConfiguration {
  return Object.freeze({
    durableRuntime: !declared("durableRuntime")
      ? null
      : Object.freeze({
          apiUrl: read("PLATOS_DURABLE_RUNTIME_API_URL") ?? "",
          secretKey: read("PLATOS_DURABLE_RUNTIME_SECRET_KEY") ?? "",
          namespace: read("PLATOS_DURABLE_RUNTIME_NAMESPACE") ?? "",
          dispatchTimeoutMs: Number(read("PLATOS_DURABLE_RUNTIME_DISPATCH_TIMEOUT_MS")),
        }),
  });
}
