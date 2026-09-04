// The `channels` application layer.
//
// Use cases, one per file, each a plain function over a frozen dependency
// bundle. There is no service class and no framework: a use case is invokable in
// memory against the in-memory doubles in `application/testing/`, and every one
// of them returns the kernel's `Result` rather than throwing.
//
// May import this context's `domain/`, its own `application/ports/`, its own
// `contracts/`, and the published `contracts/` of the peer contexts ADR M0.3 §1
// permits — which for `channels` is `tenancy` and `identity-access`. It may NOT
// import `conversations` in either direction (§3); the inbound and outbound
// seams are the kernel's `DurableRuntime` and `EventBus`.
export * from "./ports/index.js";
export * from "./dependencies.js";
export * from "./views.js";
export * from "./admit-channel-event.js";
export * from "./process-channel-event.js";
export * from "./dispatch-inbound-turn.js";
export * from "./configure-agent-routing.js";
export * from "./rotate-installation-credential.js";
export * from "./deliver-outbound-message.js";
export * from "./channels-erasure-target.js";
export * from "./channels-contract.js";
