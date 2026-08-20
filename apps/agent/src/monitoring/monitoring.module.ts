import { Module } from "@nestjs/common";
import { SafetyService } from "./safety.service";
import { CostService } from "./cost.service";
import { SpansService } from "./spans.service";
import { TraceService } from "./trace.service";
import { UtilizationService } from "./utilization.service";
import { ToolAuditService } from "./tool-audit.service";
import { MonitoringApprovalsService } from "./approvals.service";
import { MessageCryptoService } from "./message-crypto.service";
import { BudgetService } from "./budget.service";
import { SafetyEventService } from "./safety-event.service";
import { GovernanceService } from "./governance.service";
import { RateLimitService } from "./rate-limit.service";
import { MetricsService } from "./metrics.service";
import { MetricsController } from "./metrics.controller";
import { SentryService } from "./sentry.service";
import { AdminAuditService } from "./admin-audit.service";
import { ProvidersModule } from "../providers/providers.module";
import { ModelPricingBootstrapService } from "./model-pricing-bootstrap.service";

@Module({
  imports: [ProvidersModule],
  controllers: [MetricsController],
  providers: [
    SafetyService,
    CostService,
    ModelPricingBootstrapService,
    SpansService,
    TraceService,
    UtilizationService,
    ToolAuditService,
    MonitoringApprovalsService,
    MessageCryptoService,
    BudgetService,
    SafetyEventService,
    GovernanceService,
    RateLimitService,
    MetricsService,
    SentryService,
    AdminAuditService,
  ],
  exports: [
    SafetyService,
    CostService,
    SpansService,
    TraceService,
    UtilizationService,
    ToolAuditService,
    MonitoringApprovalsService,
    MessageCryptoService,
    BudgetService,
    SafetyEventService,
    GovernanceService,
    RateLimitService,
    MetricsService,
    SentryService,
    AdminAuditService,
  ],
})
export class MonitoringModule {}
