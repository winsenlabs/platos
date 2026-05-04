---
"@platos/react-hooks": patch
---

Apply the same `import * as React from "react"` + named hook imports fix to `createContextAndHook.ts` that was applied to `PlatosArtifact.tsx`. The shared CJS/ESM default-export interop hazard would crash any consumer using context hooks the moment a Remix prod bundle returned `null` for the React module's default export. Behavior unchanged when the import resolves correctly (the common case).
