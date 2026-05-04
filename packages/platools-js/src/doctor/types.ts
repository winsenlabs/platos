/**
 * Public types for `platools doctor`.
 *
 * Kept separate from `analyzer.ts` so the CLI and check modules
 * can import the data shapes without pulling the full analysis
 * engine. Mirrors `platools/doctor/types.py`.
 */

export type Severity = "error" | "warning" | "info";

export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
  readonly tool?: string;
  readonly param?: string;
}

export class DoctorReport {
  public constructor(
    public readonly toolCount: number,
    public readonly findings: readonly Finding[],
  ) {}

  public errors(): Finding[] {
    return this.findings.filter((f) => f.severity === "error");
  }

  public warnings(): Finding[] {
    return this.findings.filter((f) => f.severity === "warning");
  }

  public infos(): Finding[] {
    return this.findings.filter((f) => f.severity === "info");
  }

  public hasErrors(): boolean {
    return this.findings.some((f) => f.severity === "error");
  }
}
