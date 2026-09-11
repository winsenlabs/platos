import { Body, Controller, Post, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { API_VERSION } from "../http/api-surface";
import type { RequestScope } from "../auth/scope.guard";
import { withHeartbeat } from "../shared/async-heartbeat";
import { env } from "../shared/env";
import { StreamingService } from "../streaming/streaming.service";
import { TurnDispatchService } from "./turn-dispatch.service";

/**
 * A USER MESSAGE MAY NOT TRAVEL IN A REQUEST LINE, AND UNTIL NOW IT HAD NO OTHER
 * WAY TO REACH THE STREAM.
 *
 * WHAT WAS WRONG, MEASURED. `api.v1.public.agents.$agentId.chat.stream.ts`
 * validates `message.length <= 20_000` and then puts the whole thing in the
 * UPSTREAM REQUEST LINE — `new URLSearchParams({ message })` appended to
 * `/api/v1/agent/agents/:agentId/chat/stream` — because the only streaming
 * handler was a `@Get` reading `@Query("message")`. A request line is a header,
 * Node's default `maxHeaderSize` is 16 KiB, and URL-encoding a message inflates
 * it further. So a message an unauthenticated guest is TOLD is acceptable is
 * refused by the agent's own HTTP parser with a 431, before any handler on this
 * side runs: the guard passed and the request died upstream, the visitor saw a
 * failure with no explanation, and the turn never existed.
 * `apps/webapp/test/publicGuestBoundary.test.ts` has pinned that behaviour, and
 * the pin has been read as "known" for four stages.
 *
 * WHY A NEW ROUTE AND NOT AN EDIT. The obvious fix is to let `agentChatStream`
 * read the message from a body — and `AgentController` belongs to M3.1 (WIN-261),
 * which is why four stages named this and none moved it. Lowering the BFF's own
 * ceiling instead is not available either: ADR M0.4 §1.3 lists "tighten
 * validation or change a default" under FORCES-MAJOR. The same paragraph lists
 * "add routes/ops" under ADDITIVE-IN-MAJOR, free and invisible. So the message
 * moves out of the request line by gaining a POST of its own, in a controller of
 * its own, and nothing M3.1 owns is touched.
 *
 * IT IS THE SAME OPERATION, NOT A SECOND ONE. Same path, same
 * `TurnDispatchService.streamTurn` chokepoint, same heartbeat interval, same
 * `StreamingService.streamToSSE` writer, same abort wiring on `close`. The ONLY
 * difference is where the message was read from. The security posture is
 * inherited rather than restated, and that is deliberate: `ScopeGuard` derives
 * the agent pin from `/api/v1/agent/agents/:agentId` by REGEX, method-agnostic
 * (`extractAgentIdFromPath`), so a session token scoped to another agent is
 * refused here with `AGENT_SCOPE_MISMATCH` exactly as it is on the GET; and
 * `RateLimitGuard` exempts only `/api/health`, `/test/` and `/metrics`, so this
 * route is inside the limiter by construction rather than by a list.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY. The `X-Platos-Config` per-request override
 * that `AgentController.agentChatStream` parses. Its whitelist parser is private
 * to that controller, copying it would be a second definition of which keys an
 * override may set, and NOTHING in `apps/webapp` sends the header on either chat
 * route — the two callers of this path are the guest/embed proxy and the operator
 * playground, and neither does. A caller that needs the override keeps the GET,
 * which is unchanged. Stated here rather than discovered later.
 */
@Controller({ path: "agent", version: API_VERSION })
export class ChatStreamController {
  constructor(
    private readonly dispatch: TurnDispatchService,
    private readonly streamingService: StreamingService,
  ) {}

  /**
   * SSE streaming chat with the message in the BODY.
   *
   * The sibling `@Get` on this path keeps working and keeps its 20,000-character
   * ceiling; what it cannot do is carry one. `attachmentIds` is an ARRAY here
   * rather than the GET's comma-joined string, because a body has types and a
   * query string does not — and a comma-joined list in a JSON body would be a
   * query-string habit preserved for no reason.
   */
  @Post("agents/:agentId/chat/stream")
  async chatStream(
    @Req() req: Request,
    @Res() res: Response,
    @Param("agentId") agentId: string,
    @Body()
    body: {
      message?: string;
      threadId?: string;
      attachmentIds?: string[];
    },
  ): Promise<void> {
    const message = typeof body?.message === "string" ? body.message : "";
    if (!message) {
      res.status(400).json({ error: "message is required in the request body" });
      return;
    }
    const scope = {
      ...((req as Request & { scope?: RequestScope }).scope ?? {
        organizationId: "unknown",
        projectId: "unknown",
        environmentId: "unknown",
        userId: "unknown",
      }),
      agentId,
    };
    const ac = new AbortController();
    const onClose = () => {
      if (!ac.signal.aborted) ac.abort();
    };
    req.on("close", onClose);
    res.on("close", onClose);

    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        )
      : undefined;

    const rawEvents = this.dispatch.streamTurn(agentId, {
      scope: scope as RequestScope,
      message,
      threadId: typeof body.threadId === "string" ? body.threadId : undefined,
      attachmentIds: attachmentIds !== undefined && attachmentIds.length > 0 ? attachmentIds : undefined,
      abortSignal: ac.signal,
    });
    const heartbeatMs = Math.max(1000, env.PLATOS_STREAM_HEARTBEAT_MS ?? 15_000);
    const events = withHeartbeat(rawEvents, { intervalMs: heartbeatMs, signal: ac.signal });
    await this.streamingService.streamToSSE(events, res);
  }
}
