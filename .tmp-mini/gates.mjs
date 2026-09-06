// Extract every command CI runs, by YAML parse, from every job in ci.yml.
import { readFileSync } from "node:fs";
import YAML from "yaml";

const doc = YAML.parse(readFileSync("./.github/workflows/ci.yml", "utf8"));
const rows = [];
for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
  for (const step of job.steps ?? []) {
    if (typeof step.run !== "string") continue;
    for (const line of step.run.split("\n")) {
      const command = line.trim();
      if (command === "") continue;
      rows.push({ job: jobName, name: step.name ?? "", command });
    }
  }
}
console.log(JSON.stringify(rows, null, 1));
