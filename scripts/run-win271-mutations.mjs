// One-shot driver for the WIN-271 mutation sweep. Not committed as a gate.
//
// Applies one exact anchor replacement, runs one command from the repository
// root, restores the file, and records the exit code the run actually returned.
// Nothing here predicts an outcome.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const COMMANDS = {
  slack: "pnpm --filter @platos/adapter-channel-slack exec vitest run",
  slackSig: "pnpm --filter @platos/adapter-channel-slack exec vitest run src/slack-signature.test.ts",
  slackNorm: "pnpm --filter @platos/adapter-channel-slack exec vitest run src/normalize.test.ts",
  slackTx: "pnpm --filter @platos/adapter-channel-slack exec vitest run src/slack-transport.test.ts",
  slackAdmit: "pnpm --filter @platos/adapter-channel-slack exec vitest run src/signed-admission.test.ts",
  slackUpgrade: "pnpm --filter @platos/adapter-channel-slack exec vitest run src/sdk-upgrade.test.ts",
  channels: "pnpm --filter @platos/context-channels exec vitest run",
  comp: "node scripts/arch/composition-root.mjs",
  // THE CONTEXT IS CONSUMED THROUGH ITS `dist/`, so a mutation of its SOURCE is
  // invisible to the adapter's suite until the package is rebuilt. The first
  // run of this sweep recorded M14 and M15 as survivors for exactly that
  // reason — they were mutating a file nothing under test was reading.
  slackAdmitBuilt:
    "pnpm --filter @platos/context-channels build && pnpm --filter @platos/adapter-channel-slack exec vitest run src/signed-admission.test.ts",
  channelsBuilt:
    "pnpm --filter @platos/context-channels build && pnpm --filter @platos/context-channels exec vitest run",
};

const MUTATIONS = JSON.parse(readFileSync(new URL("./win271-mutation-plan.json", import.meta.url), "utf8"));

const results = [];
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, "utf8");
  if (!original.includes(mutation.from)) {
    results.push({ ...mutation, exit: null, outcome: "ANCHOR NOT FOUND" });
    process.stdout.write(`ANCHOR-MISS ${mutation.name}\n`);
    continue;
  }
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    results.push({ ...mutation, exit: null, outcome: `ANCHOR MATCHES ${occurrences} TIMES` });
    process.stdout.write(`ANCHOR-AMBIGUOUS ${mutation.name} (${occurrences})\n`);
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
  let exit = 0;
  let tail = "";
  const logPath = "/tmp/win271-mutation.log";
  try {
    // NO PIPE. `execSync("cmd | tail")` reports TAIL's exit status, which is 0
    // whatever the command did — the first draft of this driver did exactly
    // that and reported 0/19 killed, which is how it was caught.
    // BOTH STREAMS TO A FILE, read back afterwards. pnpm re-emits a child's
    // output on its own descriptors and `execSync`'s error object does not
    // reliably carry it, so two earlier drafts of this driver recorded every
    // kill with no case name. A file is a file.
    execSync(`${COMMANDS[mutation.command]} > ${logPath} 2>&1`, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 600_000,
    });
    tail = readFileSync(logPath, "utf8");
  } catch (error) {
    exit = error.status ?? 1;
    // BOTH STREAMS, DECODED. `execSync` hands back Buffers on the error object
    // even when `encoding` is set for the success path, and a Buffer
    // interpolated into a template literal renders as "[object Object]" — which
    // is why the first two runs of this sweep recorded every kill with "(no
    // case names parsed)".
    tail = readFileSync(logPath, "utf8");
  }
  writeFileSync(mutation.file, original);
  // Rebuild after restoring, so the NEXT row is not measured against a `dist/`
  // still holding the previous mutation.
  if (mutation.command.endsWith("Built")) {
    try {
      execSync("pnpm --filter @platos/context-channels build", { encoding: "utf8", stdio: "ignore" });
    } catch {
      // Reported by the next row's own run.
    }
  }
  // ANSI STRIPPED FIRST. Vitest colours the marker and the duration, so a
  // pattern written against the raw bytes matches nothing and every row
  // records no case name at all — which is a ledger saying a mutation killed
  // without saying WHAT noticed, and that is the claim worth having.
  const plain = tail.replace(/\u001B\[[0-9;]*m/gu, "");
  const failedNames = [
    ...plain.matchAll(/^\s*(?:\u00D7|\u2715|\u2716)\s+(.+?)(?:\s+\d+ms)?\s*$/gmu),
    ...plain.matchAll(/^FAIL\s+(.+)$/gmu),
  ].map((m) => m[1].trim()).filter((name) => name.length > 3);
  results.push({
    name: mutation.name,
    guards: mutation.guards,
    why: mutation.why,
    file: mutation.file,
    command: COMMANDS[mutation.command],
    exit,
    outcome: exit === 0 ? "SURVIVED" : "killed",
    killedCases: failedNames.slice(0, 6),
  });
  process.stdout.write(`${exit === 0 ? "SURVIVED " : "killed   "} ${mutation.name}\n`);
  for (const name of failedNames.slice(0, 4)) process.stdout.write(`             -> ${name}\n`);
}

writeFileSync("scripts/win271-mutation-results.json", `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`\n${results.filter((r) => r.outcome === "killed").length}/${results.length} killed\n`);
