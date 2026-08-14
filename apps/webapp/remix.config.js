/** @type {import('@remix-run/dev').AppConfig} */
const productionIgnoredRouteFiles = (source = process.env) =>
  source.PLATOS_PRODUCTION_BUILD === "true"
    ? ["**/*.agent-connect.mint-token.ts"]
    : [];

module.exports = {
  dev: {
    port: 8002,
  },
  tailwind: true,
  cacheDirectory: "./node_modules/.cache/remix",
  ignoredRouteFiles: ["**/.*", ...productionIgnoredRouteFiles()],
  serverModuleFormat: "cjs",
  serverDependenciesToBundle: [
    /^remix-utils.*/,
    /^@internal\//, // Bundle all internal packages
    /^@platos\//, // Bundle all Platos packages (renamed from @trigger.dev/*)
    /^@trigger\.dev\//, // Bundle any remaining @trigger.dev/* (companyicons, platform)
    "marked",
    "agentcrumbs",
    "axios",
    "p-limit",
    "p-map",
    "yocto-queue",
    "@unkey/cache",
    "@unkey/cache/stores",
    "emails",
    "highlight.run",
    "random-words",
    "superjson",
    "copy-anything",
    "is-what",
    "prismjs/components/prism-json",
    "prismjs/components/prism-typescript",
    "redlock",
    "parse-duration",
    "uncrypto",
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
