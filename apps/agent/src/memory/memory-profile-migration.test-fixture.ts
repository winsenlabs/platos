import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const runnerPath = resolve(
  process.cwd(),
  "../../internal-packages/tenancy-database/migration-image/migrate-memory-profiles.mjs",
);

/** Runs the same immutable-image command sequence used by deployment tests. */
export function runMemoryProfileMigrationCommands(databaseUrl: string): void {
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  const dryRun = JSON.parse(execFileSync(
    process.execPath,
    [runnerPath, "memory-profile-dry-run"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )) as { digest: string };
  execFileSync(
    process.execPath,
    [runnerPath, "memory-profile-apply", "--digest", dryRun.digest],
    { env, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [runnerPath, "memory-profile-verify"],
    { env, stdio: "pipe" },
  );
}
