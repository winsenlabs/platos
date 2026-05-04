---
"@platos/react-hooks": patch
---

Theme F.8 — add `<PlatosArtifact>` renderer component. Renders any canonical Platos artifact kind (`markdown`, `code`, `html`, `json`, `csv`, `svg`, `image`) consistently with a self-contained dependency-free implementation. HTML artifacts always render in a sandboxed iframe with a strict CSP (no `allow-same-origin`). SVG artifacts are sanitized (strip `<script>`, `on*=`, `javascript:` URIs, `<foreignObject>`) before inline insertion. Unknown kinds show a safe fallback — never throw. Optional `onRevise` prop exposes an inline editor for `revise_artifact` wiring. New exports: `PlatosArtifact`, `PlatosArtifactProps`, `PlatosArtifactData`, `PlatosArtifactKind`, plus `parseCsv` + `sanitizeSvg` helpers.
