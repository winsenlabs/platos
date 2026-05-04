// `std-env` is an ESM-only package (v3+), so a plain top-level
// `import` here blocks tshy's CJS dialect tsc pass (TS1479).
// `process.env` is the same source `std-env.env` reads — using it
// directly keeps this file dual-dialect safe.
export function isKubernetesEnvironment(override?: boolean): boolean {
  if (override !== undefined) {
    return override;
  }

  const env = process.env;
  const k8sIndicators = [
    env["KUBERNETES_PORT"],
    env["KUBERNETES_SERVICE_HOST"],
    env["KUBERNETES_SERVICE_PORT"],
  ];

  console.debug("k8sIndicators", { k8sIndicators });

  return k8sIndicators.some(Boolean);
}
