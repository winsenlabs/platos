import { describe, expect, it } from "vitest";

import { admitImportUrl, rewriteChangedHost, rewriteToRawSource } from "./import-source.js";

function admitted(candidate: string): URL {
  const result = admitImportUrl(candidate);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function rewritten(candidate: string): string {
  return rewriteToRawSource(admitted(candidate)).toString();
}

describe("admitImportUrl", () => {
  it("admits https and http", () => {
    expect(admitted("https://example.test/s.md").protocol).toBe("https:");
    expect(admitted("http://example.test/s.md").protocol).toBe("http:");
  });

  it("REFUSES a file URL", () => {
    const result = admitImportUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_SOURCE_PROTOCOL_UNSUPPORTED");
  });

  it("REFUSES a data URL", () => {
    const result = admitImportUrl("data:text/plain,hello");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_SOURCE_PROTOCOL_UNSUPPORTED");
  });

  it("REFUSES a string that is not a URL at all", () => {
    const result = admitImportUrl("not a url");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_SOURCE_URL_INVALID");
  });
});

describe("rewriteToRawSource", () => {
  it("appends the manifest filename to a skill-library page", () => {
    expect(rewritten("https://claude.ai/skills/abc")).toBe("https://claude.ai/skills/abc/skill.md");
  });

  it("tolerates a trailing slash without doubling it", () => {
    expect(rewritten("https://claude.ai/skills/abc/")).toBe("https://claude.ai/skills/abc/skill.md");
  });

  it("leaves a skill-library URL that already names a markdown file alone", () => {
    expect(rewritten("https://claude.ai/skills/abc/skill.md")).toBe("https://claude.ai/skills/abc/skill.md");
  });

  it("preserves a query string when appending the filename", () => {
    expect(rewritten("https://claude.ai/skills/abc?v=2")).toBe("https://claude.ai/skills/abc/skill.md?v=2");
  });

  it("rewrites a repository blob page to its raw host", () => {
    expect(rewritten("https://github.com/acme/repo/blob/main/skills/a.md")).toBe(
      "https://raw.githubusercontent.com/acme/repo/main/skills/a.md",
    );
  });

  it("leaves a repository URL that is not a blob page alone", () => {
    expect(rewritten("https://github.com/acme/repo")).toBe("https://github.com/acme/repo");
  });

  it("rewrites a gist page to its raw form", () => {
    expect(rewritten("https://gist.github.com/someone/deadbeef")).toBe(
      "https://gist.githubusercontent.com/someone/deadbeef/raw",
    );
  });

  it("leaves a gist URL that is already raw alone", () => {
    expect(rewritten("https://gist.github.com/someone/deadbeef/raw")).toBe(
      "https://gist.github.com/someone/deadbeef/raw",
    );
  });

  it("is total — an unrecognised URL passes through unchanged", () => {
    expect(rewritten("https://example.test/some/skill.md")).toBe("https://example.test/some/skill.md");
  });

  it("does not rewrite a look-alike host", () => {
    // `claude.ai.evil.test` is a different host and must not be treated as the
    // skill library merely because the string starts the same way.
    expect(rewritten("https://claude.ai.evil.test/skills/abc")).toBe(
      "https://claude.ai.evil.test/skills/abc",
    );
  });

  // WIN-256 verification, 2026-09-03. The case above covers the PREFIX
  // look-alike and nothing covered the SUFFIX one, which is the direction a
  // hostname check is actually got wrong — `endsWith("github.com")`,
  // `endsWith(".claude.ai")` with the dot forgotten, a regex missing its `$`.
  // Relaxing each of the three `hostname !==` guards to `!endsWith(...)` left
  // ALL 302 cases green, so "every rule is guarded by exact hostname equality"
  // — the sentence this module's header rests its HOST CLOSURE argument on, and
  // which the header in turn cites as the reason the SUBMITTED url needs no
  // address check — was prose with no mechanism behind it.
  //
  // Each case below supplies a host that a suffix match would admit and asserts
  // the URL comes back UNCHANGED, so relaxing that rule turns exactly this case
  // red. They are refusals, not happy paths: the input is the hostile one.
  it("REFUSES to treat a SUFFIX look-alike of the skill library as the skill library", () => {
    // `evil-claude.ai` ends with `claude.ai`. A suffix match would append the
    // manifest filename to a path on an attacker's host.
    expect(rewritten("https://evil-claude.ai/skills/abc")).toBe("https://evil-claude.ai/skills/abc");
  });

  it("REFUSES to treat a SUFFIX look-alike of the repository host as a blob page", () => {
    // `evilgithub.com` ends with `github.com`. A suffix match would rewrite this
    // to raw.githubusercontent.com — sending the fetch to a host the operator
    // never named, off the strength of one that merely resembles the real one.
    expect(rewritten("https://evilgithub.com/acme/repo/blob/main/a.md")).toBe(
      "https://evilgithub.com/acme/repo/blob/main/a.md",
    );
  });

  it("REFUSES to treat a SUFFIX look-alike of the gist host as a gist", () => {
    expect(rewritten("https://evilgist.github.com.attacker.test/user/id")).toBe(
      "https://evilgist.github.com.attacker.test/user/id",
    );
    // And the true suffix form, which a `endsWith("gist.github.com")` admits.
    expect(rewritten("https://notgist.github.com/user/id")).toBe("https://notgist.github.com/user/id");
  });

  it("keeps HOST CLOSURE over every look-alike: the fetch stays where the operator sent it", () => {
    // The header's closure claim, asserted directly rather than argued: for a
    // host that is not one of the three exact literals, the rewrite never moves
    // the request off it.
    for (const candidate of [
      "https://evil-claude.ai/skills/abc",
      "https://claude.ai.evil.test/skills/abc",
      "https://evilgithub.com/acme/repo/blob/main/a.md",
      "https://github.com.attacker.test/acme/repo/blob/main/a.md",
      "https://notgist.github.com/user/id",
    ]) {
      const submitted = admitted(candidate);
      expect(rewriteChangedHost(submitted, rewriteToRawSource(submitted))).toBe(false);
    }
  });
});

describe("rewriteChangedHost", () => {
  it("reports the host change a repository rewrite makes", () => {
    const submitted = admitted("https://github.com/acme/repo/blob/main/a.md");
    expect(rewriteChangedHost(submitted, rewriteToRawSource(submitted))).toBe(true);
  });

  it("reports no change when the rewrite stayed on the same host", () => {
    const submitted = admitted("https://claude.ai/skills/abc");
    expect(rewriteChangedHost(submitted, rewriteToRawSource(submitted))).toBe(false);
  });
});
