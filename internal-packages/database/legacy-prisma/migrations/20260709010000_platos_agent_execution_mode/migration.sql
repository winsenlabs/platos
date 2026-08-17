-- Control-plane + trigger substrate refactor: per-agent execution runtime.
-- "direct" = in-process streaming turn (default, unchanged behaviour);
-- "durable" = turn runs as a trigger Session/task.
-- See docs/refactor/platos-trigger-refactor.md.
ALTER TABLE "PlatosAgent" ADD COLUMN "executionMode" TEXT NOT NULL DEFAULT 'direct';
