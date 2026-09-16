#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// `pnpm --filter @platos/core-api dev` — REBUILD ON CHANGE, THEN SERVE THE NEW BUILD.
//
// The sibling deployables' dev scripts SERVE: apps/agent runs `nest start --watch`,
// which recompiles on every change and restarts the process after each successful
// compilation. core-api's dev script used to be `tsc -b --watch`, which recompiled
// and never started anything, so "run core-api in dev" ended with no listener.
//
// SAME SEMANTICS, NO NEW DEPENDENCY. This runner joins the package's own two
// scripts rather than restating either:
//
//   * the WATCH is the `build` script with `--watch --preserveWatchOutput`
//     appended, so it follows the same project references `tsc -b` builds — an
//     edit to a context or adapter the process imports rebuilds and restarts too;
//   * the PROCESS is the `start` script, exactly what the image's CMD runs.
//
// A compilation that reports errors does not restart the process: the last good
// build keeps serving, as under `nest start --watch`. A restart sends SIGTERM and
// waits for the old process to finish its drained shutdown before the new one
// binds the port. SIGINT or SIGTERM to this runner stops both children and exits
// with the served process's own code.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const { scripts = {} } = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));

function argv(script, name) {
  const words = String(script ?? "").trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) throw new Error(`apps/core-api/package.json has no ${name} script to run`);
  return words;
}

const watchArgv = [...argv(scripts.build, "build"), "--watch", "--preserveWatchOutput"];
const startArgv = argv(scripts.start, "start");

// tsc prints this line once per compilation in watch mode, with the error count.
const COMPILED = /Found (\d+) errors?\. Watching for file changes\./u;

let served = null;
let stopping = false;
let restartQueued = false;

function log(message) {
  process.stdout.write(`[core-api dev] ${message}\n`);
}

function startServed() {
  log(`starting: ${startArgv.join(" ")}`);
  const child = spawn(startArgv[0], startArgv.slice(1), { cwd: packageDirectory, stdio: "inherit" });
  served = child;
  child.on("exit", (code, signal) => {
    if (served === child) served = null;
    log(`process exited (${signal ?? `code ${String(code)}`})`);
    if (stopping) finish(code ?? 1);
  });
}

async function restartServed() {
  if (restartQueued) return;
  restartQueued = true;
  const previous = served;
  if (previous !== null) {
    log("compiled cleanly; stopping the running process before serving the new build");
    await new Promise((resolve) => {
      previous.once("exit", resolve);
      previous.kill("SIGTERM");
    });
  }
  restartQueued = false;
  if (!stopping) startServed();
}

const watcher = spawn(watchArgv[0], watchArgv.slice(1), {
  cwd: packageDirectory,
  stdio: ["ignore", "pipe", "inherit"],
});
let pending = "";
watcher.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  pending += chunk.toString("utf8");
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    const match = COMPILED.exec(line);
    if (match === null) continue;
    if (match[1] === "0") void restartServed();
    else log(`compilation reported ${match[1]} error(s); the last good build keeps serving`);
  }
});
watcher.on("exit", (code) => {
  if (!stopping) {
    log(`the compiler exited unexpectedly (code ${String(code)})`);
    stop("watcher-exit");
  }
});

function finish(code) {
  if (watcher.exitCode === null) watcher.kill("SIGTERM");
  process.exit(code);
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (served === null) finish(signal === "watcher-exit" ? 1 : 0);
  else served.kill("SIGTERM");
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
