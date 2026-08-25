export const PERFORMANCE_ARTIFACT_FILE: "performance-results.json";
export const PERFORMANCE_RECEIPT_FILE: "performance-verification-receipt.json";

export type PerformanceVerificationReceipt = {
  $schema: "./performance-verification-receipt.schema.json";
  schemaVersion: 1;
  gate: "win235-measured-performance-verification";
  status: "passed";
  commitSha: string;
  performanceArtifact: {
    file: typeof PERFORMANCE_ARTIFACT_FILE;
    sha256: string;
  };
  budgetContract: {
    file: string;
    schemaVersion: number;
    sha256: string;
  };
  fixtureSha256: string;
};

export function createPerformanceVerificationReceipt(
  artifact: {
    commitSha: string;
    budgetContract: PerformanceVerificationReceipt["budgetContract"];
    fixture: { sha256: string };
  },
  performanceArtifactRaw: string | Buffer
): PerformanceVerificationReceipt;

export function verifyPerformanceVerificationReceipt(
  receipt: unknown,
  performanceArtifactRaw: string | Buffer,
  expectedCommit: string
): PerformanceVerificationReceipt;
