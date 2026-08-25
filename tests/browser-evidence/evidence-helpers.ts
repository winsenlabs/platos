import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  artifactRoot,
  relativeArtifactPath,
  type BrowserCapability,
  type ManifestScope,
  type VisualMode,
} from "./contracts";

type TraceStep = {
  name: string;
  status: "passed" | "failed";
  pathname: string;
  httpStatus?: number;
  detail?: string;
};

export type CellEvidence = {
  schemaVersion: 1;
  capabilityId: string;
  currentRoute: string;
  visualMode: VisualMode;
  visual: {
    device: "desktop" | "mobile";
    colorScheme: "light" | "dark";
    viewport: { width: number; height: number };
  };
  status: "passed" | "failed";
  route: {
    requestedPathname: string;
    expectedPathname: string;
    finalPathname: string;
    authenticated: true;
    deepLinkRefresh: boolean;
    httpStatus: number;
    reloadHttpStatus: number;
  };
  auth: {
    alpha: boolean;
    beta: boolean;
    issuance: "server-side-real-session";
    serialization: "commitOperatorSession";
    cookiePersistence: false;
  };
  keyboard: { required: boolean; focused: boolean };
  permission: {
    kind: "cross-tenant-denied" | "unauthenticated-denied" | "public-contract";
    verified: boolean;
  };
  pagination: {
    required: boolean;
    performed: boolean;
    delegatedMode?: "desktop-light";
    totalPages?: number;
    pages: Array<"first" | "middle" | "final">;
    rowIdentitySha256?: { first: string; middle: string; final: string };
  };
  mutation: {
    required: boolean;
    performed: boolean;
    hardReloadReadBack: boolean;
    delegatedMode?: "desktop-light";
    handler?: string;
    witness?: {
      kind: "id" | "revision" | "marker";
      identitySha256: string;
      intendedFieldSha256: string;
      preActionFieldSha256: string;
      postActionFieldSha256: string;
      postReloadFieldSha256: string;
      preActionPayloadSha256: string;
      postActionPayloadSha256: string;
      postReloadPayloadSha256: string;
    };
  };
  artifacts: { screenshot: string; trace: string };
  error?: { name: string; message: string };
};

export class SanitizedTrace {
  readonly steps: TraceStep[] = [];

  async step<T>(name: string, page: Page, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      this.steps.push({ name, status: "passed", pathname: safePathname(page.url()) });
      return result;
    } catch (error) {
      this.steps.push({
        name,
        status: "failed",
        pathname: safePathname(page.url()),
        detail: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  http(name: string, page: Page, httpStatus: number) {
    this.steps.push({ name, status: "passed", pathname: safePathname(page.url()), httpStatus });
  }
}

function safePathname(value: string) {
  try {
    return new URL(value).pathname;
  } catch {
    return "/";
  }
}

export function evidencePaths(capabilityId: string, mode: VisualMode) {
  const stem = `${capabilityId}--${mode}`;
  return {
    cell: relativeArtifactPath("cells", `${stem}.json`),
    screenshot: relativeArtifactPath("screenshots", `${stem}.png`),
    trace: relativeArtifactPath("traces", `${stem}.trace.json`),
  };
}

export async function writeCellEvidence(cell: CellEvidence, trace: SanitizedTrace) {
  const root = artifactRoot();
  const paths = evidencePaths(cell.capabilityId, cell.visualMode);
  await mkdir(path.dirname(path.join(root, paths.cell)), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, paths.cell), `${JSON.stringify(cell, null, 2)}\n`, "utf8"),
    writeFile(
      path.join(root, paths.trace),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "secret-sanitized-browser-trace",
          capabilityId: cell.capabilityId,
          visualMode: cell.visualMode,
          includesRequestHeaders: false,
          includesRequestBodies: false,
          includesCookies: false,
          steps: trace.steps,
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
  ]);
}

export async function secretSafeScreenshot(page: Page, repositoryRelativePath: string) {
  await page.evaluate(() => {
    const secretPattern =
      /(?:plt_(?:mcp|ent)_[A-Za-z0-9_-]+|platos_live_[A-Za-z0-9_-]+|tr_(?:dev|prod|test)_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]{12,}|\b[a-fA-F0-9]{32,}\b)/g;
    const sensitiveName =
      /(?:authorization|bearer|credential|password|private|raw|secret|token|keyHash)/i;
    const replacement = "[REDACTED]";
    const maskContainer = (element: Element) => {
      const container =
        element.closest("code, pre, output, [role=alert], [role=status]") ?? element;
      container.textContent = replacement;
      container.setAttribute("data-browser-evidence-redacted", "true");
    };
    for (const control of document.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input, textarea, select")) {
      const descriptor = [
        control.getAttribute("name"),
        control.getAttribute("id"),
        control.getAttribute("aria-label"),
        control.getAttribute("autocomplete"),
        control instanceof HTMLInputElement ? control.type : "",
      ]
        .filter(Boolean)
        .join(" ");
      const value =
        control instanceof HTMLSelectElement
          ? control.selectedOptions[0]?.textContent ?? control.value
          : control.value;
      secretPattern.lastIndex = 0;
      if (!sensitiveName.test(descriptor) && !secretPattern.test(value)) continue;
      if (control instanceof HTMLSelectElement) {
        const option = document.createElement("option");
        option.textContent = replacement;
        option.value = replacement;
        control.replaceChildren(option);
        control.value = replacement;
      } else {
        control.value = replacement;
        control.setAttribute("value", replacement);
      }
      control.setAttribute("data-browser-evidence-redacted", "true");
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const secretNodes: Element[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
      const text = node.textContent ?? "";
      secretPattern.lastIndex = 0;
      if (secretPattern.test(text) && node.parentElement) secretNodes.push(node.parentElement);
      node = walker.nextNode();
    }
    for (const element of secretNodes) maskContainer(element);
  });
  await page.screenshot({
    path: path.join(artifactRoot(), repositoryRelativePath),
    fullPage: true,
    animations: "disabled",
  });
}

export async function verifyKeyboardFocus(page: Page) {
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active && active !== document.body && active !== document.documentElement);
  });
  expect(focused, "interactive route did not expose a keyboard focus target").toBe(true);
  return focused;
}

export async function verifyPermissionState(args: {
  browser: Browser;
  capability: BrowserCapability;
  alphaPath: string;
  alphaScope: ManifestScope;
  loadBetaCookie(context: import("@playwright/test").BrowserContext): Promise<void>;
}) {
  const protectedShell =
    args.capability.currentRoute.includes("/routes/_app") ||
    args.capability.currentRoute.includes("/routes/account");
  if (args.capability.tenantScope.status === "enforced") {
    const context = await args.browser.newContext();
    try {
      await args.loadBetaCookie(context);
      const page = await context.newPage();
      const target = new URL(args.alphaPath);
      if (!target.pathname.startsWith(`/orgs/${args.alphaScope.organizationSlug}`)) {
        target.pathname = `/orgs/${args.alphaScope.organizationSlug}/projects/${args.alphaScope.projectSlug}/env/${args.alphaScope.environmentSlug}`;
        target.search = "";
      }
      const response = await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
      const deniedByStatus = [403, 404].includes(response?.status() ?? 0);
      const deniedByPage = await page
        .getByText(/forbidden|not found|does not have access|environment not found/i)
        .first()
        .isVisible()
        .catch(() => false);
      expect(deniedByStatus || deniedByPage, "Beta session reached Alpha tenant scope").toBe(true);
      return { kind: "cross-tenant-denied" as const, verified: true };
    } finally {
      await context.close();
    }
  }
  if (protectedShell) {
    const context = await args.browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(args.alphaPath, { waitUntil: "domcontentloaded" });
      expect(new URL(page.url()).pathname).toMatch(/^\/login(?:\/|$)/);
      return { kind: "unauthenticated-denied" as const, verified: true };
    } finally {
      await context.close();
    }
  }
  return { kind: "public-contract" as const, verified: true };
}

export async function exercisePagination(
  page: Page,
  pathname: string,
  capability: BrowserCapability
) {
  const contract = capability.paginationContract;
  if (!contract) throw new Error(`Missing pagination contract for ${capability.capabilityId}`);
  const firstUrl = new URL(pathname, page.url());
  firstUrl.searchParams.set(contract.pageParam, "1");
  firstUrl.searchParams.set(contract.pageSizeParam, "1");
  await page.goto(firstUrl.toString(), { waitUntil: "networkidle" });
  const totalText = await page.locator(contract.totalSelector).first().textContent();
  const totalMatch = totalText?.match(new RegExp(contract.totalPattern, "i"));
  if (!totalMatch)
    throw new Error(`${capability.capabilityId} did not render its contracted total`);
  const total = Number(totalMatch[1].replace(/,/g, ""));
  expect(
    total,
    `${capability.capabilityId} pagination fixture is not dense enough`
  ).toBeGreaterThanOrEqual(contract.minTotal);
  const totalPages = total;
  const pageNumbers = [1, Math.ceil(totalPages / 2), totalPages] as const;
  const labels = ["first", "middle", "final"] as const;
  const identityHashes = {} as Record<(typeof labels)[number], string>;
  const observedIdentitySets: string[][] = [];

  for (let index = 0; index < pageNumbers.length; index += 1) {
    const pageNumber = pageNumbers[index];
    const url = new URL(firstUrl);
    url.searchParams.set(contract.pageParam, String(pageNumber));
    const response = await page.goto(url.toString(), { waitUntil: "networkidle" });
    expect(response?.status(), `${capability.capabilityId} pagination navigation failed`).toBe(200);
    expect(new URL(page.url()).searchParams.get(contract.pageParam)).toBe(String(pageNumber));
    const rows = page.locator(contract.resultSelector);
    expect(
      await rows.count(),
      `${capability.capabilityId} rendered an empty contracted page`
    ).toBeGreaterThan(0);
    const identities: string[] = [];
    for (let rowIndex = 0; rowIndex < (await rows.count()); rowIndex += 1) {
      const identity = rows.nth(rowIndex).locator(contract.rowIdentity.selector).first();
      const value =
        contract.rowIdentity.source === "value"
          ? await identity.inputValue()
          : (await identity.textContent()) ?? "";
      const normalized = value.trim();
      expect(
        normalized,
        `${capability.capabilityId} rendered a row without canonical identity`
      ).not.toBe("");
      identities.push(normalized);
    }
    identities.sort();
    observedIdentitySets.push(identities);
    identityHashes[labels[index]] = createHash("sha256")
      .update(`${JSON.stringify(identities)}\n`)
      .digest("hex");
  }
  expect(new Set(identityHashes ? Object.values(identityHashes) : []).size).toBe(3);
  for (let left = 0; left < observedIdentitySets.length; left += 1) {
    for (let right = left + 1; right < observedIdentitySets.length; right += 1) {
      expect(
        observedIdentitySets[left].some((identity) =>
          observedIdentitySets[right].includes(identity)
        ),
        `${capability.capabilityId} repeated a row across first/middle/final pages`
      ).toBe(false);
    }
  }
  return {
    totalPages,
    pages: labels,
    rowIdentitySha256: identityHashes,
  };
}

async function fillNamed(page: Page, name: string, value: string) {
  const control = page.locator(`[name="${name}"]`).last();
  await expect(control, `missing mutation field ${name}`).toBeVisible();
  await control.fill(value);
}

async function clickSubmit(page: Page, name: RegExp) {
  const button = page.getByRole("button", { name }).last();
  await expect(button, `missing mutation button ${name}`).toBeEnabled();
  await button.click();
  await page.waitForLoadState("networkidle");
}

type WitnessIdentity = {
  kind: "id" | "revision" | "marker";
  locator: Locator;
  source: "text" | "value";
};

type WitnessField = {
  locator: Locator;
  selector: string;
  source: "text" | "value" | "checked" | "attribute";
  attribute?: string;
  canonicalName: string;
};

function hashObservedPayload(value: unknown) {
  return createHash("sha256")
    .update(`${JSON.stringify(value)}\n`)
    .digest("hex");
}

function persistedContainer(identity: Locator) {
  return identity.locator(
    "xpath=ancestor-or-self::*[self::tr or self::article or self::section or self::form or self::li][1]"
  );
}

async function uiPayload(container: Locator) {
  return container.evaluate((element) => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const controls = [
      ...element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        "input, textarea, select"
      ),
    ]
      .filter(
        (control) =>
          !/(?:authorization|bearer|credential|password|private|raw|secret|tokenHash)/i.test(
            control.name
          )
      )
      .map((control) => ({
        name: control.name,
        type: control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
        value:
          control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)
            ? String(control.checked)
            : control.value,
      }))
      .sort((left, right) =>
        `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`)
      );
    const links = [...element.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .map((link) => ({ text: normalize(link.textContent), href: new URL(link.href).pathname }))
      .sort((left, right) =>
        `${left.href}:${left.text}`.localeCompare(`${right.href}:${right.text}`)
      );
    return { text: normalize(element.textContent), controls, links };
  });
}

async function locatorValue(identity: WitnessIdentity) {
  const value =
    identity.source === "value"
      ? await identity.locator.inputValue()
      : (await identity.locator.textContent()) ?? "";
  const normalized = value.replace(/\s+/g, " ").trim();
  expect(normalized, "persisted UI witness has no canonical identity").not.toBe("");
  return normalized;
}

async function fieldValue(field: WitnessField) {
  let value: string;
  switch (field.source) {
    case "value":
      value = await field.locator.inputValue();
      break;
    case "checked":
      value = String(await field.locator.isChecked());
      break;
    case "attribute":
      if (!field.attribute) throw new Error(`${field.canonicalName} lacks its witness attribute`);
      value = (await field.locator.getAttribute(field.attribute)) ?? "";
      break;
    case "text":
      value = (await field.locator.textContent()) ?? "";
      break;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  expect(normalized, `${field.canonicalName} has no canonical UI value`).not.toBe("");
  return normalized;
}

async function observedIdentity(page: Page, identity: WitnessIdentity, observedValue: string) {
  if (identity.source === "text") {
    const exact = page.getByText(observedValue, { exact: true }).first();
    await expect(exact, "canonical UI identity disappeared").toBeVisible();
    return exact;
  }
  const name = await identity.locator.getAttribute("name");
  if (!name) throw new Error("Value-based persisted witness lacks a control name");
  const candidates = page.locator(`[name="${name}"]`);
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if ((await candidate.inputValue()) === observedValue) return candidate;
  }
  throw new Error(`Canonical UI lost the observed ${name} identity`);
}

function fieldInContainer(container: Locator, field: WitnessField): WitnessField {
  return { ...field, locator: container.locator(field.selector).first() };
}

async function persistedUiWitness(args: {
  page: Page;
  identity: WitnessIdentity;
  field: WitnessField;
  mutate(): Promise<void>;
}) {
  const { page, identity, field, mutate } = args;
  if (identity.source === "value") await expect(identity.locator).toBeAttached();
  else await expect(identity.locator).toBeVisible();
  await expect(
    field.locator,
    `${field.canonicalName} is not observable before mutation`
  ).toBeAttached();

  const canonicalIdentity = await locatorValue(identity);
  const preActionField = await fieldValue(field);
  const preActionPayload = await uiPayload(persistedContainer(identity.locator));
  const preActionFieldSha256 = hashObservedPayload(preActionField);
  const preActionPayloadSha256 = hashObservedPayload(preActionPayload);

  await mutate();

  const postIdentity = await observedIdentity(page, identity, canonicalIdentity);
  const postContainer = persistedContainer(postIdentity);
  const postField = fieldInContainer(postContainer, field);
  await expect(
    postField.locator,
    `${field.canonicalName} disappeared after mutation`
  ).toBeAttached();
  const postActionField = await fieldValue(postField);
  const postActionPayload = await uiPayload(postContainer);
  const postActionFieldSha256 = hashObservedPayload(postActionField);
  const postActionPayloadSha256 = hashObservedPayload(postActionPayload);
  expect(postActionFieldSha256, `${field.canonicalName} mutation was a successful no-op`).not.toBe(
    preActionFieldSha256
  );
  expect(postActionPayloadSha256, "mutation did not change the canonical UI payload").not.toBe(
    preActionPayloadSha256
  );

  await page.reload({ waitUntil: "networkidle" });
  const reloadIdentity = await observedIdentity(page, identity, canonicalIdentity);
  const reloadContainer = persistedContainer(reloadIdentity);
  const reloadField = fieldInContainer(reloadContainer, field);
  await expect(
    reloadField.locator,
    `${field.canonicalName} disappeared after hard reload`
  ).toBeAttached();
  const postReloadFieldSha256 = hashObservedPayload(await fieldValue(reloadField));
  const postReloadPayloadSha256 = hashObservedPayload(await uiPayload(reloadContainer));
  expect(postReloadFieldSha256, "hard reload changed the intended persisted field").toBe(
    postActionFieldSha256
  );
  expect(postReloadPayloadSha256, "hard reload changed the canonical post-action UI payload").toBe(
    postActionPayloadSha256
  );

  return {
    kind: identity.kind,
    identitySha256: hashObservedPayload(canonicalIdentity),
    intendedFieldSha256: hashObservedPayload(field.canonicalName),
    preActionFieldSha256,
    postActionFieldSha256,
    postReloadFieldSha256,
    preActionPayloadSha256,
    postActionPayloadSha256,
    postReloadPayloadSha256,
  };
}

async function createdUiWitness(args: { page: Page; marker: string; mutate(): Promise<void> }) {
  const { page, marker, mutate } = args;
  const before = page.getByText(marker, { exact: true });
  expect(await before.count(), "created marker already existed before mutation").toBe(0);
  const preActionFieldSha256 = hashObservedPayload({ present: false });
  const preActionPayloadSha256 = hashObservedPayload({ identityPresent: false });

  await mutate();

  const postMarker = page.getByText(marker, { exact: true }).first();
  await expect(postMarker, "mutation did not render its intended marker").toBeVisible();
  const observedMarker = ((await postMarker.textContent()) ?? "").replace(/\s+/g, " ").trim();
  expect(observedMarker).not.toBe("");
  const postActionFieldSha256 = hashObservedPayload(observedMarker);
  const postActionPayloadSha256 = hashObservedPayload(
    await uiPayload(persistedContainer(postMarker))
  );
  expect(postActionFieldSha256, "created marker mutation was a successful no-op").not.toBe(
    preActionFieldSha256
  );
  expect(postActionPayloadSha256, "created marker did not change canonical UI state").not.toBe(
    preActionPayloadSha256
  );

  await page.reload({ waitUntil: "networkidle" });
  const reloadMarker = page.getByText(observedMarker, { exact: true }).first();
  await expect(reloadMarker, "hard reload lost the created marker").toBeVisible();
  const postReloadFieldSha256 = hashObservedPayload(
    ((await reloadMarker.textContent()) ?? "").replace(/\s+/g, " ").trim()
  );
  const postReloadPayloadSha256 = hashObservedPayload(
    await uiPayload(persistedContainer(reloadMarker))
  );
  expect(postReloadFieldSha256).toBe(postActionFieldSha256);
  expect(postReloadPayloadSha256).toBe(postActionPayloadSha256);

  return {
    kind: "marker" as const,
    identitySha256: hashObservedPayload(observedMarker),
    intendedFieldSha256: hashObservedPayload("created-marker"),
    preActionFieldSha256,
    postActionFieldSha256,
    postReloadFieldSha256,
    preActionPayloadSha256,
    postActionPayloadSha256,
    postReloadPayloadSha256,
  };
}

function hiddenId(container: Locator, name: string): WitnessIdentity {
  return {
    kind: "id",
    locator: container.locator(`input[name="${name}"]`).first(),
    source: "value",
  };
}

function textIdentity(locator: Locator, kind: WitnessIdentity["kind"] = "marker"): WitnessIdentity {
  return { kind, locator, source: "text" };
}

function controlField(
  container: Locator,
  name: string,
  source: WitnessField["source"] = "value"
): WitnessField {
  const selector = `[name="${name}"]`;
  return { locator: container.locator(selector).first(), selector, source, canonicalName: name };
}

async function submitForm(page: Page, form: Locator, buttonName: RegExp) {
  const button = form.getByRole("button", { name: buttonName }).first();
  await expect(button).toBeEnabled();
  await button.click();
  await page.waitForLoadState("networkidle");
}

async function existingTokenForm(page: Page, intent: "revoke" | "token-revoke") {
  const form = page
    .locator(`form:has(input[name="intent"][value="${intent}"])`)
    .filter({
      has: page.getByRole("button", { name: /^revoke$/i }),
    })
    .first();
  await expect(form, `missing active ${intent} token row`).toBeVisible();
  return form;
}

export async function performMutation(args: {
  page: Page;
  capability: BrowserCapability;
  scope: ManifestScope;
  marker: string;
}) {
  const { page, capability, scope, marker } = args;
  switch (capability.mutationHandler) {
    case "entity-create":
      return createdUiWitness({
        page,
        marker,
        mutate: async () => {
          const credentialReference = "WIN235_BROWSER_REFERENCE";
          await fillNamed(page, "entityId", marker);
          await fillNamed(page, "displayName", marker);
          await page.locator('[name="connectionKind"]').selectOption("mcp");
          await page.locator('[name="transport"]').selectOption("hosted-composio");
          await fillNamed(page, "credsSecretKey", credentialReference);
          const actionPathname = new URL(page.url()).pathname;
          const actionResponsePromise = page.waitForResponse((response) => {
            const request = response.request();
            return (
              request.method() === "POST" && new URL(response.url()).pathname === actionPathname
            );
          });
          await clickSubmit(page, /connect|register|create/i);
          const actionResponse = await actionResponsePromise;
          expect(actionResponse.status(), "Entity registration action did not succeed").toBe(200);
          const actionPayload = (await actionResponse.json()) as {
            ok?: boolean;
            result?: { mcpClient?: { credsSecretKey?: string | null } | null };
          };
          expect(actionPayload.ok, "Entity registration action returned a failure payload").toBe(
            true
          );
          expect(
            actionPayload.result?.mcpClient?.credsSecretKey,
            "Entity registration response lost the bare MCP credential reference"
          ).toBe(credentialReference);
          const entitiesPath =
            `/orgs/${scope.organizationSlug}/projects/${scope.projectSlug}` +
            `/env/${scope.environmentSlug}/agent-entities`;
          await page.goto(new URL(entitiesPath, page.url()).toString(), {
            waitUntil: "networkidle",
          });
          const createdRow = page
            .getByText(marker, { exact: true })
            .first()
            .locator("xpath=ancestor::tr[1]");
          await expect(createdRow, "created Entity row was not persisted").toBeVisible();
          await expect(
            createdRow.getByText(credentialReference, { exact: true }),
            "persisted Entity row lost the bare MCP credential reference"
          ).toBeVisible();
          await expect
            .poll(
              async () => {
                await page.reload({ waitUntil: "networkidle" });
                return createdRow.getByText("connected", { exact: true }).count();
              },
              { message: "persisted Entity never reached its terminal connected status" }
            )
            .toBe(1);
          await expect(
            createdRow.getByText(credentialReference, { exact: true }),
            "terminal Entity read-back lost the bare MCP credential reference"
          ).toBeVisible();
        },
      });
    case "attachment-upload": {
      return createdUiWitness({
        page,
        marker,
        mutate: async () => {
          const filename = `${marker}.txt`;
          const input = page.locator('input[type="file"]').first();
          await input.setInputFiles({
            name: filename,
            mimeType: "text/plain",
            buffer: Buffer.from(marker),
          });
          await clickSubmit(page, /upload selected file/i);
          await expect(
            page.getByText(filename, { exact: true }).first(),
            "attachment upload did not reach canonical UI read-back"
          ).toBeVisible();
          await page
            .locator("select")
            .filter({ has: page.locator('option[value="collect"]') })
            .selectOption("collect");
          await page.getByPlaceholder(/Message /).fill(marker);
          const expectedThreadId = new URL(page.url()).searchParams.get("threadId");
          expect(expectedThreadId, "uploaded attachment lost its reserved Thread identity").toMatch(
            /^[A-Za-z0-9_-]{1,100}$/
          );
          const actionPathname = new URL(page.url()).pathname;
          const completionResponsePromise = page.waitForResponse((response) => {
            const request = response.request();
            return (
              request.method() === "POST" && new URL(response.url()).pathname === actionPathname
            );
          });
          await clickSubmit(page, /^send$/i);
          const completionResponse = await completionResponsePromise;
          expect(completionResponse.status(), "collected attachment Turn did not succeed").toBe(
            200
          );
          const completionPayload = (await completionResponse.json()) as {
            ok?: boolean;
            result?: { threadId?: string; messageId?: string };
          };
          expect(completionPayload.ok, "collected attachment Turn returned a failure payload").toBe(
            true
          );
          expect(
            completionPayload.result?.threadId,
            "collected attachment Turn lost its canonical Thread identity"
          ).toBe(expectedThreadId);
          expect(
            completionPayload.result?.messageId,
            "collected attachment Turn did not reach authoritative persistence"
          ).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
        },
      });
    }
    case "message-rating": {
      const button = page.getByRole("button", { name: /useful|thumbs up/i }).first();
      await expect(button).toBeEnabled();
      const article = button.locator("xpath=ancestor::article[1]");
      const identity = {
        kind: "id" as const,
        locator: article.locator("code").first(),
        source: "text" as const,
      };
      return persistedUiWitness({
        page,
        identity,
        field: {
          locator: button,
          selector: 'button:has-text("Useful")',
          source: "attribute",
          attribute: "aria-pressed",
          canonicalName: "message-rating",
        },
        mutate: async () => {
          await button.click();
          await page.waitForLoadState("networkidle");
        },
      });
    }
    case "postman-create":
      return createdUiWitness({
        page,
        marker,
        mutate: async () => {
          await fillNamed(page, "name", marker);
          await fillNamed(page, "simulateUserId", scope.endUserId);
          await clickSubmit(page, /create template/i);
        },
      });
    case "postman-execute":
      return createdUiWitness({
        page,
        marker,
        mutate: async () => {
          if ((await page.locator('[name="message"]').count()) === 0) {
            await fillNamed(page, "name", `${marker}-template`);
            await fillNamed(page, "simulateUserId", scope.endUserId);
            await clickSubmit(page, /create template/i);
          }
          await fillNamed(page, "message", marker);
          await clickSubmit(page, /execute one turn/i);
          await page.getByRole("link", { name: /open persisted thread/i }).click();
          await page.waitForLoadState("networkidle");
        },
      });
    case "toggle-button": {
      const button = page.getByRole("button", { name: /enable mapping|disable mapping/i }).first();
      const form = button.locator("xpath=ancestor::form[1]");
      const identity = hiddenId(form, "toolId");
      return persistedUiWitness({
        page,
        identity,
        field: controlField(form, "enabled"),
        mutate: async () => {
          await button.click();
          await page.waitForLoadState("networkidle");
        },
      });
    }
    case "access-key-origins": {
      const form = page.locator('form:has([name="origins"])').first();
      const origins = form.locator('[name="origins"]');
      return persistedUiWitness({
        page,
        identity: textIdentity(form.getByRole("heading", { name: /allowed browser origins/i })),
        field: controlField(form, "origins"),
        mutate: async () => {
          await origins.fill(`https://${marker}.example.test`);
          await submitForm(page, form, /save.*origin/i);
        },
      });
    }
    case "access-key-rotate": {
      const section = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: /hash-only credential/i }) })
        .first();
      const rotate = page.getByRole("button", { name: /generate key|rotate key/i });
      return persistedUiWitness({
        page,
        identity: textIdentity(section.getByRole("heading", { name: /hash-only credential/i })),
        field: {
          locator: section
            .getByText(/Prefix:/i)
            .locator("code")
            .first(),
          selector: 'p:has-text("Prefix:") code',
          source: "text",
          canonicalName: "access-key-prefix",
        },
        mutate: async () => {
          page.once("dialog", (dialog) => dialog.accept());
          await rotate.click();
          await expect(page.getByText(/copy this key now/i).first()).toBeVisible();
        },
      });
    }
    case "access-key-revoke": {
      const section = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: /hash-only credential/i }) })
        .first();
      return persistedUiWitness({
        page,
        identity: textIdentity(section.getByRole("heading", { name: /hash-only credential/i })),
        field: {
          locator: section
            .locator("span")
            .filter({ hasText: /^Active$/ })
            .first(),
          selector: "span.rounded-full",
          source: "text",
          canonicalName: "access-key-status",
        },
        mutate: async () => {
          page.once("dialog", (dialog) => dialog.accept());
          await clickSubmit(page, /^revoke$/i);
        },
      });
    }
    case "platform-token-create":
      return createdUiWitness({
        page,
        marker,
        mutate: async () => {
          await fillNamed(page, "name", marker);
          await clickSubmit(page, /create and reveal once/i);
        },
      });
    case "platform-token-revoke": {
      const form = await existingTokenForm(page, "revoke");
      const identity = hiddenId(form, "tokenId");
      return persistedUiWitness({
        page,
        identity,
        field: {
          locator: form.getByRole("button", { name: /^revoke$/i }),
          selector: "button",
          source: "text",
          canonicalName: "platform-token-status",
        },
        mutate: async () => {
          page.once("dialog", (dialog) => dialog.accept());
          await submitForm(page, form, /^revoke$/i);
        },
      });
    }
    case "entity-token-create":
      return createdUiWitness({
        page,
        marker,
        mutate: async () => {
          await fillNamed(page, "label", marker);
          await clickSubmit(page, /create and reveal once/i);
        },
      });
    case "entity-token-revoke": {
      const form = await existingTokenForm(page, "token-revoke");
      const identity = hiddenId(form, "tokenId");
      return persistedUiWitness({
        page,
        identity,
        field: {
          locator: form.getByRole("button", { name: /^revoke$/i }),
          selector: "button",
          source: "text",
          canonicalName: "entity-token-status",
        },
        mutate: async () => {
          page.once("dialog", (dialog) => dialog.accept());
          await submitForm(page, form, /^revoke$/i);
        },
      });
    }
    case "mcp-config": {
      const form = page.locator('form:has(input[name="intent"][value="config"])').first();
      await expect(form).toBeVisible();
      const capabilityUsesIdentity = capability.capabilityId === "mcp-combined-identity-modes";
      const control = capabilityUsesIdentity
        ? form.locator('[name="identityMode"]')
        : form.locator('[name="rateLimitPerMinute"]');
      return persistedUiWitness({
        page,
        identity: textIdentity(form.getByRole("heading", { name: /mcp server configuration/i })),
        field: controlField(form, capabilityUsesIdentity ? "identityMode" : "rateLimitPerMinute"),
        mutate: async () => {
          if (capabilityUsesIdentity) {
            const current = await control.inputValue();
            const options = await control
              .locator("option")
              .evaluateAll((entries) => entries.map((entry) => (entry as HTMLOptionElement).value));
            expect(
              options.length,
              "identityMode lacks an alternate persisted value"
            ).toBeGreaterThan(1);
            const next = options[(options.indexOf(current) + 1) % options.length];
            await control.selectOption(next);
          } else {
            const current = Number(await control.inputValue());
            expect(Number.isFinite(current), "rateLimitPerMinute is not numeric").toBe(true);
            await control.fill(String(current >= 10_000 ? current - 1 : current + 1));
          }
          await submitForm(page, form, /save typed mcp config/i);
        },
      });
    }
    case "mcp-tool-acl": {
      const form = page.locator('form:has(input[name="intent"][value="acl-update"])').first();
      await expect(form).toBeVisible();
      const identity = hiddenId(form, "toolId");
      const exposed = form.locator('[name="exposed"]');
      const wasExposed = await exposed.isChecked();
      return persistedUiWitness({
        page,
        identity,
        field: controlField(form, "exposed", "checked"),
        mutate: async () => {
          if (wasExposed) await exposed.uncheck();
          else await exposed.check();
          await submitForm(page, form, /save tool policy/i);
        },
      });
    }
    case "thread-fork":
      return createdUiWitness({
        page,
        marker,
        mutate: async () => {
          await page.locator('[name="upToMessageId"]').selectOption({ index: 1 });
          await fillNamed(page, "title", marker);
          await clickSubmit(page, /fork and open child/i);
        },
      });
    default:
      throw new Error(
        `Missing route-specific persisted interaction handler for ${capability.capabilityId}`
      );
  }
}
