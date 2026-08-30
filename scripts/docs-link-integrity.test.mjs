import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED_MINIMUMS, validateDocsLinkIntegrity } from "./docs-link-integrity.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function write(root, path, source = "fixture\n") {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function validFixture() {
  const root = mkdtempSync(join("/var/tmp", "platos-docs-link-integrity-"));
  write(
    root,
    "docs/docs.json",
    `${JSON.stringify(
      {
        $schema: "https://mintlify.com/docs.json",
        navigation: {
          dropdowns: [
            {
              dropdown: "Docs",
              groups: [{ group: "Start", pages: ["index", "guide"] }],
            },
          ],
        },
        favicon: "/images/favicon.png",
        logo: { light: "/logo/light.png", dark: "/logo/dark.png" },
        redirects: [
          { source: "/old", destination: "/guide?view=all#page-title" },
          { source: "/legacy/:slug*", destination: "/:slug*" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    "docs/index.mdx",
    `import Card from "/snippets/card.mdx";\n\n# Home\n\n[Guide](./guide.mdx?tab=one#target)\n[Root guide](/guide)\n[Redirect](/old)\n[Navigation alias](/index)\n<CardLink href="/guide" />\n[Self](#home)\n[Imported heading](#reusable-card)\n![Diagram](/images/pic%20one.png?raw=1)\n<img src="/logo/dark.png?raw=1" />\n\n<Card />\n`,
  );
  write(root, "docs/guide.mdx", '---\ntitle: "Guide title"\n---\n\n# Target\n\n[Home](./index.mdx#home)\n');
  write(root, "docs/snippets/card.mdx", "## Reusable card\n\nA reusable card.\n");
  write(root, "docs/images/favicon.png");
  write(root, "docs/images/pic one.png");
  write(root, "docs/logo/light.png");
  write(root, "docs/logo/dark.png");
  write(root, "content/docs/topic.md", "# Topic\n\n[How](/guides/how?mode=full#how)\n");
  write(root, "content/guides/how.md", "# How\n\n[Topic](/docs/topic#topic)\n");
  write(
    root,
    "design/platos-ui-refactor/index.html",
    `<!doctype html><link rel="stylesheet" href="./styles.css?theme=dark"><script type="module" src="support.js"></script><img src="assets/logo%20one.png"><a href="page.html?tab=one#section">Page</a><dc-import name="Page"></dc-import>`,
  );
  write(root, "design/platos-ui-refactor/page.html", '<h1 id="section">Page</h1>');
  write(root, "design/platos-ui-refactor/Page.dc.html", "<x-dc>Page component</x-dc>");
  write(root, "design/platos-ui-refactor/styles.css", 'body { background: url("./assets/logo%20one.png?raw=1"); }\n');
  write(root, "design/platos-ui-refactor/support.js", 'import "./module.js";\n');
  write(root, "design/platos-ui-refactor/module.js", "export const fixture = true;\n");
  write(root, "design/platos-ui-refactor/assets/logo one.png");
  return root;
}

function withFixture(run) {
  const root = validFixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function errorsFor(root, options = { minimums: false }) {
  return validateDocsLinkIntegrity(root, options).errors;
}

function hasError(errors, fragment) {
  assert.ok(errors.some((error) => error.includes(fragment)), `expected an error containing ${JSON.stringify(fragment)}\n${errors.join("\n")}`);
}

test("the live corpora are enumerated with exact non-vacuous counts", () => {
  const result = validateDocsLinkIntegrity(repositoryRoot, { minimums: false });
  assert.deepEqual(result.stats, {
    docsMarkdownFiles: 391,
    contentMarkdownFiles: 81,
    navigationLeaves: 248,
    navigationUniqueLeaves: 247,
    moduleImports: 186,
    snippetImports: 186,
    rootAssets: 95,
    relativeLinks: 62,
    anchorReferences: 207,
    contentInternalLinks: 207,
    designSourceFiles: 51,
    designReferences: 501,
    designImports: 40,
    redirects: 32,
  });
  assert.deepEqual(result.errors, []);
});

test("contract-versioning code samples render literal readable braces without MDX expressions", () => {
  const source = readFileSync(
    new URL("../docs/adr/M0.4-contract-versioning.md", import.meta.url),
    "utf8",
  );
  const renderedCode = [...source.matchAll(/<code>(.*?)<\/code>/gu)].map((match) =>
    match[1]
      .replaceAll("&lbrace;", "{")
      .replaceAll("&rbrace;", "}")
      .replaceAll("&#124;", "|")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&"),
  );
  assert.equal(renderedCode.length, 46);
  assert.ok(renderedCode.includes('enableVersioning({URI, defaultVersion:"1"})'));
  assert.ok(renderedCode.includes("{data,meta:{contractVersion}}"));
  assert.ok(
    renderedCode.includes(
      "tool_call.result{status,ms,error?{kind:dispatch|provider,code,attribution,agentToldUser}}",
    ),
  );
  assert.doesNotMatch(source, /<code>\{/u);
  assert.doesNotMatch(source, /&#12[35];/u);
});

test("the production minimums remain positive and below the exact live counts", () => {
  const result = validateDocsLinkIntegrity(repositoryRoot, { minimums: false });
  for (const [name, minimum] of Object.entries(REQUIRED_MINIMUMS)) {
    assert.ok(Number.isSafeInteger(minimum) && minimum > 0, name);
    assert.ok(result.stats[name] >= minimum, `${name}: ${result.stats[name]} is below ${minimum}`);
  }
});

test("a complete fixture accepts encoded paths, queries, fragments, imports, redirects, and design assets", () => {
  withFixture((root) => {
    const result = validateDocsLinkIntegrity(root, { minimums: false });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.stats, {
      docsMarkdownFiles: 3,
      contentMarkdownFiles: 2,
      navigationLeaves: 2,
      navigationUniqueLeaves: 2,
      moduleImports: 1,
      snippetImports: 1,
      rootAssets: 5,
      relativeLinks: 2,
      anchorReferences: 6,
      contentInternalLinks: 2,
      designSourceFiles: 6,
      designReferences: 7,
      designImports: 1,
      redirects: 2,
    });
  });
});

test("empty corpora and malformed Mintlify configuration fail closed", () => {
  const root = mkdtempSync(join("/var/tmp", "platos-docs-link-integrity-empty-"));
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "content/docs"), { recursive: true });
    mkdirSync(join(root, "content/guides"), { recursive: true });
    mkdirSync(join(root, "design/platos-ui-refactor"), { recursive: true });
    write(root, "docs/docs.json", "{ not-json\n");
    const errors = errorsFor(root);
    hasError(errors, "docs/docs.json: malformed JSON");
    hasError(errors, "docs: Markdown/MDX corpus is empty");
    hasError(errors, "content: Markdown corpus is empty");
    hasError(errors, "HTML/CSS/JS source corpus is empty");
    hasError(errors, "navigation has no page leaves");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("navigation leaves are canonical, exact-case, non-traversing page routes", () => {
  withFixture((root) => {
    const configPath = join(root, "docs/docs.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.navigation.dropdowns[0].groups[0].pages = ["Guide", "guide?draft=1", "%2e%2e/secret"];
    writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const errors = errorsFor(root);
    hasError(errors, 'missing case-sensitive target "Guide"');
    hasError(errors, "navigation leaf must be a canonical extensionless route");
    hasError(errors, "unsafe encoded or traversing navigation leaf");
  });
});

test("ES-module snippet imports and root image or logo embeds must resolve exactly", () => {
  withFixture((root) => {
    write(
      root,
      "docs/index.mdx",
      `import Missing from "/snippets/Missing.mdx";\n\n# Home\n\n![Missing](/images/MISSING.png)\n<img src="/logo/MISSING.png" />\n`,
    );
    const errors = errorsFor(root);
    hasError(errors, 'missing case-sensitive target "/snippets/Missing.mdx"');
    hasError(errors, 'missing case-sensitive target "/images/MISSING.png"');
    hasError(errors, 'missing case-sensitive target "/logo/MISSING.png"');
  });
});

test("relative Markdown links and anchors reject case errors, traversal, and malformed encoding", () => {
  withFixture((root) => {
    write(
      root,
      "docs/index.mdx",
      `# Home\n\n[Wrong case](./Guide.mdx)\n[Wrong anchor](./guide.mdx?tab=one#Target)\n[Traversal](%2e%2e/%2e%2e/secret.md)\n[Malformed](./guide%ZZ.mdx)\n`,
    );
    const errors = errorsFor(root);
    hasError(errors, 'missing case-sensitive target "./Guide.mdx"');
    hasError(errors, "missing case-sensitive anchor #Target");
    hasError(errors, "path traversal escapes");
    hasError(errors, "malformed URL encoding");
  });
});

test("Mintlify page titles expose page-title, not a slug derived from frontmatter title", () => {
  withFixture((root) => {
    const configPath = join(root, "docs/docs.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.redirects[0].destination = "/guide#guide-title";
    writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const errors = errorsFor(root);
    hasError(errors, "missing case-sensitive anchor #guide-title");
  });
});

test("every root-relative documentation route, including MDX href, must exist in the route graph", () => {
  withFixture((root) => {
    const indexPath = join(root, "docs/index.mdx");
    const source = readFileSync(indexPath, "utf8")
      .replace("[Root guide](/guide)", "[Root guide](/missing)")
      .replace('href="/guide"', 'href="/missing?from=mdx"');
    writeFileSync(indexPath, source);
    const errors = errorsFor(root);
    assert.equal(errors.filter((error) => error.includes('missing canonical documentation route "/missing"')).length, 2);
  });
});

test("static expression-valued MDX href and src attributes use the route and asset graphs", () => {
  withFixture((root) => {
    const indexPath = join(root, "docs/index.mdx");
    writeFileSync(
      indexPath,
      `${readFileSync(
        indexPath,
        "utf8"
      )}\n<Static href={"/guide"} />\n<Static href={'/guide'} />\n<img src={"/images/favicon.png"} />\n<img src={'/logo/dark.png'} />\n`
    );
    assert.deepEqual(errorsFor(root), []);
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8")
        .replace('href={"/guide"}', 'href={"/missing"}')
        .replace("src={'/logo/dark.png'}", "src={'/logo/missing.png'}")
    );
    const errors = errorsFor(root);
    hasError(errors, 'missing canonical documentation route "/missing"');
    hasError(errors, 'missing case-sensitive target "/logo/missing.png"');
  });
});

test("dynamic expression-valued MDX href and src attributes fail closed", () => {
  withFixture((root) => {
    const indexPath = join(root, "docs/index.mdx");
    writeFileSync(
      indexPath,
      `${readFileSync(
        indexPath,
        "utf8"
      )}\n<Static href={destination} />\n<img src={imageSource} />\n`
    );
    const errors = errorsFor(root);
    hasError(errors, "cannot prove static MDX href attribute");
    hasError(errors, "cannot prove static MDX src attribute");
  });
});

test("unused local MDX imports cannot contribute anchors", () => {
  withFixture((root) => {
    const indexPath = join(root, "docs/index.mdx");
    write(
      root,
      "docs/index.mdx",
      `${readFileSync(indexPath, "utf8").replace(
        'import Card from "/snippets/card.mdx";',
        'import Card from "/snippets/card.mdx";\nimport Unused from "/snippets/unused.mdx";',
      )}\n[Unused heading](#unused-heading)\n`,
    );
    write(root, "docs/snippets/unused.mdx", "## Unused heading\n");
    const errors = errorsFor(root);
    hasError(errors, "missing case-sensitive anchor #unused-heading");
  });
});

test("local MDX snippets inside constant-false expressions cannot contribute anchors", () => {
  withFixture((root) => {
    const indexPath = join(root, "docs/index.mdx");
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace("<Card />", "{false && <Card />}")
    );
    const errors = errorsFor(root);
    hasError(errors, "cannot prove unconditional JSX render for Card inside an MDX expression");
    hasError(errors, "missing case-sensitive anchor #reusable-card");
  });
});

test("duplicate headings across rendered local MDX snippets receive ordered suffixes", () => {
  withFixture((root) => {
    write(root, "docs/snippets/first.mdx", "## Repeated heading\n");
    write(root, "docs/snippets/second.mdx", "## Repeated heading\n");
    write(
      root,
      "docs/index.mdx",
      `import First from "/snippets/first.mdx";\nimport Second from "/snippets/second.mdx";\n\n# Home\n\n[First](#repeated-heading)\n[Second](#repeated-heading-1)\n\n<Second />\n<First />\n`,
    );
    assert.deepEqual(errorsFor(root), []);
    writeFileSync(
      join(root, "docs/index.mdx"),
      readFileSync(join(root, "docs/index.mdx"), "utf8").replace("#repeated-heading-1", "#repeated-heading-2"),
    );
    hasError(errorsFor(root), "missing case-sensitive anchor #repeated-heading-2");
  });
});

test("content internal /docs and /guides links validate targets and anchors", () => {
  withFixture((root) => {
    write(
      root,
      "content/docs/topic.md",
      "# Topic\n\n[Missing](/guides/Missing?mode=full)\n[Anchor](/guides/how#How)\n[Traversal](/docs/%2e%2e/%2e%2e/secret)\n[Unsupported](/doc/missing)\n![Missing asset](/images/not-present.png)\n",
    );
    const errors = errorsFor(root);
    hasError(errors, 'missing case-sensitive target "/guides/Missing?mode=full"');
    hasError(errors, "missing case-sensitive anchor #How");
    hasError(errors, "unsafe encoded or traversing link path");
    hasError(errors, 'unsupported content root-relative path "/doc/missing"');
    hasError(errors, 'missing case-sensitive target "/images/not-present.png"');
  });
});

test("design HTML, CSS, JS, and dc-import references stay inside the exact design source", () => {
  withFixture((root) => {
    write(
      root,
      "design/platos-ui-refactor/index.html",
      '<link href="missing.css"><img src="/root.png"><dc-import name="missing"></dc-import>',
    );
    write(root, "design/platos-ui-refactor/styles.css", 'body { background: url("%2e%2e/secret.png"); }\n');
    write(root, "design/platos-ui-refactor/support.js", 'import "./Missing.js";\n');
    const errors = errorsFor(root);
    hasError(errors, 'missing case-sensitive target "missing.css"');
    hasError(errors, "design source uses root asset");
    hasError(errors, 'missing case-sensitive target "missing.dc.html"');
    hasError(errors, "path traversal escapes design/platos-ui-refactor");
    hasError(errors, 'missing case-sensitive target "./Missing.js"');
  });
});

test("dynamic design href bindings resolve every exact object-literal target and reject drift", () => {
  withFixture((root) => {
    const target = join(root, "design/platos-ui-refactor");
    rmSync(target, { recursive: true, force: true });
    cpSync(join(repositoryRoot, "design/platos-ui-refactor"), target, { recursive: true });
    assert.deepEqual(errorsFor(root), []);

    const home = join(target, "03-home.dc.html");
    const source = readFileSync(home, "utf8");
    assert.ok(source.includes("href:'21-entity.dc.html'"), "production mutation target must remain present");
    writeFileSync(home, source.replace("href:'21-entity.dc.html'", "href:'missing.dc.html'"));
    hasError(errorsFor(root), 'missing case-sensitive target "missing.dc.html"');
  });
});

test("duplicate design loop aliases fail closed instead of hiding an earlier broken target", () => {
  withFixture((root) => {
    write(
      root,
      "design/platos-ui-refactor/loops.html",
      `<script>\nconst earlier = [{ href: 'missing.html' }];\nconst later = [{ href: 'page.html' }];\n</script>\n<sc-for list="{{ earlier }}" as="a"><a href="{{ a.href }}">Earlier</a></sc-for>\n<sc-for list="{{ later }}" as="a"><a href="{{ a.href }}">Later</a></sc-for>\n`,
    );
    hasError(errorsFor(root), "ambiguous duplicate design loop alias a");
  });
});

test("redirect mappings reject malformed shapes, unbound parameters, missing targets, and cycles", () => {
  withFixture((root) => {
    const configPath = join(root, "docs/docs.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.redirects = [
      { source: "/one", destination: "/two" },
      { source: "/two", destination: "/one" },
      { source: "/dynamic/:slug*", destination: "/guide/:other*" },
      { source: "/missing", destination: "/Missing" },
      { source: "/query?bad=1", destination: "/guide" },
      { source: "/encoded/%ZZ", destination: "/guide" },
      { source: "/encoded/%2e%2e/escape", destination: "/guide" },
    ];
    writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const errors = errorsFor(root);
    hasError(errors, "redirect cycle includes");
    hasError(errors, "destination uses unbound route parameter :other");
    hasError(errors, 'missing case-sensitive target "/Missing"');
    hasError(errors, "redirect source must be a local path without query or fragment");
    hasError(errors, "malformed URL encoding");
    hasError(errors, "unsafe encoded or traversing link path");
  });
});

test("dangling symlinks and generated artifacts cannot enter any source corpus", () => {
  withFixture((root) => {
    symlinkSync("missing.mdx", join(root, "docs/dangling.mdx"));
    write(root, "content/docs/.mintlify/cache.json", "{}\n");
    write(root, "design/platos-ui-refactor/support.js.map", "{}\n");
    const errors = errorsFor(root);
    hasError(errors, "dangling symlink is forbidden");
    hasError(errors, "generated artifact directory is forbidden");
    hasError(errors, "generated artifact is forbidden");
  });
});

test("minimum-count enforcement rejects vacuous or unknown contracts", () => {
  withFixture((root) => {
    const errors = errorsFor(root, {
      minimums: {
        navigationLeaves: 3,
        snippetImports: 0,
        absentStatistic: 1,
      },
    });
    hasError(errors, "navigationLeaves: expected at least 3, found 2");
    hasError(errors, "minimum snippetImports must be a positive integer");
    hasError(errors, "minimum references unknown statistic absentStatistic");
  });
});
