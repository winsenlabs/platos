#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

export const MIB = 1024 * 1024;
export const DEFAULT_BUILD_HEAP_MB = 1536;
export const BUILD_HEADROOM_MB = 2048;
export const DEFAULT_RUNTIME_HEAP_MB = 1536;
export const RUNTIME_MIN_RESERVE_MB = 512;
export const RUNTIME_MAX_HEAP_RATIO = 0.75;

export function parsePositiveInteger(name, value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer number of MiB`);
  }
  return Number(value);
}

export function buildMemoryPolicy({ availableBytes, heapMb = DEFAULT_BUILD_HEAP_MB }) {
  const requiredMb = heapMb + BUILD_HEADROOM_MB;
  const availableMb = Math.floor(availableBytes / MIB);
  return {
    ok: availableMb >= requiredMb,
    heapMb,
    availableMb,
    requiredMb,
    message:
      availableMb >= requiredMb
        ? `webapp build memory check passed: ${availableMb} MiB available, ${heapMb} MiB heap ceiling`
        : `webapp build refused: ${availableMb} MiB available; ${requiredMb} MiB required (${heapMb} MiB heap + ${BUILD_HEADROOM_MB} MiB build headroom). Build off-box or free memory before retrying.`,
  };
}

export function runtimeMemoryPolicy({ limitBytes, heapMb = DEFAULT_RUNTIME_HEAP_MB }) {
  const limitMb = Math.floor(limitBytes / MIB);
  const ratioCeilingMb = Math.floor(limitMb * RUNTIME_MAX_HEAP_RATIO);
  const reserveCeilingMb = limitMb - RUNTIME_MIN_RESERVE_MB;
  const maximumHeapMb = Math.max(0, Math.min(ratioCeilingMb, reserveCeilingMb));
  return {
    ok: heapMb <= maximumHeapMb,
    heapMb,
    limitMb,
    maximumHeapMb,
    message:
      heapMb <= maximumHeapMb
        ? `webapp runtime memory check passed: ${heapMb} MiB heap, ${limitMb} MiB effective limit`
        : `webapp runtime refused: ${heapMb} MiB heap exceeds the safe ${maximumHeapMb} MiB ceiling for a ${limitMb} MiB effective limit (25% and at least ${RUNTIME_MIN_RESERVE_MB} MiB reserved).`,
  };
}

function readNumber(path) {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw || raw === "max") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function readMemAvailableBytes() {
  try {
    const raw = readFileSync("/proc/meminfo", "utf8");
    const match = raw.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : freemem();
  } catch {
    return freemem();
  }
}

export function cgroupV2Paths(procSelfCgroup) {
  const entry = procSelfCgroup
    .split("\n")
    .find((line) => line.startsWith("0::"));
  const relative = entry?.slice(3).replace(/^\/+/, "") ?? "";
  const root = relative ? `/sys/fs/cgroup/${relative}` : "/sys/fs/cgroup";
  return {
    limit: `${root}/memory.max`,
    current: `${root}/memory.current`,
  };
}

function resolvedCgroupV2Paths() {
  try {
    return cgroupV2Paths(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return { limit: "/sys/fs/cgroup/memory.max", current: "/sys/fs/cgroup/memory.current" };
  }
}

export function detectMemory() {
  const hostTotal = totalmem();
  const hostAvailable = readMemAvailableBytes();
  const cgroupV2 = resolvedCgroupV2Paths();
  const cgroupV2Limit =
    readNumber(cgroupV2.limit) ?? readNumber("/sys/fs/cgroup/memory.max");
  const cgroupV2Current =
    readNumber(cgroupV2.current) ?? readNumber("/sys/fs/cgroup/memory.current") ?? 0;
  const cgroupV1Limit = readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const cgroupV1Current = readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes") ?? 0;
  const rawCgroupLimit = cgroupV2Limit ?? cgroupV1Limit;
  const cgroupLimit =
    rawCgroupLimit && rawCgroupLimit < hostTotal * 2 ? rawCgroupLimit : hostTotal;
  const cgroupCurrent = cgroupV2Limit ? cgroupV2Current : cgroupV1Current;
  const cgroupAvailable = Math.max(0, cgroupLimit - cgroupCurrent);

  return {
    limitBytes: Math.min(hostTotal, cgroupLimit),
    availableBytes: Math.min(hostAvailable, cgroupAvailable),
  };
}

export function withHeapOption(nodeOptions, heapMb) {
  const withoutHeap = (nodeOptions ?? "")
    .replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [`--max-old-space-size=${heapMb}`, withoutHeap].filter(Boolean).join(" ");
}

async function run() {
  const [mode, separator, command, ...args] = process.argv.slice(2);
  if ((mode !== "build" && mode !== "runtime") || separator !== "--" || !command) {
    throw new Error(
      "usage: memory-policy.mjs <build|runtime> -- <command> [arguments...]",
    );
  }

  const memory = detectMemory();
  const heapMb =
    mode === "build"
      ? parsePositiveInteger(
          "WEBAPP_BUILD_MAX_OLD_SPACE_SIZE_MB",
          process.env.WEBAPP_BUILD_MAX_OLD_SPACE_SIZE_MB,
          DEFAULT_BUILD_HEAP_MB,
        )
      : parsePositiveInteger(
          "WEBAPP_NODE_MAX_OLD_SPACE_SIZE_MB",
          process.env.WEBAPP_NODE_MAX_OLD_SPACE_SIZE_MB,
          DEFAULT_RUNTIME_HEAP_MB,
        );
  const policy =
    mode === "build"
      ? buildMemoryPolicy({ availableBytes: memory.availableBytes, heapMb })
      : runtimeMemoryPolicy({ limitBytes: memory.limitBytes, heapMb });

  const log = policy.ok ? console.log : console.error;
  log(`[memory-policy] ${policy.message}`);
  if (!policy.ok) process.exit(78);

  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: withHeapOption(process.env.NODE_OPTIONS, heapMb),
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`[memory-policy] failed to start ${command}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(`[memory-policy] ${error.message}`);
    process.exit(78);
  });
}
