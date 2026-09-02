// In-memory doubles for this context's ports, and for the kernel `ErasureTarget`
// it consumes.
//
// Published from `application/testing/` rather than hidden in a test file so a
// composition root can smoke-test its wiring, and so a future context that
// implements `ErasureTarget` can check its own implementation against the same
// orchestrator that will drive it in production. Framework-free, like everything
// else under `application/`.
export * from "./in-memory-privacy-repository.js";
export * from "./in-memory-erasure-target.js";
export * from "./fixtures.js";
