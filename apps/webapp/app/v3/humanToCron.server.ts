import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

export const HumanToCronResult = z.object({
  isValid: z.boolean(),
  cron: z.string().optional(),
  error: z.string().optional(),
});

export type HumanToCronResult = z.infer<typeof HumanToCronResult>;

export const humanToCronSupported = typeof env.OPENAI_API_KEY === "string";

/**
 * PRELAUNCH-A2-23 (follow-up 2026-05-04) — migrated from the direct
 * `openai@4` SDK to AI SDK v6's `generateObject` with a Zod schema. Removes
 * the only consumer of the direct `openai` dep on the webapp; the dep can
 * now be dropped from `apps/webapp/package.json`.
 *
 * Behavioural diff vs. the previous chat.completions implementation:
 *   - structured output is enforced via the Zod schema rather than parsed
 *     after the fact from a JSON-mode response.
 *   - we now use `gpt-4o-mini` (the AI SDK's default light reasoning model)
 *     since `gpt-3.5-turbo-1106` is end-of-life on the SDK shape and offers
 *     no advantages for this task.
 *   - `userId` is plumbed through `experimental_telemetry.metadata.userId`
 *     so the per-user trace continues to work in the AI SDK pipeline.
 */
export async function humanToCron(message: string, userId: string): Promise<HumanToCronResult> {
  if (!humanToCronSupported) {
    return {
      isValid: false,
      error: "OpenAI API key is not set",
    };
  }

  try {
    const result = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: HumanToCronResult,
      system: `You are a helpful assistant who will turn natural language into a valid CRON expression.

The version of CRON that we use is an extension of the minimal.

*    *    *    *    *
┬    ┬    ┬    ┬    ┬
│    │    │    │    |
│    │    │    │    └ day of week (0 - 7, 1L - 7L) (0 or 7 is Sun)
│    │    │    └───── month (1 - 12)
│    │    └────────── day of month (1 - 31, L)
│    └─────────────── hour (0 - 23)
└──────────────────── minute (0 - 59)

Supports mixed use of ranges and range increments (W character not supported currently).

Return:
  - { "isValid": true, "cron": "<EXPRESSION>" } when the request is valid.
  - { "isValid": false, "error": "<reason>" } when the request can't yield a valid cron.`,
      prompt: `What is a valid CRON expression for this: ${message}`,
      experimental_telemetry: {
        isEnabled: true,
        metadata: {
          feature: "human-to-cron",
          userId,
        },
      },
    });

    logger.debug("humanToCron AI SDK response", { object: result.object });

    return result.object;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    logger.error("humanToCron generateObject failed", { error: errorMessage });
    return {
      isValid: false,
      error: `AI request failed: ${errorMessage}`,
    };
  }
}
