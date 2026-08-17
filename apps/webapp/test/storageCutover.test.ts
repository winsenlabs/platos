import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..", "..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("WIN-123 storage cutover closure", () => {
  it("keeps packet and deployment-context upload routes out of the webapp", () => {
    const routeFiles = readdirSync(resolve(repoRoot, "apps/webapp/app/routes"));
    const v3Files = readdirSync(resolve(repoRoot, "apps/webapp/app/v3"));
    const serviceFiles = readdirSync(resolve(repoRoot, "apps/webapp/app/v3/services"));

    expect(routeFiles).not.toContain("api.v2.packets.$.ts");
    expect(routeFiles).not.toContain("api.v1.artifacts.ts");
    expect(v3Files).not.toContain("objectStore.server.ts");
    expect(v3Files).not.toContain("objectStoreClient.server.ts");
    expect(serviceFiles).not.toContain("artifacts.server.ts");
  });

  it("does not retain dead packet or deployment artifact contracts", () => {
    const coreApi = source("packages/core/src/v3/schemas/api.ts");

    expect(coreApi).not.toContain("CreateArtifactRequestBody");
    expect(coreApi).not.toContain("CreateArtifactResponseBody");
    expect(coreApi).not.toContain('z.enum(["deployment_context"])');
  });

  it("keeps legacy objects behind the explicit reconciliation gate", () => {
    const cutoverPhases = source("internal-packages/database/src/cutover-phases.ts");
    const cutoverLedger = source("internal-packages/database/src/cutover-ledger.ts");
    const cutoverPlan = source("docs/win-123-trigger-writer-fence.md");
    const artifactDocs = source("content/docs/artifacts.md");
    const sourceManifest = source("internal-packages/database/src/source-field-manifest.ts");
    const attachmentService = source("apps/webapp/app/services/platosAttachments.server.ts");

    expect(cutoverPhases).toContain('id: "external-analytics-object-rekey"');
    expect(cutoverPhases).toContain(
      'summary: "ClickHouse UUID re-key/swap and object-store reconciliation contracts"'
    );
    expect(cutoverLedger).toMatch(/const exportDropInheritedModels = \[[\s\S]*?"TaskRun"/);
    expect(cutoverPlan).toMatch(/reconcile\s+object-store writes newer than the restoration point/);
    expect(sourceManifest).toContain(
      '["PlatosAgentArtifact", "artifactKey", "COPY", ["Artifact.artifactKey"]]'
    );
    expect(sourceManifest).toContain(
      '["PlatosMessageAttachment", "storageKey", "COPY", ["MessageAttachment.storageKey"]]'
    );
    expect(attachmentService).toContain(
      "new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: row.storageKey })"
    );
    expect(artifactDocs).toContain("`artifactKey` is an opaque persisted handle");
    expect(artifactDocs).toContain("must preserve it exactly");
  });
});
