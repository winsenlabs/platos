#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function remixBuildArgs(source = process.env) {
  return source.WEBAPP_BUILD_SOURCEMAPS === "true"
    ? ["remix", "build", "--sourcemap"]
    : ["remix", "build"];
}

export function hasFatalBuildDiagnostic(output) {
  return /(^|\n)fatal error:/i.test(output);
}

async function run() {
  const [binary, ...args] = remixBuildArgs();
  console.log(
    `[webapp-build] production source maps ${args.includes("--sourcemap") ? "enabled" : "disabled"}`,
  );
  const child = spawn(binary, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, PLATOS_PRODUCTION_BUILD: "true" },
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => {
    diagnostics += chunk.toString();
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk.toString();
    process.stderr.write(chunk);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`[webapp-build] failed to start Remix: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (hasFatalBuildDiagnostic(diagnostics)) {
      console.error("[webapp-build] refusing successful exit after a fatal esbuild diagnostic");
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
