// WIN-259 — the controls on the emitted-log secret scan.
//
// The runner needs Docker, three containers and a built deployable. Its
// DECISIONS do not, and every one of them is a branch that decides whether a
// green result means anything. These cases drive those branches over strings, so
// the refusals are proven on a machine with no daemon and the runner's own
// failure is never confused with the environment's.
//
// Each case names the failure it exists to catch.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURED_LOG_SETTINGS,
  MINIMUM_SENTINEL_LENGTH,
  PROCESS_STARTED_MESSAGE,
  REQUIRED_MESSAGES,
  allConfigFields,
  encodingsOf,
  observedMessages,
  redactLine,
  refusals,
  scan,
  secretConfigFields,
  sentinelFor,
  uncapturedLogSinkSettings,
} from "./scanner.mjs";

const SECRET = "plant-0123456789abcdef-example";

function corpusWith(...lines) {
  return [
    JSON.stringify({ at: "2026-09-16T00:00:00.000Z", level: "info", message: PROCESS_STARTED_MESSAGE }),
    JSON.stringify({ at: "2026-09-16T00:00:01.000Z", level: "warn", message: "http.request_failed", code: "X" }),
    ...lines,
  ].join("\n");
}

function planted(overrides = {}) {
  return [{ id: "example", value: SECRET, origin: "a request body", reached: true, ...overrides }];
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

test("a value is searched for in every form it can wear crossing a log line", () => {
  const forms = encodingsOf("a b/c");
  assert.deepEqual(forms.map((form) => form.encoding).sort(), ["base64", "base64url", "uri-component", "utf8"]);
  for (const form of forms) assert.ok(form.text.length > 0);
});

test("each encoding is caught on its own, so no single form carries the whole gate", () => {
  for (const form of encodingsOf(SECRET)) {
    const findings = scan(corpusWith(JSON.stringify({ message: "leak", note: form.text })), planted());
    assert.equal(findings.length, 1, `${form.encoding} went uncaught`);
    assert.equal(findings[0]?.encoding, form.encoding);
  }
});

test("a clean corpus yields nothing, so the gate is not simply always red", () => {
  assert.deepEqual(scan(corpusWith(JSON.stringify({ message: "fine", note: "nothing planted here" })), planted()), []);
});

test("the report never prints the secret it found", () => {
  const line = JSON.stringify({ message: "leak", note: SECRET });
  const findings = scan(corpusWith(line), planted());
  assert.equal(findings.length, 1);
  assert.ok(!findings[0]?.excerpt.includes(SECRET), "a gate that prints the value has leaked it into CI's own log");
  assert.match(findings[0]?.excerpt ?? "", /<planted:example>/u);
  assert.equal(redactLine("aXb", "X", "id"), "a<planted:id>b");
});

// ---------------------------------------------------------------------------
// The refusals — the three ways this class of gate goes quietly green
// ---------------------------------------------------------------------------

test("an empty corpus is refused rather than reported clean", () => {
  const failures = refusals({ corpus: "", planted: planted(), sinkSettings: [] });
  assert.match(failures.join("\n"), /a scan over nothing finds nothing/u);
});

test("somebody else's stream is refused: the corpus must be this process's log", () => {
  const failures = refusals({ corpus: '{"message":"unrelated"}', planted: planted(), sinkSettings: [] });
  assert.match(failures.join("\n"), new RegExp(`carries no ${PROCESS_STARTED_MESSAGE} line`, "u"));
});

test("a corpus of lifecycle lines alone is refused: the drive never reached the details channel", () => {
  const lifecycleOnly = JSON.stringify({ message: PROCESS_STARTED_MESSAGE });
  const failures = refusals({ corpus: lifecycleOnly, planted: planted(), sinkSettings: [] });
  assert.match(failures.join("\n"), /never reached the code that writes a request's own details/u);
  assert.ok(REQUIRED_MESSAGES.includes("http.request_failed"));
});

test("planting nothing, or planting what the process never accepted, is refused", () => {
  assert.match(
    refusals({ corpus: corpusWith(), planted: [], sinkSettings: [] }).join("\n"),
    /nothing was planted/u,
  );
  assert.match(
    refusals({ corpus: corpusWith(), planted: planted({ reached: false }), sinkSettings: [] }).join("\n"),
    /never accepted by the process/u,
  );
});

test("a sentinel too short to attribute, or repeated, is refused", () => {
  assert.match(
    refusals({ corpus: corpusWith(), planted: planted({ value: "short" }), sinkSettings: [] }).join("\n"),
    new RegExp(`shorter than ${String(MINIMUM_SENTINEL_LENGTH)} characters`, "u"),
  );
  const twice = [...planted(), { id: "second", value: SECRET, origin: "elsewhere", reached: true }];
  assert.match(refusals({ corpus: corpusWith(), planted: twice, sinkSettings: [] }).join("\n"), /repeats the value of/u);
});

test("a log destination this gate does not read is a failure, not a silence", () => {
  const failures = refusals({ corpus: corpusWith(), planted: planted(), sinkSettings: ["PLATOS_LOG_FILE"] });
  assert.match(failures.join("\n"), /configures a log destination this gate does not capture/u);
});

test("a believable run is believed", () => {
  assert.deepEqual(refusals({ corpus: corpusWith(), planted: planted(), sinkSettings: [] }), []);
});

// ---------------------------------------------------------------------------
// What the configuration contract says
// ---------------------------------------------------------------------------

const GROUP_FIELDS = (group) => [group.anchor, ...group.requiredWithAnchor, ...group.optional];

function section(id, fields) {
  return {
    id,
    groups: [{ id, anchor: fields[0], requiredWithAnchor: fields.slice(1), optional: [] }],
  };
}

test("the plant list is the schema's own secret classification, not a list kept here", () => {
  const sections = [
    section("stores", [
      { name: "PLATOS_STORE_REDIS_URL", kind: "url", secret: true, schemes: ["redis:"] },
      { name: "PLATOS_STORE_REDIS_TLS", kind: "boolean", secret: false },
    ]),
  ];
  const core = [{ name: "PLATOS_LOG_LEVEL", kind: "enum", secret: false }];
  const secrets = secretConfigFields(sections, core, GROUP_FIELDS);
  assert.deepEqual(secrets.map((field) => field.name), ["PLATOS_STORE_REDIS_URL"]);
  assert.equal(allConfigFields(sections, core, GROUP_FIELDS).length, 3);
});

test("LOG is matched as a whole word, so a login URL is not mistaken for a log sink", () => {
  const fields = [
    { name: "PLATOS_LOG_LEVEL" },
    { name: "PLATOS_CHANNELS_EMAIL_LOGIN_URL" },
    { name: "PLATOS_LOG_FILE" },
    { name: "PLATOS_AUDIT_LOG" },
  ];
  assert.deepEqual(uncapturedLogSinkSettings(fields), ["PLATOS_AUDIT_LOG", "PLATOS_LOG_FILE"]);
  assert.deepEqual([...CAPTURED_LOG_SETTINGS], ["PLATOS_LOG_LEVEL"]);
});

test("a sentinel satisfies its own field's constraints, or is refused rather than guessed", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  const hex = sentinelFor({ name: "PLATOS_SECURITY_ENCRYPTION_KEY", kind: "string", pattern: "[0-9a-fA-F]{64}" }, nonce);
  assert.equal(hex.ok, true);
  assert.match(hex.value, /^[0-9a-f]{64}$/u);
  const other = sentinelFor({ name: "PLATOS_CHANNELS_SLACK_SIGNING_SECRET", kind: "string", pattern: "[0-9a-fA-F]{64}" }, nonce);
  assert.notEqual(other.value, hex.value, "two patterned fields must not collide, or a hit cannot be attributed");

  const url = sentinelFor({ name: "PLATOS_STORE_CLICKHOUSE_URL", kind: "url", schemes: ["https:"] }, nonce);
  assert.equal(new URL(url.value).protocol, "https:");

  const long = sentinelFor({ name: "PLATOS_SECURITY_SESSION_SECRET", kind: "string", minimumLength: 64 }, nonce);
  assert.ok(long.value.length >= 64);

  const impossible = sentinelFor({ name: "PLATOS_WEIRD", kind: "string", pattern: "^[A-Z]{3}-[0-9]{9}$" }, nonce);
  assert.equal(impossible.ok, false, "a pattern with no generator must be reported, never silently skipped");
});

test("distinct structured messages are read off the corpus, and unstructured noise is ignored", () => {
  const corpus = [
    "a plain line the framework printed",
    JSON.stringify({ message: "process.started" }),
    JSON.stringify({ message: "http.request_failed" }),
    JSON.stringify({ message: "http.request_failed" }),
    "{ not json",
  ].join("\n");
  assert.deepEqual(observedMessages(corpus), ["process.started", "http.request_failed"]);
});
