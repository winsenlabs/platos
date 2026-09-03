// The `providers` domain (ADR M0.3 §1, context 4).
//
// Four aggregates and one boundary.
//
//   ProviderKey          an environment's NAMED LINK from a provider to a
//                        credential. Holds no secret; the material is `secrets`'.
//   EnvironmentProvider  whether an environment has adopted a provider, and
//                        whether that adoption is switched on.
//   Model                a GLOBAL model identity. Not tenant-scoped: what a
//                        model is does not vary by environment.
//   ModelPrice           an APPEND-ONLY, effective-dated four-rate card, at the
//                        `Decimal(24, 12)` USD-per-token scale the kernel's
//                        `Money` note hands to this context by name.
//
// The boundary is the provider itself. This context is the sole holder of every
// provider SDK, behind the `ModelRouter` port it owns (§1 row 4, §13), and it
// absorbs `provider-health.service` out of `auth` — the physical move that
// erases the `auth → providers` wrong-way edge in §3.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./errors.js";
export * from "./policy.js";
export * from "./manifest.js";
export * from "./catalogue.js";
export * from "./route.js";
export * from "./provider-key.js";
export * from "./provider-link.js";
export * from "./health.js";
export * from "./model.js";
export * from "./model-key.js";
export * from "./rate.js";
export * from "./price-card.js";
export * from "./token-usage.js";
export * from "./cost.js";
export * from "./rate-card-import.js";
