import { createHash } from "node:crypto";

// WIN-259 — THE EMITTED-LOG HALF OF SECRET SCANNING: the pure part.
//
// `tests/browser-evidence/verify-artifacts.mjs` scans ARTIFACTS. Nothing in this
// tree scanned what the serving process actually PRINTS, which is the half the
// issue records as not met and the half an operator's log aggregator sees.
//
// Everything here is a pure function over strings and specs so the branches that
// decide PASS, FAIL and REFUSE can be controlled without a Docker daemon. The
// runner beside it supplies the real corpus.
//
// THREE WAYS THIS CLASS OF GATE GOES QUIETLY GREEN, AND THE REFUSAL FOR EACH.
//
//   1. It captured nothing. An empty corpus contains no secret, so the scan
//      passes and measures nothing. `refusals` requires the corpus to carry a
//      line the process is KNOWN to emit, so "we captured the log" is an
//      assertion rather than an assumption.
//   2. It planted nothing the system ever saw. Scanning for material that was
//      refused at the door is scanning for a string nobody could have logged.
//      Every planted value must be marked `reached`, and the runner sets that
//      only from a response the process gave.
//   3. It planted something too common to find. A four-character sentinel
//      matches ordinary prose; a repeated one cannot attribute a hit. Planted
//      values must be long and distinct.
//
// AND ONE WAY IT GOES QUIETLY RED-PROOF: scanning only the raw bytes. A value
// that reaches a log through a URL, a JSON string or a base64 envelope is the
// same leak, so `encodingsOf` derives the forms a value can wear and each is
// searched. The encodings are DECLARED, so a reader can see which
// transformations this gate can and cannot see through.

/** A line every core-api process writes at startup. See runtime/lifecycle.ts. */
export const PROCESS_STARTED_MESSAGE = "process.started";

/**
 * Messages the corpus must carry before a clean result means anything.
 *
 * `process.started` says the corpus IS this process's log. `http.request_failed`
 * says the drive reached the code that writes a request's own `details` into a
 * log line — which is the single richest leak channel in this deployable, since
 * `details` is defined as "structured, already-redacted context for logs, never
 * returned to a client". A run that captured only lifecycle lines examined the
 * six lines every process writes whatever it serves, and calling that a clean
 * scan would be the vacuity this file exists to refuse.
 */
export const REQUIRED_MESSAGES = Object.freeze([PROCESS_STARTED_MESSAGE, "http.request_failed"]);

/** Every distinct structured `message` the corpus carries, in first-seen order. */
export function observedMessages(corpus) {
  const seen = [];
  for (const line of String(corpus ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = parsed?.message;
    if (typeof message === "string" && !seen.includes(message)) seen.push(message);
  }
  return seen;
}

/**
 * The forms one secret can wear in a log line.
 *
 * Each carries the transformation that produces it, because a list of opaque
 * strings is a list nobody can audit. `utf8` is the value itself; the rest are
 * the encodings a value picks up crossing a URL, a JSON document or a header.
 */
export function encodingsOf(value) {
  const forms = [
    { encoding: "utf8", text: value },
    { encoding: "uri-component", text: encodeURIComponent(value) },
    { encoding: "json-string", text: JSON.stringify(value).slice(1, -1) },
    { encoding: "base64", text: Buffer.from(value, "utf8").toString("base64") },
    { encoding: "base64url", text: Buffer.from(value, "utf8").toString("base64url") },
  ];
  const seen = new Set();
  return forms.filter((form) => {
    if (form.text === "" || seen.has(form.text)) return false;
    seen.add(form.text);
    return true;
  });
}

/** The shortest a sentinel may be before it starts matching ordinary prose. */
export const MINIMUM_SENTINEL_LENGTH = 16;

/**
 * Why this run may not be believed, if anything.
 *
 * A non-empty return is a REFUSAL, not a leak: the run proved nothing and must
 * exit non-zero saying so, exactly as `twinRun` refuses a vacuous comparison
 * rather than reporting parity.
 */
export function refusals({ corpus, planted, sinkSettings }) {
  const failures = [];
  if (typeof corpus !== "string" || corpus.trim() === "") {
    failures.push("the captured corpus is empty; a scan over nothing finds nothing and proves nothing");
  } else {
    const messages = observedMessages(corpus);
    for (const required of REQUIRED_MESSAGES) {
      if (messages.includes(required)) continue;
      failures.push(
        required === PROCESS_STARTED_MESSAGE
          ? `the captured corpus carries no ${PROCESS_STARTED_MESSAGE} line, so it is not this process's log; ` +
            "finding no secret in somebody else's stream is not evidence"
          : `the captured corpus carries no ${required} line, so the drive never reached the code that writes a ` +
            "request's own details into a log; a scan over lifecycle lines alone is not a scan of what this " +
            `process logs (saw: ${messages.join(", ") || "nothing structured"})`,
      );
    }
  }
  if (!Array.isArray(planted) || planted.length === 0) {
    failures.push("nothing was planted; the scan would be looking for material the run never introduced");
    return failures;
  }
  const values = new Map();
  for (const entry of planted) {
    if (typeof entry?.id !== "string" || entry.id.trim() === "") failures.push("a planted entry has no id");
    if (typeof entry?.value !== "string" || entry.value.length < MINIMUM_SENTINEL_LENGTH) {
      failures.push(
        `planted ${entry?.id ?? "<unnamed>"} is shorter than ${MINIMUM_SENTINEL_LENGTH} characters; a short ` +
          "sentinel matches ordinary text and a hit could not be attributed",
      );
      continue;
    }
    if (entry.reached !== true) {
      failures.push(
        `planted ${entry.id} was never accepted by the process, so nothing could have logged it; ` +
          "a gate that scans for material the system refused at the door measures its own fixture",
      );
    }
    if (values.has(entry.value)) {
      failures.push(`planted ${entry.id} repeats the value of ${values.get(entry.value)}; a hit could not be attributed`);
    }
    values.set(entry.value, entry.id);
  }
  // A sink this gate does not read is a sink a secret can leave by. The runner
  // derives the candidate settings from the configuration schema rather than
  // from memory, so a new one lands here rather than nowhere.
  for (const setting of sinkSettings ?? []) {
    failures.push(
      `${setting} configures a log destination this gate does not capture; extend the capture before trusting it`,
    );
  }
  return failures;
}

/**
 * Every planted value that appears in the corpus, with the encoding it wore.
 *
 * The excerpt is deliberately NOT the matched secret: a gate that prints the
 * value it found has leaked it a second time, into CI's own log. The line is
 * reported with the match replaced by its planted id.
 */
export function scan(corpus, planted) {
  const findings = [];
  const lines = corpus.split("\n");
  for (const entry of planted) {
    for (const form of encodingsOf(entry.value)) {
      for (const [index, line] of lines.entries()) {
        if (!line.includes(form.text)) continue;
        findings.push({
          id: entry.id,
          origin: entry.origin,
          encoding: form.encoding,
          line: index + 1,
          excerpt: redactLine(line, form.text, entry.id),
        });
      }
    }
  }
  return findings;
}

export function redactLine(line, matched, id) {
  const replaced = line.split(matched).join(`<planted:${id}>`);
  return replaced.length > 400 ? `${replaced.slice(0, 400)}…` : replaced;
}

// ---------------------------------------------------------------------------
// What the configuration contract says is a secret, and where it says logs go
// ---------------------------------------------------------------------------

/**
 * Every configuration field the schema itself classifies `secret: true`.
 *
 * DERIVED, never listed. `config/schema.ts` says redaction "is a property of the
 * schema, not of the diagnostic writer's discipline"; this gate takes it at its
 * word and reads the same flag. A new secret setting joins the plant list on the
 * commit that declares it, with no line here to remember.
 */
export function secretConfigFields(sections, coreFields, groupFields) {
  const fields = [...coreFields, ...sections.flatMap((section) => section.groups.flatMap((group) => groupFields(group)))];
  return fields.filter((field) => field.secret === true).sort((left, right) => (left.name < right.name ? -1 : 1));
}

/** Every configuration field of any section, core included. */
export function allConfigFields(sections, coreFields, groupFields) {
  return [...coreFields, ...sections.flatMap((section) => section.groups.flatMap((group) => groupFields(group)))];
}

/**
 * Settings that could send logs somewhere this gate does not read.
 *
 * `PLATOS_LOG_LEVEL` chooses how MUCH is written, not where, and stdout is what
 * `createProcessDefaults` writes to. Any other log-shaped setting is a sink,
 * and `refusals` turns it into a failure rather than a silence.
 */
export const CAPTURED_LOG_SETTINGS = Object.freeze(["PLATOS_LOG_LEVEL"]);

export function uncapturedLogSinkSettings(fields) {
  // `LOG` as a WHOLE underscore-delimited word, not a substring. A substring
  // rule flags `PLATOS_CHANNELS_EMAIL_LOGIN_URL`, which configures where a
  // sign-in link points and not where a log goes; a gate that cries wolf on a
  // login URL is a gate somebody eventually deletes.
  return fields
    .map((field) => field.name)
    .filter((name) => /(?:^|_)LOG(?:_|$)/u.test(name) && !CAPTURED_LOG_SETTINGS.includes(name))
    .sort();
}

/**
 * A value that satisfies a field's own declared constraints and is still a
 * unique sentinel.
 *
 * A plant that the loader REJECTS never reaches the process, and a gate whose
 * plants were all rejected would scan a log that could not contain them. So the
 * spec's pattern, minimum length and scheme are read and honoured; a field whose
 * shape this cannot satisfy is reported rather than silently skipped.
 */
export function sentinelFor(field, nonce) {
  const label = field.name.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  if (field.kind === "url") {
    const scheme = (field.schemes ?? ["https:"])[0] ?? "https:";
    return { ok: true, value: `${scheme}//plant-${nonce}-${label}.invalid/${nonce}` };
  }
  if (field.pattern !== undefined) {
    // The only patterned secrets in the contract today are 64-hex keys. A digest
    // of the nonce and the field name is conforming AND distinct per field, so
    // no two plants collide and `refusals` can attribute a hit. Any other
    // pattern is refused loudly rather than guessed at: a plant the loader
    // rejects never reaches the process, and scanning for it would be scanning
    // for a string that could not be there.
    if (/^\[0-9a-fA-F\]\{64\}$/u.test(field.pattern)) {
      return { ok: true, value: createHash("sha256").update(`${nonce}:${field.name}`).digest("hex") };
    }
    return { ok: false, reason: `no sentinel generator satisfies ${field.name}'s pattern ${field.pattern}` };
  }
  const value = `plant-${nonce}-${label}`;
  return { ok: true, value: value.padEnd(field.minimumLength ?? 0, "x") };
}
