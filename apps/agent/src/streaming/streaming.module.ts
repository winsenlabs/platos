import { Module } from "@nestjs/common";
import { StreamingService } from "./streaming.service";

@Module({
  providers: [StreamingService],
  exports: [StreamingService],
})
export class StreamingModule {}
