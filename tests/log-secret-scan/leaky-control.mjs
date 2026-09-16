// WIN-259 — the negative control for the emitted-log secret scan.
//
// A scan that has never been shown to find anything is decoration. This process
// is the thing it must find.
//
// IT IS NOT A MOCK OF THE LEAK. It writes the SAME planted values through the
// SAME `createProcessLogger` the deployable composes, at the same level, onto
// the same `process.stdout`. The only difference from the serving process is the
// FIELD KEY: the values go under `note`, which the kernel's redactor does not
// classify as material, so they reach stdout in the clear.
//
// That is a real leak of a real class — a caller stamping a secret onto a log
// field nobody classified — and it is the class the redactor cannot defend
// against on its own, which is precisely why the gate beside it scans the bytes
// rather than trusting the classifier. If this process's output does NOT contain
// every planted value, the scan, the capture or the encodings have stopped
// working and the clean phase was silence.
//
// It emits the `process.started` line too, because the runner's anti-vacuity
// refusal requires a corpus to look like a core-api log before it will believe
// a result drawn from one.

import { createProcessLogger } from "../../apps/core-api/dist/runtime/process-ports.js";

const planted = JSON.parse(process.env["PLATOS_LOG_SCAN_PLANTED"] ?? "[]");
if (!Array.isArray(planted) || planted.length === 0) {
  process.stderr.write("the negative control was given nothing to leak\n");
  process.exit(1);
}

const logger = createProcessLogger({
  minimumLevel: "debug",
  write: (line) => process.stdout.write(line),
  base: { service: "core-api", environment: "test" },
});

logger.log("info", "process.started", { control: "win259-negative" });
for (const entry of planted) {
  logger.log("info", "control.deliberate_leak", { planted: String(entry.id), note: String(entry.value) });
}
process.exit(0);
