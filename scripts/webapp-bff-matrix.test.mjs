// WIN-294 — mutation / negative controls for the webapp/BFF census.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serverExports, census, EXPECTED_ENTRYPOINTS } from "./webapp-bff-matrix.mjs";

test("serverExports detects loader and action; hiding one drops the signal", () => {
  const both = serverExports(
    `export async function loader(){}\nexport const action = async () => {};`
  );
  assert.deepEqual(both, { loader: true, action: true });
  const hiddenAction = serverExports(`export async function loader(){}`);
  assert.deepEqual(hiddenAction, { loader: true, action: false });
  const none = serverExports(`export default function Page(){ return null; }`);
  assert.deepEqual(none, { loader: false, action: false });
});

test("MUTATION: hiding a BFF entrypoint lowers the count (drift is detectable)", () => {
  // census() reads the live tree; prove it responds to a mutated file list by
  // exercising the pure counter on a controlled fixture set via serverExports.
  const files = [
    `export function loader(){}\nexport function action(){}`, // 2
    `export function loader(){}`, // 1
    `export default function(){}`, // 0
  ];
  const count = (srcs) =>
    srcs.reduce((n, s) => {
      const { loader, action } = serverExports(s);
      return n + (loader ? 1 : 0) + (action ? 1 : 0);
    }, 0);
  assert.equal(count(files), 3);
  // hide the action in the first file
  const mutated = [`export function loader(){}`, ...files.slice(1)];
  assert.equal(count(mutated), 2, "removing an action must lower the entrypoint count");
});

test("BASELINE: the live webapp reconciles to the expected 117 entrypoints", () => {
  const c = census();
  assert.equal(c.loaders + c.actions, c.entrypoints);
  assert.equal(
    c.entrypoints,
    EXPECTED_ENTRYPOINTS,
    `expected ${EXPECTED_ENTRYPOINTS} BFF entrypoints, source has ${c.entrypoints} (${c.loaders} loaders + ${c.actions} actions)`
  );
});
