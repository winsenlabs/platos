import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";

export interface ToolAclRow {
  id: string;
  entityPk: string;
  toolId: string;
  toolName: string;
  exposed: boolean;
  minIdentityMode: string;
  allowedPatIds: string[];
  scopeLabels: string[];
  addedAt: Date;
  lastReviewedAt: Date | null;
}

/**
 * What `list()` returns to API callers. Tools that have an ACL row pull
 * straight from the row (real `id`, real `addedAt`). Tools that don't have
 * an ACL row yet — the common case for fresh entities — get a synthetic
 * "default-shaped" row keyed on the mapping id so the frontend has a
 * stable handle to toggle. `addedAt` is null for synthesized rows so the
 * UI can distinguish "never touched" from "operator-set".
 */
export interface ToolAclListRow {
  /** ACL row id when present, otherwise the mapping id (acts as the toggle key). */
  id: string;
  entityPk: string;
  toolId: string;
  toolName: string;
  exposed: boolean;
  minIdentityMode: string;
  allowedPatIds: string[];
  scopeLabels: string[];
  addedAt: Date | null;
  lastReviewedAt: Date | null;
}

/**
 * PIFSP-25 — Tool-level MCP ACL.
 * Default: nothing exposed (safest). Operators opt-in per tool.
 */
@Injectable()
export class McpToolAclService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  /**
   * List the entity's tools with their MCP exposure state.
   *
   * Bug fix: previously this only returned rows from PlatosEntityMcpToolAcl,
   * which is empty until an operator explicitly toggles a tool. Fresh
   * entities therefore showed zero tools on the MCP page even when their
   * tool registry was full — a chicken-and-egg with no toggle target.
   *
   * Now we LEFT-JOIN: every enabled PlatosEntityToolMapping row appears in
   * the response, populated from its ACL row when one exists or a default
   * shape (exposed:false, minIdentityMode:"bearer") when it doesn't. The
   * first toggle creates the real ACL row via upsert.
   *
   * Note on schema: PlatosEntityToolMapping uses `entityId` (FK to
   * PlatosConnectedEntity.id), not `entityPk`. We pass `entityPk` in here
   * because that IS the PlatosConnectedEntity.id — the naming is
   * unfortunate, mirrored from McpEntityController.loadEntity.
   */
  async list(
    entityPk: string,
    options: { exposed?: boolean; search?: string; limit?: number; offset?: number } = {},
  ): Promise<ToolAclListRow[]> {
    // 1. Every enabled tool registered for this entity. We need toolName
    //    which lives on PlatosToolDefinition — join in.
    const mappings: Array<{ id: string; toolId: string; tool: { name: string } }> =
      await this.prisma.platosEntityToolMapping.findMany({
        where: { entityId: entityPk, enabled: true },
        select: { id: true, toolId: true, tool: { select: { name: true } } },
        orderBy: { tool: { name: "asc" } },
      });

    if (mappings.length === 0) return [];

    // 2. Existing ACL rows for this entity. Keyed on the mapping id since
    //    that's what `upsert(entityPk, toolId, …)` writes when the
    //    operator toggles via the patch endpoint.
    const aclRows: ToolAclRow[] = await this.prisma.platosEntityMcpToolAcl.findMany({
      where: { entityPk },
    });
    const aclByToolId = new Map<string, ToolAclRow>(aclRows.map((r) => [r.toolId, r]));

    // 3. Merge — every tool gets a row. Tools without an ACL row get a
    //    synthesized default-shape row so the frontend has a stable
    //    toggle handle (using mapping.id as the row id).
    let merged: ToolAclListRow[] = mappings.map((m) => {
      const existing = aclByToolId.get(m.id);
      if (existing) {
        return {
          id: existing.id,
          entityPk: existing.entityPk,
          toolId: existing.toolId,
          toolName: existing.toolName,
          exposed: existing.exposed,
          minIdentityMode: existing.minIdentityMode,
          allowedPatIds: existing.allowedPatIds,
          scopeLabels: existing.scopeLabels,
          addedAt: existing.addedAt,
          lastReviewedAt: existing.lastReviewedAt,
        };
      }
      // No ACL row yet — default-shaped synthetic row. id == mapping.id so
      // the frontend's toggle PATCH lands on the right toolId.
      return {
        id: m.id,
        entityPk,
        toolId: m.id,
        toolName: m.tool.name,
        exposed: false,
        minIdentityMode: "bearer",
        allowedPatIds: [],
        scopeLabels: ["mcp:tools"],
        addedAt: null,
        lastReviewedAt: null,
      };
    });

    // 4. Apply filters AFTER the merge so a `?exposed=true` query still
    //    returns only the operator-flipped rows, not synthetic defaults.
    if (options.exposed !== undefined) {
      merged = merged.filter((r) => r.exposed === options.exposed);
    }
    if (options.search) {
      const q = options.search.toLowerCase();
      merged = merged.filter((r) => r.toolName.toLowerCase().includes(q));
    }

    // 5. Sort: exposed first, then by name — matches the previous contract.
    merged.sort((a, b) => {
      if (a.exposed !== b.exposed) return a.exposed ? -1 : 1;
      return a.toolName.localeCompare(b.toolName);
    });

    // 6. Pagination — applied last so offset/limit work on the merged set.
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 200;
    return merged.slice(offset, offset + limit);
  }

  /** Get names of all exposed tools for fast allowlist lookup. */
  async getExposedToolNames(entityPk: string): Promise<string[]> {
    const rows = await this.prisma.platosEntityMcpToolAcl.findMany({
      where: { entityPk, exposed: true },
      select: { toolName: true },
    });
    return rows.map((r: { toolName: string }) => r.toolName);
  }

  /** Filter exposed tools by caller identity. */
  filterByIdentity(
    rows: ToolAclRow[],
    caller: { identityMode: string; mcpUserId: string; scopes: string[] },
  ): ToolAclRow[] {
    return rows.filter((acl) => {
      // Identity gate
      if (acl.minIdentityMode === "bearer" && caller.identityMode !== "bearer") return false;
      if (acl.minIdentityMode === "oidc" && caller.identityMode === "anonymous") return false;
      // Allowed PAT gate (bearer only, empty = any)
      if (acl.allowedPatIds.length > 0 && caller.identityMode === "bearer") {
        const patId = caller.mcpUserId.replace("mcp:pat:", "");
        if (!acl.allowedPatIds.includes(patId)) return false;
      }
      // Scope gate
      if (acl.scopeLabels.length > 0 && !acl.scopeLabels.every((s) => caller.scopes.includes(s))) {
        return false;
      }
      return true;
    });
  }

  /** Upsert an ACL entry and sync toolAllowlist. */
  async upsert(
    entityPk: string,
    toolId: string,
    toolName: string,
    addedBy: string,
    data: Partial<Pick<ToolAclRow, "exposed" | "minIdentityMode" | "allowedPatIds" | "scopeLabels">>,
  ): Promise<ToolAclRow> {
    const row = await this.prisma.platosEntityMcpToolAcl.upsert({
      where: { entityPk_toolId: { entityPk, toolId } },
      create: {
        entityPk,
        toolId,
        toolName,
        addedBy,
        exposed: data.exposed ?? false,
        minIdentityMode: data.minIdentityMode ?? "bearer",
        allowedPatIds: data.allowedPatIds ?? [],
        scopeLabels: data.scopeLabels ?? ["mcp:tools"],
      },
      update: {
        ...(data.exposed !== undefined && { exposed: data.exposed }),
        ...(data.minIdentityMode !== undefined && { minIdentityMode: data.minIdentityMode }),
        ...(data.allowedPatIds !== undefined && { allowedPatIds: data.allowedPatIds }),
        ...(data.scopeLabels !== undefined && { scopeLabels: data.scopeLabels }),
      },
    });
    // Sync denormalized toolAllowlist
    await this.syncAllowlist(entityPk);
    return row;
  }

  /** Bulk expose or hide tools. */
  async bulk(
    entityPk: string,
    toolIds: string[],
    action: "expose" | "hide" | "set_identity",
    options: { minIdentityMode?: string; addedBy?: string } = {},
  ): Promise<number> {
    if (toolIds.length === 0) return 0;
    const data: Record<string, unknown> =
      action === "expose" ? { exposed: true } :
      action === "hide" ? { exposed: false } :
      { minIdentityMode: options.minIdentityMode ?? "bearer" };

    const result = await this.prisma.platosEntityMcpToolAcl.updateMany({
      where: { entityPk, toolId: { in: toolIds } },
      data,
    });
    await this.syncAllowlist(entityPk);
    return result.count;
  }

  /** Auto-insert ACL row for a newly registered tool (exposed: false). */
  async autoInsert(entityPk: string, toolId: string, toolName: string): Promise<void> {
    await this.prisma.platosEntityMcpToolAcl.upsert({
      where: { entityPk_toolId: { entityPk, toolId } },
      create: { entityPk, toolId, toolName, addedBy: "system", exposed: false },
      update: {}, // already exists — don't overwrite operator settings
    });
  }

  /** Sync PlatosEntityMcpConfig.toolAllowlist from the ACL table. */
  private async syncAllowlist(entityPk: string): Promise<void> {
    const names = await this.getExposedToolNames(entityPk);
    await this.prisma.platosEntityMcpConfig.updateMany({
      where: { entityPk },
      data: { toolAllowlist: names },
    });
  }
}
