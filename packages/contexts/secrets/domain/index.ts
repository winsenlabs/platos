// The `secrets` domain: the credential vault and the encryption boundary
// (ADR M0.3 §1, context 3).
//
// Pure. It imports its own domain files and `@platos/kernel`, and nothing else —
// no framework, no vendor client, and no cryptographic library. The domain states
// what an envelope IS, when a key may seal or open one, and when a version dies.
// The bytes are produced behind `application/ports`, which is what makes every
// rule here exercisable in memory.
export * from "./access-rules.js";
export * from "./audit.js";
export * from "./authorization.js";
export * from "./credential.js";
export * from "./envelope.js";
export * from "./environment-variable.js";
export * from "./errors.js";
export * from "./ids.js";
export * from "./key-ring.js";
export * from "./legacy-envelope.js";
export * from "./metadata.js";
export * from "./secret-material.js";
export * from "./secret-version.js";
