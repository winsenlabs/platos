/**
 * PPR-32 — re-export shim for the canonical `<PlatosArtifact>` renderer.
 *
 * The renderer itself lives in `packages/react-hooks/src/components/
 * PlatosArtifact.tsx` (Theme F.8). Before PPR-32 this webapp file was a
 * byte-identical copy (F.9 inlined it to avoid adding a workspace edge),
 * which silently drifted the moment the package updated. We've taken
 * the `@platos/react-hooks` workspace edge (webapp already ships a
 * bundle large enough to absorb it) and this file is a one-line
 * re-export so there is exactly one copy of the component in the repo.
 *
 * Keep all rendering logic in the package. If the webapp needs webapp-
 * specific behavior, add a wrapper in this directory that composes
 * `<PlatosArtifact>` rather than forking it.
 */
export {
  PlatosArtifact,
  parseCsv,
  sanitizeSvg,
  type PlatosArtifactData,
  type PlatosArtifactKind,
  type PlatosArtifactProps,
} from "@platos/react-hooks";
