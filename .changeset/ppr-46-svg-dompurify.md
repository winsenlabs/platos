---
"@platos/react-hooks": patch
---

PPR-46 — `<PlatosArtifact>` SVG sanitization now runs through `isomorphic-dompurify` with the SVG profile on top of the existing cheap regex pre-checks. Defense-in-depth pairs with the agent-side `validateSvgContent` which rejects at write time anything the renderer would strip at read time.
