import { Module } from "@nestjs/common";
import { PiiFilterService } from "./pii-filter.service";

/** PIFSP-18 — PII governance module. */
@Module({
  providers: [PiiFilterService],
  exports: [PiiFilterService],
})
export class GovernanceModule {}
