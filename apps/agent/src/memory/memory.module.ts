import { Module } from "@nestjs/common";
import { ConversationService } from "./conversation.service";
import { WorkingMemoryService } from "./working-memory.service";
import { EmbeddingService } from "./embedding.service";
import { MemoryService } from "./memory.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";
import { MemoryExtractionService } from "./memory-extraction.service";
import { MemoryFeedbackService } from "./memory-feedback.service";
import { MemoryFeedbackBackfillService } from "./memory-feedback-backfill.service";
import { MemoryFeedbackAdminController } from "./memory-feedback-admin.controller";
import { ProfileCacheService } from "./profile-cache.service";
import { MemorySchedulerService } from "./memory-scheduler.service";
import { MemoryController } from "./memory.controller";
import { MonitoringModule } from "../monitoring/monitoring.module";
import { ObservabilityModule } from "../observability/observability.module";
import { ProvidersModule } from "../providers/providers.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  // Import MonitoringModule so MessageCryptoService is available for
  // ConversationService's optional constructor arg (Theme H.4). Monitoring
  // has no edges into memory, so no cycle.
  //
  // Theme L — ProvidersModule is imported so EmbeddingService can resolve
  // the OPENAI_API_KEY from the scoped Environment credential service.
  // Theme O — MemoryExtractionService uses ScopedEnvService to resolve the
  // judge-LLM API key; same provider module covers both.
  //
  // WIN-133 — ObservabilityModule supplies the sink ConversationService queues
  // a Turn's analytical projection into, inside the same transaction that
  // finalizes the Turn. It depends only on Prisma, so no cycle either.
  imports: [MonitoringModule, ObservabilityModule, ProvidersModule, AuthModule],
  controllers: [MemoryController, MemoryFeedbackAdminController],
  providers: [
    ConversationService,
    WorkingMemoryService,
    EmbeddingService,
    MemoryService,
    KnowledgeGraphService,
    MemoryExtractionService,
    MemoryFeedbackService,
    MemoryFeedbackBackfillService,
    // Theme M.3 — Redis-backed per-user profile projection cache.
    ProfileCacheService,
    // NestJS @Cron driver for memory extraction (replaces trigger.dev scheduled task).
    MemorySchedulerService,
  ],
  exports: [
    ConversationService,
    WorkingMemoryService,
    EmbeddingService,
    MemoryService,
    KnowledgeGraphService,
    MemoryExtractionService,
    MemoryFeedbackService,
    MemoryFeedbackBackfillService,
    ProfileCacheService,
  ],
})
export class MemoryModule {}
