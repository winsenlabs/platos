import { Module } from "@nestjs/common";
import { RatingService } from "./rating.service";
import { CriterionService } from "./criterion.service";
import { EvalService } from "./eval.service";
import { GoldenSetService } from "./golden-set.service";
import { ProvidersModule } from "../providers/providers.module";
import { MemoryModule } from "../memory/memory.module";
import { MonitoringModule } from "../monitoring/monitoring.module";

/**
 * Theme J — Eval framework module.
 *
 * Houses the four services that back Theme J:
 *   - RatingService      — inline thumbs votes + satisfaction aggregation (J.1/J.2)
 *   - CriterionService   — eval criteria CRUD (J.3)
 *   - EvalService        — judge-LLM pipeline + PlatosAgentEval query API (J.4/J.5/J.6/J.7)
 *   - GoldenSetService   — regression-run definition + runner kickoff (J.8)
 *
 * Depends on ProvidersModule for the scoped env-var resolver (the judge LLM
 * fetches its API key from the same `PlatosEnvironmentVariable` store the
 * agent runtime uses).
 */
@Module({
  // Theme M.5 — MemoryModule is imported so RatingService can inject
  // MemoryFeedbackService. MemoryModule does not depend on anything in
  // EvalsModule, so the edge is one-way (no cycle).
  imports: [ProvidersModule, MemoryModule, MonitoringModule],
  providers: [RatingService, CriterionService, EvalService, GoldenSetService],
  exports: [RatingService, CriterionService, EvalService, GoldenSetService],
})
export class EvalsModule {}
