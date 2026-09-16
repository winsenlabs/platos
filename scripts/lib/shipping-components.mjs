// SPDX-License-Identifier: Apache-2.0
//
// shipping-components.mjs — what each shipping image's component set IS, decided
// once so the SBOM (scripts/audit-sbom.mjs) and the advisory scan
// (scripts/audit-advisory.mjs) cannot describe two different images.
//
//   webapp        the committed image inventory captured from its Docker
//                 production-deps stage. The caller supplies it; this module only
//                 names the derivation.
//   bundle-proven an image whose importer has an entry in REVIEWED_ABSENT
//                 (scripts/deploy-bundle-closure.mjs). Its Dockerfile runs that
//                 script's `check` on the deploy bundle, which FAILS THE IMAGE BUILD
//                 unless the bundle's external packages equal the importer's lock
//                 closure minus exactly those entries. The component set is that
//                 closure minus those entries: what the build proved ships.
//                 scripts/audit-sbom.test.mjs joins the REVIEWED_ABSENT keys to the
//                 Dockerfiles that actually run the check.
//   lock closure  every other image: the importer's production lock closure.

import { REVIEWED_ABSENT } from '../deploy-bundle-closure.mjs';
import { IMAGES, componentsFromSnapshots, computeClosure } from './pnpm-closure.mjs';

export const DERIVATIONS = Object.freeze({
  'docker-production-deps-image-inventory':
    'exact linux/amd64 Docker production-deps node_modules/.pnpm plus linked first-party workspace manifests, reverse-reconciled against the production lock closure and importer links',
  'deploy-bundle-closure-check':
    'pnpm-lock.yaml production closure minus the reviewed absences scripts/deploy-bundle-closure.mjs check proves against the deploy bundle inside the image build',
  'pnpm-lock-production-closure':
    'pnpm-lock.yaml production closure (dependencies+optionalDependencies, devDependencies excluded)',
});

/** The derivation key for one IMAGES entry. */
export function derivationOf(image) {
  if (!Object.hasOwn(IMAGES, image)) throw new Error(`unknown shipping image: ${image}`);
  if (image === 'webapp') return 'docker-production-deps-image-inventory';
  if (IMAGES[image].roots.every((root) => Object.hasOwn(REVIEWED_ABSENT, root))) return 'deploy-bundle-closure-check';
  return 'pnpm-lock-production-closure';
}

/** The component set of a lock-derived image (every image but webapp). */
export function lockDerivedComponents(parsed, image) {
  const derivation = derivationOf(image);
  if (derivation === 'docker-production-deps-image-inventory') {
    throw new Error(`${image} is derived from its committed image inventory, not the lockfile`);
  }
  const closure = componentsFromSnapshots(computeClosure(IMAGES[image].roots, parsed));
  if (derivation === 'pnpm-lock-production-closure') return closure;
  const absent = new Set(IMAGES[image].roots.flatMap((root) => REVIEWED_ABSENT[root]));
  return closure.filter((component) => !absent.has(`${component.name}@${component.version}`));
}
