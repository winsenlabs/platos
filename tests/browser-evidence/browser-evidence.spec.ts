import { createHash } from "node:crypto";
import { test, expect } from "./auth.fixture";
import {
  VISUAL_MODES,
  capabilityPath,
  expectedCapabilityPathname,
  loadBrowserCapabilities,
  loadFixtureManifest,
  type VisualMode,
} from "./contracts";
import {
  SanitizedTrace,
  evidencePaths,
  exercisePagination,
  performMutation,
  secretSafeScreenshot,
  verifyKeyboardFocus,
  verifyPermissionState,
  writeCellEvidence,
  type CellEvidence,
} from "./evidence-helpers";

const capabilities = loadBrowserCapabilities();
const fixture = loadFixtureManifest();
const alpha = fixture.scopes.find(({ key }) => key === "alpha");
if (!alpha) throw new Error("Canonical browser fixture lacks Alpha scope");

test.describe.configure({ mode: "serial" });

for (const capability of capabilities) {
  test(`${capability.capabilityId} authenticated browser evidence`, async ({
    page,
    browser,
    operatorSessions,
    baseURL,
  }, testInfo) => {
    if (!baseURL) throw new Error("Playwright baseURL is required");
    const mode = testInfo.project.name as VisualMode;
    expect(VISUAL_MODES).toContain(mode);
    const paths = evidencePaths(capability.capabilityId, mode);
    const trace = new SanitizedTrace();
    const target = capabilityPath(capability, alpha);
    const absoluteTarget = new URL(target, baseURL).toString();
    const expectedPathname = expectedCapabilityPathname(capability, alpha);
    const mutationHere = capability.mutation && mode === "desktop-light";
    const paginationHere = capability.pagination && mode === "desktop-light";
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("Browser evidence requires a fixed project viewport");
    const cell: CellEvidence = {
      schemaVersion: 1,
      capabilityId: capability.capabilityId,
      currentRoute: capability.currentRoute,
      visualMode: mode,
      visual: {
        device: mode.startsWith("desktop-") ? "desktop" : "mobile",
        colorScheme: mode.endsWith("-dark") ? "dark" : "light",
        viewport,
      },
      status: "failed",
      route: {
        requestedPathname: new URL(absoluteTarget).pathname,
        expectedPathname,
        finalPathname: "",
        authenticated: true,
        deepLinkRefresh: false,
        httpStatus: 0,
        reloadHttpStatus: 0,
      },
      auth: { ...operatorSessions.metadata },
      keyboard: { required: capability.interactive, focused: false },
      permission: { kind: "public-contract", verified: false },
      pagination: {
        required: capability.pagination,
        performed: false,
        ...(capability.pagination && !paginationHere
          ? { delegatedMode: "desktop-light" as const }
          : {}),
        pages: [],
      },
      mutation: {
        required: capability.mutation,
        performed: false,
        hardReloadReadBack: false,
        handler: capability.mutationHandler,
        ...(capability.mutation && !mutationHere
          ? { delegatedMode: "desktop-light" as const }
          : {}),
      },
      artifacts: { screenshot: paths.screenshot, trace: paths.trace },
    };

    let failure: unknown;
    try {
      await operatorSessions.loadCookie(page.context(), "alpha");
      const response = await trace.step("authenticated-deep-link", page, () =>
        page.goto(absoluteTarget, { waitUntil: "networkidle" })
      );
      const status = response?.status() ?? 0;
      trace.http("authenticated-response", page, status);
      expect(status, `${capability.capabilityId} returned the wrong successful status`).toBe(
        capability.navigationContract.expectedHttpStatus
      );
      expect(
        new URL(page.url()).pathname,
        `${capability.capabilityId} redirected to login`
      ).not.toMatch(/^\/login(?:\/|$)/);
      expect(
        new URL(page.url()).pathname,
        `${capability.capabilityId} reached the wrong canonical route`
      ).toBe(expectedPathname);
      expect(
        await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches),
        `${mode} did not apply its declared color scheme`
      ).toBe(mode.endsWith("-dark"));
      cell.route.httpStatus = status;
      cell.route.finalPathname = new URL(page.url()).pathname;

      await trace.step("deep-link-hard-refresh", page, async () => {
        const refreshed = await page.reload({ waitUntil: "networkidle" });
        const reloadStatus = refreshed?.status() ?? 0;
        expect(reloadStatus, `${capability.capabilityId} reload returned the wrong status`).toBe(
          capability.navigationContract.expectedHttpStatus
        );
        expect(
          new URL(page.url()).pathname,
          `${capability.capabilityId} reload drifted from the canonical route`
        ).toBe(expectedPathname);
        cell.route.reloadHttpStatus = reloadStatus;
        cell.route.finalPathname = new URL(page.url()).pathname;
      });
      cell.route.deepLinkRefresh = true;

      if (capability.interactive) {
        cell.keyboard.focused = await trace.step("keyboard-focus", page, () =>
          verifyKeyboardFocus(page)
        );
      }

      cell.permission = await trace.step("permission-error-state", page, () =>
        verifyPermissionState({
          browser,
          capability,
          alphaPath: absoluteTarget,
          alphaScope: alpha,
          loadBetaCookie: (context) => operatorSessions.loadCookie(context, "beta"),
        })
      );

      if (paginationHere) {
        const pagination = await trace.step(
          "pagination-first-middle-final-where-applicable",
          page,
          () => exercisePagination(page, absoluteTarget, capability)
        );
        cell.pagination.totalPages = pagination.totalPages;
        cell.pagination.pages = [...pagination.pages];
        cell.pagination.rowIdentitySha256 = pagination.rowIdentitySha256;
        cell.pagination.performed = true;
      }

      if (mutationHere) {
        const marker = `win234-${createHash("sha256")
          .update(`${capability.capabilityId}:${mode}`)
          .digest("hex")
          .slice(0, 12)}`;
        cell.mutation.witness = await trace.step("real-browser-mutation-read-back", page, () =>
          performMutation({ page, capability, scope: alpha, marker })
        );
        cell.mutation.performed = true;
        cell.mutation.hardReloadReadBack = true;
      }

      cell.status = "passed";
    } catch (error) {
      failure = error;
      cell.error = {
        name: error instanceof Error ? error.name : "UnknownError",
        message: "Browser evidence cell failed; inspect the secret-sanitized trace and screenshot",
      };
    } finally {
      await secretSafeScreenshot(page, paths.screenshot).catch(() => undefined);
      await writeCellEvidence(cell, trace);
    }
    if (failure) throw failure;
  });
}
