-- PIFSP-25: Per-tool MCP ACL

CREATE TABLE "PlatosEntityMcpToolAcl" (
    "id" TEXT NOT NULL,
    "entityPk" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "exposed" BOOLEAN NOT NULL DEFAULT false,
    "minIdentityMode" TEXT NOT NULL DEFAULT 'bearer',
    "allowedPatIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopeLabels" TEXT[] DEFAULT ARRAY['mcp:tools']::TEXT[],
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReviewedAt" TIMESTAMP(3),

    CONSTRAINT "PlatosEntityMcpToolAcl_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatosEntityMcpToolAcl_entityPk_toolId_key" ON "PlatosEntityMcpToolAcl"("entityPk", "toolId");
CREATE INDEX "PlatosEntityMcpToolAcl_entityPk_exposed_idx" ON "PlatosEntityMcpToolAcl"("entityPk", "exposed");
