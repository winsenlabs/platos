import { z } from "zod";
import { Schema } from "./schemas.js";

// Structural shape of ai's `Schema<T>` (from @ai-sdk/provider-utils), inlined so
// this package never imports ai. ai@7 is ESM-only, and any import of it (even a
// type-only or dynamic `import("ai")` type) trips TS1479 when tshy emits the
// CommonJS dialect. Only `_type` and `validate` are used here.
type AISchemaValidationResult<T> =
  | { success: true; value: T }
  | { success: false; error: unknown };
type AISchema<T> = {
  _type: T;
  validate?: (
    value: unknown,
  ) => AISchemaValidationResult<T> | Promise<AISchemaValidationResult<T>>;
};

export type ToolTaskParameters = z.ZodTypeAny | AISchema<any>;

export type inferToolParameters<PARAMETERS extends ToolTaskParameters> =
  PARAMETERS extends AISchema<any>
    ? PARAMETERS["_type"]
    : PARAMETERS extends z.ZodTypeAny
    ? z.infer<PARAMETERS>
    : never;

export function convertToolParametersToSchema<TToolParameters extends ToolTaskParameters>(
  toolParameters: TToolParameters
): Schema {
  return toolParameters instanceof z.ZodSchema
    ? toolParameters
    : convertAISchemaToTaskSchema(toolParameters);
}

function convertAISchemaToTaskSchema(schema: AISchema<any>): Schema {
  return async (payload: unknown) => {
    const result = await schema.validate?.(payload);

    if (!result) {
      throw new Error("Invalid payload");
    }

    if (!result.success) {
      throw result.error;
    }

    return result.value;
  };
}
