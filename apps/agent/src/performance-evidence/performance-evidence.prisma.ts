import type { PerformanceEvidenceService } from "./performance-evidence.service";

type PrismaQueryEvent = {
  query: string;
  params: string;
  duration: number;
};

type InstrumentablePrismaClient = {
  $on(event: "query", listener: (event: PrismaQueryEvent) => void): unknown;
  $extends(extension: {
    name: string;
    query: {
      $allOperations(input: {
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }): Promise<unknown>;
    };
  }): unknown;
};

export function instrumentPerformanceEvidencePrisma<T extends InstrumentablePrismaClient>(
  prisma: T,
  evidence: PerformanceEvidenceService
): T {
  if (!evidence.enabled()) return prisma;

  prisma.$on("query", (event) => evidence.recordQueryEvent(event));
  return prisma.$extends({
    name: "platos-performance-evidence",
    query: {
      $allOperations({ args, query }) {
        return evidence.runQueryInvocation(() => query(args));
      },
    },
  }) as T;
}
