import { Module } from "@nestjs/common";
import { PerformanceEvidenceController } from "./performance-evidence.controller";
import { PerformanceEvidenceMiddleware } from "./performance-evidence.middleware";
import {
  PerformanceEvidenceService,
  performanceEvidenceService,
} from "./performance-evidence.service";

@Module({
  controllers: [PerformanceEvidenceController],
  providers: [
    { provide: PerformanceEvidenceService, useValue: performanceEvidenceService },
    PerformanceEvidenceMiddleware,
  ],
  exports: [PerformanceEvidenceService, PerformanceEvidenceMiddleware],
})
export class PerformanceEvidenceModule {}
