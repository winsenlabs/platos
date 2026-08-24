import {
  BadRequestException,
  Controller,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Body,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import type { RequestScope } from "../auth/scope.guard";
import { ConversationService } from "../memory/conversation.service";
import {
  AttachmentUploadError,
  AttachmentsService,
  type AttachmentKind,
} from "./attachments.service";

@Controller("api/v1/agent/attachments")
export class AttachmentUploadController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly attachments: AttachmentsService,
  ) {}

  @Post("presigned")
  async presign(
    @Req() req: Request,
    @Body() body: {
      agentId?: string;
      threadId?: string;
      filename?: string;
      mimeType?: string;
      bytes?: number;
      kind?: AttachmentKind;
    },
  ) {
    const scope = (req as Request & { scope?: RequestScope }).scope;
    if (!scope) throw new NotFoundException({ code: "THREAD_NOT_FOUND", message: "Thread not found" });
    const agentId = body?.agentId?.trim();
    const threadId = body?.threadId?.trim();
    if (!agentId || !threadId || !body?.mimeType || !Number.isSafeInteger(body.bytes) || body.bytes! <= 0) {
      throw new BadRequestException({ code: "ATTACHMENT_INVALID", message: "Attachment metadata is invalid" });
    }
    if (body.kind && !["image", "audio", "video", "document"].includes(body.kind)) {
      throw new BadRequestException({ code: "ATTACHMENT_INVALID", message: "Attachment metadata is invalid" });
    }

    const thread = await this.conversations.getThread(threadId, scope);
    if (!thread || thread.agentId !== agentId) {
      throw new NotFoundException({ code: "THREAD_NOT_FOUND", message: "Thread not found" });
    }

    try {
      return await this.attachments.createPresignedUpload({
        scope,
        endUserId: thread.endUserId,
        agentId,
        threadId,
        filename: body.filename,
        mimeType: body.mimeType,
        bytes: body.bytes!,
        kind: body.kind,
      });
    } catch (error) {
      if (!(error instanceof AttachmentUploadError)) throw error;
      const status = error.code === "ATTACHMENT_TOO_LARGE" || error.code === "ATTACHMENT_QUOTA_EXCEEDED"
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : error.code === "ATTACHMENT_STORAGE_UNAVAILABLE"
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.BAD_REQUEST;
      throw new HttpException({ code: error.code, message: error.message }, status);
    }
  }
}
