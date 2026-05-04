---
"@platos/react-hooks": patch
---

Fix intermittent `Cannot read properties of null (reading 'useState')` crash in `<PlatosArtifact>` during agent responses. Switched from `import React from "react"` + `React.useState(...)` to named hook imports (`import { useState, useEffect } from "react"`) to avoid the CJS/ESM default-export interop edge case in some Remix production bundles. Behavior unchanged.
