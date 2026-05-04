import { Injectable, Logger } from "@nestjs/common";

/**
 * Wraps trigger.dev schedule CRUD for agent-layer use.
 *
 * BLOCK 2: all methods call @platos/sdk's `schedules.*` with proper
 * externalId = `agent:{agentId}` so schedules are discoverable per-agent.
 */
export interface CreateAgentScheduleOptions {
  agentId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  cron: string;
  timezone?: string;
  deduplicationKey?: string;
}

export interface AgentSchedule {
  id: string;
  agentId: string;
  cron: string;
  timezone: string;
  active: boolean;
  nextRunAt: string | null;
}

@Injectable()
export class TriggerSchedulesService {
  private readonly logger = new Logger(TriggerSchedulesService.name);

  async createForAgent(opts: CreateAgentScheduleOptions): Promise<AgentSchedule> {
    // BLOCK 2: schedules.create({ task, cron, timezone, externalId: `agent:${opts.agentId}`,
    //   tags: [`org:${opts.organizationId}`, `project:${opts.projectId}`, `env:${opts.environmentId}`] })
    this.logger.warn("createForAgent stub — BLOCK 2 impl pending", opts);
    return { id: "stub", agentId: opts.agentId, cron: opts.cron, timezone: opts.timezone ?? "UTC", active: true, nextRunAt: null };
  }

  async listForAgent(agentId: string): Promise<AgentSchedule[]> {
    // BLOCK 2: schedules.list({ externalId: `agent:${agentId}` })
    this.logger.warn(`listForAgent stub — BLOCK 2 impl pending. agentId=${agentId}`);
    return [];
  }

  async deactivate(scheduleId: string): Promise<void> {
    this.logger.warn(`deactivate stub — BLOCK 2 impl pending. scheduleId=${scheduleId}`);
  }

  async activate(scheduleId: string): Promise<void> {
    this.logger.warn(`activate stub — BLOCK 2 impl pending. scheduleId=${scheduleId}`);
  }

  async delete(scheduleId: string): Promise<void> {
    this.logger.warn(`delete stub — BLOCK 2 impl pending. scheduleId=${scheduleId}`);
  }
}
