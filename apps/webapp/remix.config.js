/** @type {import('@remix-run/dev').AppConfig} */
module.exports = {
  dev: {
    port: 8002,
  },
  tailwind: true,
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*"],
  serverModuleFormat: "cjs",
  serverDependenciesToBundle: [
    /^@internal\//, // Bundle all internal packages
    /^@platos\//, // Bundle all Platos workspace packages
  ],
  browserNodeBuiltinsPolyfill: {
    modules: {
      path: true,
      os: true,
      crypto: true,
      http2: true,
      assert: true,
      util: true,
    },
  },
};
