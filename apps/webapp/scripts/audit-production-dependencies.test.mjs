import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditProductionDependencies } from "./audit-production-dependencies.mjs";

const webappRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(webappRoot, "package.json"), "utf8"));

function write(root, file, contents) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function fixture({ dependencies = {}, optionalDependencies = {}, devDependencies = {}, scripts = {}, files = {}, packages = {} }) {
  const scratchRoot = existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir();
  const root = mkdtempSync(path.join(scratchRoot, "webapp-dependency-audit-"));
  const fixtureManifest = {
    private: true,
    name: "audit-fixture",
    dependencies,
    optionalDependencies,
    devDependencies,
    scripts,
  };
  write(root, "package.json", `${JSON.stringify(fixtureManifest, null, 2)}\n`);
  for (const [file, contents] of Object.entries(files)) write(root, file, contents);
  for (const [name, metadata] of Object.entries(packages)) {
    write(root, path.join("node_modules", name, "package.json"), `${JSON.stringify({ name, version: "1.0.0", ...metadata })}\n`);
  }
  return {
    root,
    manifest: fixtureManifest,
    audit(options = {}) {
      return auditProductionDependencies({ root, manifest: fixtureManifest, ...options });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function withFixture(options, callback) {
  const project = fixture(options);
  try {
    return callback(project);
  } finally {
    project.cleanup();
  }
}

test("derives the audited production manifest from retained reachability", () => {
  const result = auditProductionDependencies({ root: webappRoot, manifest });
  assert.equal(result.productionDependencies.length, 16);
  assert.deepEqual(result.productionDependencies, result.runtimeReachable);
  assert.ok(result.evidence.react.some((entry) => entry.kind === "static import"));
  assert.ok(result.evidence["react-grid-layout"].some((entry) => entry.kind === "CSS import"));
  assert.ok(result.evidence["cross-env"].some((entry) => entry.kind.includes("start")));
});

test("rejects a source import whose package is undeclared", () => {
  withFixture({ files: { "app/index.ts": 'import "undeclared-package";\n' } }, ({ audit }) => {
    assert.throws(
      () => audit(),
      /runtime dependency is undeclared: undeclared-package \(static import in app\/index\.ts\)/,
    );
  });
});

test("accepts a declared package reached by a legitimate static import", () => {
  withFixture(
    { dependencies: { legitimate: "1.0.0" }, files: { "app/index.ts": 'import value from "legitimate";\nvoid value;\n' } },
    ({ audit }) => assert.deepEqual(audit().productionDependencies, ["legitimate"]),
  );
});

test("rejects a declaration after its last source use is removed", () => {
  withFixture({ dependencies: { orphaned: "1.0.0" }, files: { "app/index.ts": "export {};\n" } }, ({ audit }) => {
    assert.throws(() => audit(), /production dependency has no reachable use: orphaned/);
  });
});

test("derives CSS package imports", () => {
  withFixture(
    { dependencies: { "css-package": "1.0.0" }, files: { "app/styles.css": '@import "css-package/theme.css";\n' } },
    ({ audit }) => assert.equal(audit().evidence["css-package"][0].kind, "CSS import"),
  );
});

test("derives literal dynamic imports", () => {
  withFixture(
    { dependencies: { "dynamic-package": "1.0.0" }, files: { "app/index.ts": 'export const load = () => import("dynamic-package/runtime");\n' } },
    ({ audit }) => assert.equal(audit().evidence["dynamic-package"][0].kind, "dynamic import"),
  );
});

test("rejects a non-literal dynamic import instead of silently bypassing reachability", () => {
  withFixture(
    { files: { "app/index.ts": 'const packageName = process.env.PLUGIN;\nexport const load = () => import(packageName);\n' } },
    ({ audit }) => {
      assert.throws(
        () => audit(),
        /non-literal module load cannot be audited: dynamic import in app\/index\.ts/,
      );
    },
  );
});

test("derives require and require.resolve calls", () => {
  withFixture(
    {
      dependencies: { "required-package": "1.0.0", "resolved-package": "1.0.0" },
      files: {
        "app/index.cjs": 'require("required-package");\nrequire.resolve("resolved-package/worker");\n',
      },
    },
    ({ audit }) => {
      const result = audit();
      assert.equal(result.evidence["required-package"][0].kind, "require");
      assert.equal(result.evidence["resolved-package"][0].kind, "require.resolve");
    },
  );
});

test("audits the first argument of import attributes and two-argument require.resolve", () => {
  withFixture(
    {
      dependencies: { "attributed-package": "1.0.0", "resolved-package": "1.0.0" },
      files: {
        "app/index.ts": [
          'import("attributed-package/data", { with: { type: "json" } });',
          'require.resolve("resolved-package/worker", { paths: [process.cwd()] });',
          "",
        ].join("\n"),
      },
    },
    ({ audit }) => {
      const result = audit();
      assert.equal(result.evidence["attributed-package"][0].kind, "dynamic import");
      assert.equal(result.evidence["resolved-package"][0].kind, "require.resolve");
    },
  );
});

test("rejects non-literal first arguments even when supported module loads have extra arguments", () => {
  withFixture(
    {
      files: {
        "app/index.ts": [
          "const target = process.env.PACKAGE;",
          'import(target, { with: { type: "json" } });',
          "require.resolve(target, { paths: [process.cwd()] });",
          "",
        ].join("\n"),
      },
    },
    ({ audit }) => {
      assert.throws(
        () => audit(),
        /non-literal module load cannot be audited: dynamic import in app\/index\.ts[\s\S]*non-literal module load cannot be audited: require\.resolve in app\/index\.ts/,
      );
    },
  );
});

test("classifies Tailwind and PostCSS plugins as build-only", () => {
  withFixture(
    {
      devDependencies: { "tailwind-plugin": "1.0.0", "postcss-plugin": "1.0.0" },
      files: {
        "tailwind.config.js": 'module.exports = { plugins: [require("tailwind-plugin")] };\n',
        "postcss.config.js": 'module.exports = { plugins: { "postcss-plugin": {} } };\n',
      },
    },
    ({ audit }) => {
      const result = audit();
      assert.deepEqual(result.productionDependencies, []);
      assert.ok(result.buildReachable.includes("tailwind-plugin"));
      assert.ok(result.buildReachable.includes("postcss-plugin"));
    },
  );
});

test("rejects an undeclared package imported by a build configuration", () => {
  withFixture(
    { files: { "remix.config.js": 'module.exports = require("undeclared-remix-plugin");\n' } },
    ({ audit }) => {
      assert.throws(
        () => audit(),
        /build dependency is undeclared: undeclared-remix-plugin \(require in remix\.config\.js\)/,
      );
    },
  );
});

test("records Remix bundling metadata without accepting it as dependency evidence", () => {
  withFixture(
    {
      dependencies: { "metadata-only-package": "1.0.0" },
      files: {
        "remix.config.js": 'module.exports = { serverDependenciesToBundle: ["metadata-only-package/subpath", /^workspace\\//] };\n',
      },
    },
    ({ audit }) => {
      assert.throws(
        () => audit(),
        /production dependency has no reachable use: metadata-only-package/,
      );
    },
  );
  withFixture(
    {
      devDependencies: { "metadata-only-package": "1.0.0" },
      files: {
        "remix.config.js": 'module.exports = { serverDependenciesToBundle: ["metadata-only-package/subpath"] };\n',
      },
    },
    ({ audit }) => {
      assert.deepEqual(audit().metadataReferences, ["metadata-only-package"]);
    },
  );
});

test("rejects a Tailwind plugin moved into production dependencies", () => {
  withFixture(
    {
      dependencies: { "tailwind-plugin": "1.0.0" },
      files: { "tailwind.config.js": 'module.exports = { plugins: [require("tailwind-plugin")] };\n' },
    },
    ({ audit }) => {
      assert.throws(
        () => audit(),
        /production dependency has no reachable use: tailwind-plugin[\s\S]*build-only dependency is declared for production: tailwind-plugin/,
      );
    },
  );
});

test("accepts a reached optional production dependency", () => {
  withFixture(
    {
      optionalDependencies: { "optional-runtime": "1.0.0" },
      files: { "app/index.ts": 'export const loadOptional = () => import("optional-runtime");\n' },
    },
    ({ audit }) => assert.deepEqual(audit().productionDependencies, ["optional-runtime"]),
  );
});

test("rejects unused optionalDependencies as production baggage", () => {
  withFixture(
    { optionalDependencies: { "unused-optional": "1.0.0" } },
    ({ audit }) => {
      assert.throws(() => audit(), /production dependency has no reachable use: unused-optional/);
    },
  );
});

test("does not accept comment-only dependency evidence", () => {
  withFixture(
    {
      dependencies: { "comment-spoof": "1.0.0" },
      files: { "app/index.ts": '// import "comment-spoof";\nexport {};\n' },
    },
    ({ audit }) => {
      assert.throws(() => audit(), /production dependency has no reachable use: comment-spoof/);
    },
  );
});

test("derives production package-script and entrypoint binaries from package metadata", () => {
  withFixture(
    {
      dependencies: { "ops-package": "1.0.0" },
      scripts: { start: "ops-tool serve" },
      files: { "scripts/entrypoint.sh": "#!/bin/sh\nexec ops-tool serve\n" },
      packages: { "ops-package": { bin: { "ops-tool": "./cli.js" } } },
    },
    ({ audit }) => {
      const evidence = audit().evidence["ops-package"];
      assert.ok(evidence.some((entry) => entry.kind === "package script command (start)"));
      assert.ok(evidence.some((entry) => entry.kind === "operational command"));
    },
  );
});

test("rejects an undeclared entrypoint binary instead of treating it as an OS command", () => {
  withFixture(
    { files: { "scripts/entrypoint.sh": "#!/bin/sh\nTOOL_MODE=prod exec undeclared-entrypoint-tool serve\n" } },
    ({ audit }) => {
      assert.throws(
        () => audit(),
        /unknown production command cannot be audited: undeclared-entrypoint-tool \(operational command in scripts\/entrypoint\.sh\)/,
      );
    },
  );
});

test("rejects unknown production package-script and Docker commands", () => {
  withFixture(
    {
      scripts: { start: "undeclared-start-tool serve" },
      files: { "Dockerfile.platos": 'FROM node AS runner\nCMD ["undeclared-runner-tool", "serve"]\n' },
    },
    ({ audit }) => {
      assert.throws(
        () => audit(),
        /unknown production command cannot be audited: undeclared-start-tool \(package script command \(start\) in package\.json\)[\s\S]*unknown production command cannot be audited: undeclared-runner-tool \(Docker entrypoint command in Dockerfile\.platos\)/,
      );
    },
  );
});

test("derives a Docker runner command without treating build-stage tools as runtime", () => {
  withFixture(
    {
      dependencies: { "runner-package": "1.0.0" },
      devDependencies: { "builder-package": "1.0.0" },
      files: {
        "Dockerfile.platos": "FROM node AS builder\nRUN build-tool compile\nFROM node AS runner\nCMD [\"runner-tool\", \"serve\"]\n",
      },
      packages: {
        "runner-package": { bin: { "runner-tool": "./cli.js" } },
        "builder-package": { bin: { "build-tool": "./cli.js" } },
      },
    },
    ({ audit }) => {
      const result = audit();
      assert.equal(result.evidence["runner-package"][0].scope, "production");
      assert.equal(result.evidence["builder-package"][0].scope, "build");
    },
  );
});

test("classifies source-map upload binaries as build-only", () => {
  withFixture(
    {
      devDependencies: { "source-map-uploader": "1.0.0" },
      files: { "upload-sourcemaps.sh": "#!/bin/sh\nsource-map-cli upload ./build\n" },
      packages: { "source-map-uploader": { bin: { "source-map-cli": "./cli.js" } } },
    },
    ({ audit }) => {
      const result = audit();
      assert.deepEqual(result.productionDependencies, []);
      assert.equal(result.evidence["source-map-uploader"][0].scope, "build");
    },
  );
});

test("follows local package export surfaces into runtime source", () => {
  withFixture(
    {
      dependencies: { "exported-runtime": "1.0.0" },
      files: { "surface.ts": 'export { value } from "exported-runtime";\n' },
    },
    ({ root, manifest: fixtureManifest }) => {
      fixtureManifest.exports = "./surface.ts";
      write(root, "package.json", `${JSON.stringify(fixtureManifest, null, 2)}\n`);
      const result = auditProductionDependencies({ root, manifest: fixtureManifest });
      assert.equal(result.evidence["exported-runtime"][0].kind, "export surface");
    },
  );
});

test("checks emitted build output when requested", () => {
  withFixture(
    {
      dependencies: { "externalized-runtime": "1.0.0" },
      files: {
        "app/index.ts": 'import "externalized-runtime";\n',
        "build/server.js": 'require("missing-build-runtime");\n',
      },
    },
    ({ audit }) => {
      assert.doesNotThrow(() => audit());
      assert.throws(
        () => audit({ includeBuildOutput: true }),
        /runtime dependency is undeclared: missing-build-runtime \(require in build\/server\.js\)/,
      );
    },
  );
});
