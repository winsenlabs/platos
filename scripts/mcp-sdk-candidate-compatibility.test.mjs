// The MCP SDK candidate compatibility derivation's own tests.
//
// The derivation runs suites against PostgreSQL and Redis, so CI re-derives it
// only where those services exist. These cases need neither: they hold the
// COMMITTED result to the manifests, the lockfile and the suites' sources, and
// they prove the derivation refuses each way a comparison could quietly stop
// comparing — a question one build never answered, a skipped case, a label the
// normaliser did not strip.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  RESULT_PATH,
  SUITES,
  buildOf,
  derive,
  questionOf,
  resolvedVersions,
} from "./mcp-sdk-candidate-compatibility.mjs";

const root = path.resolve(import.meta.dirname, "..");
const committed = JSON.parse(readFileSync(path.join(root, RESULT_PATH), "utf8"));

test("the committed result names the versions the manifests declare and the lockfile resolves", () => {
  const versions = resolvedVersions();
  assert.equal(committed.adopted, versions.adopted);
  assert.equal(committed.candidate, versions.candidate);
  assert.match(committed.candidate, /^1\.30\.\d+$/u);
  assert.notEqual(committed.adopted, committed.candidate);
  assert.match(committed.adoption, /^NOT ADOPTED/u);
});

test("the committed result covers every suite constant, and each suite really asks both builds", () => {
  assert.deepEqual(
    committed.suites.map((suite) => suite.file),
    SUITES.map((suite) => `${suite.root}/${suite.file}`),
  );
  for (const suite of SUITES) {
    const file = path.join(root, suite.root, suite.file);
    assert.ok(existsSync(file), `${suite.file} is gone`);
    // THE SUITE PLUS THE LOCAL FIXTURES IT IMPORTS. A suite may hold its two
    // builds in a sibling `*.test-fixture.ts` — `adapters/dispatch.integration
    // .test.ts` does, because the module-identity joins took it past the
    // max-file-lines budget — so reading the suite file alone would report "does
    // not import the adopted SDK" about a suite that asks both builds on every
    // case. The union is followed ONE level and only for relative specifiers, so
    // a suite cannot satisfy this by importing some unrelated module that happens
    // to name the SDK.
    const sources = [readFileSync(file, "utf8")];
    for (const [, specifier] of sources[0].matchAll(/from "(\.[^"]*\.test-fixture\.js)"/gu)) {
      const fixture = path.join(path.dirname(file), specifier.replace(/\.js$/u, ".ts"));
      assert.ok(existsSync(fixture), `${suite.file} imports ${specifier}, which is not in the tree`);
      sources.push(readFileSync(fixture, "utf8"));
    }
    const source = sources.join("\n");
    assert.match(source, /from "@modelcontextprotocol\/sdk\//u, `${suite.file} does not import the adopted SDK`);
    assert.match(source, /from "@modelcontextprotocol\/sdk-candidate\//u, `${suite.file} does not import the candidate`);
    const questions = committed.questions.filter((row) => row.suite === `${suite.root}/${suite.file}`);
    assert.ok(questions.length > 0, `${suite.file} contributed no question asked of both builds`);
  }
  assert.equal(committed.totals.questions, committed.questions.length);
  assert.equal(committed.verdict, "compatible");
});

test("both spellings of a build label the suites use reduce to one question", () => {
  const pairs = [
    ["x adopted SDK -> platform server over legacy-sse y", "x candidate SDK -> platform server over legacy-sse y"],
    ["returns what the 'adopted' SDK server answered", "returns what the 'candidate' SDK server answered"],
    ["pool key ('adopted' SDK server)", "pool key ('candidate' SDK server)"],
  ];
  for (const [adopted, candidate] of pairs) {
    assert.equal(buildOf(adopted), "adopted");
    assert.equal(buildOf(candidate), "candidate");
    assert.equal(questionOf(adopted), questionOf(candidate));
  }
  assert.equal(buildOf("joins the adopted pin and a 1.30.x candidate"), null);
  assert.equal(buildOf("a recorded non-conformance"), null);
});

const versions = { adopted: "1.26.0", candidate: "1.30.0" };
const suite = "packages/contexts/tools/adapters/dispatch.integration.test.ts";

test("a clean pair is compatible", () => {
  const result = derive({
    ...versions,
    cases: [
      { suite, name: "calls the 'adopted' SDK server", status: "passed" },
      { suite, name: "calls the 'candidate' SDK server", status: "passed" },
      { suite, name: "a shared case", status: "passed" },
    ],
  });
  assert.equal(result.verdict, "compatible");
  assert.deepEqual(result.totals, { questions: 1, adoptedPassed: 1, candidatePassed: 1, sharedCases: 1, sharedPassed: 1 });
});

test("CONTROL: a question the candidate never answered is refused, not counted", () => {
  assert.throws(
    () => derive({ ...versions, cases: [{ suite, name: "calls the 'adopted' SDK server", status: "passed" }] }),
    /answered by one build only/u,
  );
});

test("CONTROL: a skipped case is refused, because a skip is not evidence", () => {
  assert.throws(
    () =>
      derive({
        ...versions,
        cases: [
          { suite, name: "calls the 'adopted' SDK server", status: "passed" },
          { suite, name: "calls the 'candidate' SDK server", status: "skipped" },
        ],
      }),
    /did not execute/u,
  );
});

test("CONTROL: a failing candidate answer, or a failing shared case, makes the verdict incompatible", () => {
  const candidateFails = derive({
    ...versions,
    cases: [
      { suite, name: "calls the 'adopted' SDK server", status: "passed" },
      { suite, name: "calls the 'candidate' SDK server", status: "failed" },
    ],
  });
  assert.equal(candidateFails.verdict, "incompatible");
  const sharedFails = derive({
    ...versions,
    cases: [
      { suite, name: "calls the 'adopted' SDK server", status: "passed" },
      { suite, name: "calls the 'candidate' SDK server", status: "passed" },
      { suite, name: "a shared case", status: "failed" },
    ],
  });
  assert.equal(sharedFails.verdict, "incompatible");
});

test("CONTROL: a matrix with no pair at all is refused", () => {
  assert.throws(() => derive({ ...versions, cases: [{ suite, name: "a shared case", status: "passed" }] }), /no question/u);
});
