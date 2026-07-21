import { Injectable, Logger } from "@nestjs/common";
import type { Sandbox as VercelSandbox } from "@vercel/sandbox";

/**
 * CE.3 — Vercel Sandbox backend for the per-thread code-execution sandbox.
 *
 * This is a flag-gated alternative to the E2B backend used by
 * `platos.code_execution`'s filesystem tools — `run_shell`, `install_package`
 * and `upload_to_sandbox` all route here under PLATOS_SANDBOX_PROVIDER=vercel,
 * so they keep sharing one per-thread filesystem (`run_python` / `run_node`
 * have no Vercel equivalent and error clearly under the flag). Persistence
 * gets BETTER: a Vercel sandbox is a long-lived NAMED entity whose filesystem
 * is snapshotted on `stop()`, so cwd / files / installed packages survive long
 * idle gaps that would reap an E2B session server-side.
 *
 * ─ Auth (self-hosted VPS, NOT OIDC) ─────────────────────────────────────────
 * We pass { teamId, projectId, token } explicitly on every Sandbox call,
 * sourced from process.env (VERCEL_TEAM_ID / VERCEL_PROJECT_ID / VERCEL_TOKEN).
 * NB: scopedEnv.get() is dashboard-secrets-only in this codebase (no
 * process.env fallback), so for these infra creds we read process.env directly.
 * If any of the three is missing the feature is simply unavailable — we never
 * crash boot.
 *
 * ─ Cost model (the whole point) ─────────────────────────────────────────────
 * Active CPU bills only while computing, but PROVISIONED MEMORY bills wall-clock
 * for as long as a session is running. So we STOP BETWEEN TURNS: `stop()` in a
 * `finally` after each command batch. A stopped sandbox is snapshot storage only
 * ($0.08/GB-mo), costs zero compute, and doesn't count against the running-
 * concurrency cap. Any subsequent runCommand/fs call auto-resumes a new session.
 *
 * ─ Loading ──────────────────────────────────────────────────────────────────
 * @vercel/sandbox v2 is a pure-JS, ESM-only SDK. This codebase compiles to
 * CommonJS and runs on Node 22, which supports require(esm) — so we lazily
 * `require()` the module on first use (never at module-eval), wrapped so a
 * missing/broken package can never crash boot.
 */

type SandboxModule = typeof import("@vercel/sandbox");
type SandboxCtor = SandboxModule["Sandbox"];

let cachedSandboxCtor: SandboxCtor | null = null;

/** Lazily resolve the Sandbox class from the ESM SDK via Node 22 require(esm). */
function loadSandboxCtor(): SandboxCtor {
  if (!cachedSandboxCtor) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@vercel/sandbox") as SandboxModule;
    cachedSandboxCtor = mod.Sandbox;
  }
  return cachedSandboxCtor;
}

interface VercelAuth {
  teamId: string;
  projectId: string;
  token: string;
}

export interface VercelRunShellOpts {
  /** Thread anchor. Present → peg the named per-thread sandbox (persistent).
   *  Absent → ephemeral one-shot sandbox that is deleted afterwards. */
  threadId?: string;
  /** Script executed as `bash -lc <script>`. */
  script: string;
  /** Hard cap per script. Defaults to 10 min; clamped to 10 min max. */
  timeoutMs?: number;
  /** Optional live streaming sink. Invoked as output arrives AND accumulated. */
  onChunk?: (stream: "stdout" | "stderr", data: string) => void;
}

export interface VercelRunShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

@Injectable()
export class VercelSandboxService {
  private readonly logger = new Logger(VercelSandboxService.name);

  /** Session lifetime cap handed to the SDK when booting a VM. */
  private static readonly SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

  /**
   * Per-thread promise chains serializing open→exec→stop units. Without this,
   * two parallel run_shell tool calls (parallel tool calls are normal LLM
   * behaviour) race on the same named sandbox: call A's `finally` stop()
   * snapshots the FS and kills the session while call B's detached command is
   * still executing, producing a spurious mid-run failure. Serializing per
   * thread guarantees stop() only ever runs between commands. (In-process
   * only — multi-instance deployments would need a distributed lock, out of
   * scope for v1.)
   */
  private readonly threadChains = new Map<string, Promise<unknown>>();

  /** Queue `fn` behind any in-flight work for the same thread. */
  private runExclusive<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.threadChains.get(threadId) ?? Promise.resolve();
    // `prev` is always a swallowed tail (never rejects), so .then is safe.
    const run = prev.then(fn);
    let tail: Promise<void>;
    tail = run
      .then(() => undefined, () => undefined)
      .then(() => {
        // Drop the map entry once the chain drains so it can't grow unbounded.
        if (this.threadChains.get(threadId) === tail) {
          this.threadChains.delete(threadId);
        }
      });
    this.threadChains.set(threadId, tail);
    return run;
  }
  /** Absolute per-script hard cap; also the default when none is supplied. */
  private static readonly DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  /** Per-stream accumulation ceiling so a runaway command can't blow up memory. */
  private static readonly MAX_OUT = 100_000;

  /** Read the three infra creds from process.env; null if any is missing. */
  private auth(): VercelAuth | null {
    const teamId = process.env.VERCEL_TEAM_ID?.trim();
    const projectId = process.env.VERCEL_PROJECT_ID?.trim();
    const token = process.env.VERCEL_TOKEN?.trim();
    if (!teamId || !projectId || !token) return null;
    return { teamId, projectId, token };
  }

  /** True only when all three Vercel creds are present. */
  isConfigured(): boolean {
    return this.auth() !== null;
  }

  /**
   * Optional short env prefix so two Platos environments that share one Vercel
   * project don't collide on the (immutable, project-unique) sandbox name.
   * Empty by default.
   */
  private namePrefix(): string {
    const p = process.env.PLATOS_SANDBOX_NAME_PREFIX?.trim();
    return p ? `${p}-` : "";
  }

  /** Deterministic, immutable per-thread sandbox name. */
  private sandboxName(threadId: string): string {
    return `${this.namePrefix()}platos-thread-${threadId}`;
  }

  /**
   * Peg the long-lived named sandbox for this thread. `getOrCreate` resumes the
   * snapshot if one exists (resume:true) or provisions a fresh VM, running the
   * one-time `onCreate` setup. snapshotExpiration:0 = never expire; we keep the
   * single most-recent snapshot and delete evicted ones.
   */
  async openForThread(threadId: string): Promise<VercelSandbox> {
    const auth = this.auth();
    if (!auth) {
      throw new Error(
        "Vercel Sandbox is not configured (VERCEL_TEAM_ID / VERCEL_PROJECT_ID / VERCEL_TOKEN).",
      );
    }
    const Sandbox = loadSandboxCtor();
    return Sandbox.getOrCreate({
      ...auth,
      name: this.sandboxName(threadId),
      runtime: "node24",
      timeout: VercelSandboxService.SESSION_TIMEOUT_MS,
      resume: true,
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
      onCreate: async (_sbx: VercelSandbox) => {
        // One-time setup for a brand-new sandbox. None needed for v1.
      },
      onResume: async (_sbx: VercelSandbox) => {
        // Relaunch background processes after a resume. None needed for v1
        // (run_shell is one-shot per turn; nothing runs across stop/resume).
      },
    });
  }

  /**
   * Execute a shell script.
   *  - thread path: openForThread → detached `bash -lc` → stream logs → wait →
   *    ALWAYS `stop()` in finally (cost model: snapshot FS, drop compute).
   *  - no-thread path: create({ persistent:false }) → run → ALWAYS `delete()` in
   *    finally (tears down the VM and its snapshots).
   */
  async runShell(opts: VercelRunShellOpts): Promise<VercelRunShellResult> {
    const threadId = opts.threadId?.trim();
    const timeoutMs = Math.max(
      1000,
      Math.min(VercelSandboxService.DEFAULT_TIMEOUT_MS, opts.timeoutMs ?? VercelSandboxService.DEFAULT_TIMEOUT_MS),
    );

    if (threadId) {
      // Serialize per thread: parallel tool calls share one named sandbox, and
      // an unserialized stop() from one call would kill the other's in-flight
      // command (see threadChains doc comment).
      return this.runExclusive(threadId, async () => {
        const sandbox = await this.openForThread(threadId);
        try {
          return await this.exec(sandbox, opts.script, timeoutMs, opts.onChunk);
        } finally {
          // Cost model: stop between turns. Snapshots the filesystem, releases
          // provisioned memory, and drops the sandbox out of the concurrency cap.
          await sandbox.stop().catch((err: unknown) => {
            this.logger.debug(`[vercel-sandbox] stop() failed (best effort): ${String(err)}`);
          });
        }
      });
    }

    // Ephemeral, no thread to anchor to.
    const auth = this.auth();
    if (!auth) {
      throw new Error(
        "Vercel Sandbox is not configured (VERCEL_TEAM_ID / VERCEL_PROJECT_ID / VERCEL_TOKEN).",
      );
    }
    const Sandbox = loadSandboxCtor();
    const sandbox = await Sandbox.create({
      ...auth,
      runtime: "node24",
      timeout: VercelSandboxService.SESSION_TIMEOUT_MS,
      persistent: false,
    });
    try {
      return await this.exec(sandbox, opts.script, timeoutMs, opts.onChunk);
    } finally {
      // Ephemeral sandboxes are deleted outright (also deletes snapshots).
      await sandbox.delete().catch((err: unknown) => {
        this.logger.debug(`[vercel-sandbox] delete() failed (best effort): ${String(err)}`);
      });
    }
  }

  /**
   * Run one script in an already-open sandbox: detached command, stream logs
   * (invoke onChunk AND accumulate, bounded), then wait for the exit code. A
   * timeout guard kills the command and surfaces exit code 124.
   */
  private async exec(
    sandbox: VercelSandbox,
    script: string,
    timeoutMs: number,
    onChunk?: (stream: "stdout" | "stderr", data: string) => void,
  ): Promise<VercelRunShellResult> {
    const MAX_OUT = VercelSandboxService.MAX_OUT;
    let stdout = "";
    let stderr = "";
    const append = (stream: "stdout" | "stderr", data: string) => {
      if (stream === "stdout") {
        if (stdout.length < MAX_OUT) stdout += data;
      } else if (stderr.length < MAX_OUT) {
        stderr += data;
      }
    };

    const cmd = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      detached: true,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the runaway command; the outer finally stops/deletes the sandbox.
      Promise.resolve(cmd.kill()).catch(() => {
        /* best effort */
      });
    }, timeoutMs);

    try {
      for await (const log of cmd.logs()) {
        const data = typeof log.data === "string" ? log.data : String(log.data ?? "");
        const stream: "stdout" | "stderr" = log.stream === "stderr" ? "stderr" : "stdout";
        append(stream, data);
        onChunk?.(stream, data);
      }
      const done = await cmd.wait();
      const exitCode = timedOut
        ? 124
        : typeof (done as { exitCode?: unknown })?.exitCode === "number"
          ? (done as { exitCode: number }).exitCode
          : 0;
      if (timedOut) {
        stderr = `${stderr}\n…[timed out after ${timeoutMs}ms]`;
      }
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }
}
