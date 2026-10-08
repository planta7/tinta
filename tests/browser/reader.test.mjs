import { test, expect } from "./fixtures.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readerCoverage } from "../../scripts/reader-coverage.mjs";
import AxeBuilder from "@axe-core/playwright";
import { classicBundle, inlineScript } from "../../scripts/packaging.mjs";

const documentSource = `@meta (title: "Reading choices", locale: "en-US")
# Reading choices
A document with **strong**, *emphasis*, ~~removed~~ and \`code\`.

- A list item
- [x] A static task

@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")
@toggle show = true (label: "Show explanation")
@choice mode = "Short" (options: ["Short", "Long"], label: "Length")

Amount: **{{ amount }}**. Length: {{ mode }}.

@when show
## Explanation
Conditional text.
@end

@details "More context"
Nested text {{ amount }}.
@details "Nested context"
Deep explanation.
@end
@end

| Name | Count |
| :--- | ---: |
| Alpha | 2 |

> An ordinary quote.

\`\`\`text
A deliberately long code line that can scroll locally without expanding the document viewport.
\`\`\`
`;
let html;
let runtime;
const coverage = [];
test.beforeAll(async ({ browserName }) => {
  const directory = resolve("build/reader-tests", browserName);
  await mkdir(directory, { recursive: true });
  runtime = resolve(directory, "runtime.js");
  await build({
    entryPoints: ["packages/reader/src/standalone.ts"],
    outfile: runtime,
    bundle: true,
    format: "iife",
    globalName: "globalThis.TintaReaderRuntime",
    platform: "browser",
    target: "es2022",
    sourcemap: "external",
  });
  const bundle = await classicBundle("tests/browser/reader-harness.mjs");
  const css = await readFile("packages/reader/src/reader.css", "utf8");
  html = resolve(directory, "index.html");
  await writeFile(
    html,
    `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reader tests</title>
<style>body{margin:0}${css}</style>
</head>
<body><main></main>
<script src="./runtime.js"></script>
${inlineScript(bundle.code)}
</body></html>`,
  );
});
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "chromium")
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.context().setOffline(true);
  await page.goto(pathToFileURL(html).href);
});
test.afterEach(async ({ page, browserName }) => {
  if (browserName === "chromium")
    coverage.push(
      ...(await page.coverage.stopJSCoverage()).filter(
        (entry) => entry.url === pathToFileURL(runtime).href,
      ),
    );
});
test.afterAll(async ({ browserName }) => {
  if (browserName === "chromium")
    await readerCoverage(coverage, runtime + ".map");
});
async function mount(page, source = documentSource, options = {}) {
  return page.evaluate(
    ({ source, options }) => globalThis.readerTest.mount(source, options),
    { source, options },
  );
}

test("SC-001 and CT-007: author HTML, comments and interpolated payloads stay inert without requests", async ({
  page,
}) => {
  const requests = [],
    errors = [],
    dialogs = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  const cases = JSON.parse(
    await readFile("conformance/cases.json", "utf8"),
  ).cases;
  await mount(page, cases.find((c) => c.id === "CT-007").source);
  await mount(
    page,
    `<iframe src="https://example.invalid/frame"></iframe>

<style>body{display:none}</style>

<img src="https://example.invalid/x" onerror="alert(2)">

<!-- hidden note -->

@let payload = "<img src=x onerror=alert(3)>"
{{ payload }}
`,
  );
  await expect(
    page.locator("article script, article iframe, article style, article img"),
  ).toHaveCount(0);
  await expect(page.locator("article").first()).toContainText(
    "<script>alert(1)</script>",
  );
  await expect(page.locator("article").nth(1)).not.toContainText("hidden note");
  await expect(page.locator("article").nth(1)).toContainText(
    "<img src=x onerror=alert(3)>",
  );
  expect(
    await page.evaluate(() =>
      globalThis.readerTest.instances[0].diagnostics.map((d) => d.code),
    ),
  ).toContain("W_HTML_INERT");
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
  expect(dialogs).toEqual([]);
});

test("CT-009: unsafe links are inert and allowed links carry explicit navigation protections", async ({
  page,
}) => {
  const cases = JSON.parse(
    await readFile("conformance/cases.json", "utf8"),
  ).cases;
  await mount(
    page,
    cases.find((c) => c.id === "CT-009").source +
      `
[relative](other.tinta) [entity](jav&#x61;script:alert%281%29) [data](data:text/html,evil) [scheme](//example.invalid) [file](file:///tmp/private)

[web](https://example.invalid) [mail](mailto:test@example.invalid)
`,
  );
  await expect(page.locator("article a")).toHaveCount(2);
  for (const label of ["web", "mail"]) {
    await expect(
      page.getByRole("link", { name: label, exact: true }),
    ).toHaveAttribute("target", "_blank");
    await expect(
      page.getByRole("link", { name: label, exact: true }),
    ).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("native controls update one immutable revision and preserve field identity, focus and details", async ({
  page,
}) => {
  await mount(page);
  await page.getByText("More context", { exact: true }).click();
  await page.getByText("Nested context", { exact: true }).click();
  await page.getByRole("slider", { name: "Amount" }).focus();
  await page.evaluate(() => {
    globalThis.originalField = document.activeElement;
  });
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider")).toHaveValue("3");
  await expect(page.locator("article")).toContainText("Amount: 3");
  expect(
    await page.evaluate(
      () => document.activeElement === globalThis.originalField,
    ),
  ).toBe(true);
  await expect(page.locator("details[open]")).toHaveCount(2);
  await page.getByRole("combobox").selectOption("Long");
  await expect(page.locator("article")).toContainText("Length: Long");
  await page.getByRole("checkbox", { name: "Show explanation" }).uncheck();
  await expect(
    page.getByRole("heading", { name: "Explanation", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("[role=status]")).toHaveText("Reading updated.");
  expect(
    await page.evaluate(
      () => globalThis.readerTest.instances[0].session.getRevision().number,
    ),
  ).toBe(3);
  await expect(
    page.getByRole("checkbox", { name: "Completed task" }),
  ).toBeDisabled();
});

test("SC-035: self-hidden focus moves to the preceding visible control or article heading", async ({
  page,
}) => {
  for (const preceding of [true, false]) {
    const id = await mount(
      page,
      "# Focus fallback\n\n" +
        (preceding
          ? '@slider earlier = 1 (min: 0, max: 2, label: "Earlier")\n'
          : "") +
        '@when keep\n@toggle keep = true (label: "Keep visible")\n@end\n',
    );
    const article = page.locator("article").nth(id);
    await article.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await expect(article.getByRole("checkbox")).toHaveCount(0);
    await expect(
      preceding ? article.getByRole("slider") : article.getByRole("heading"),
    ).toBeFocused();
    await expect(article.getByRole("status")).toContainText("focus moved");
    await article.getByRole("button", { name: "Reset reading" }).click();
    await expect(article.getByRole("checkbox")).toBeChecked();
    await expect(article.getByRole("status")).toHaveText("Reading reset.");
  }
});

test("rejected actions roll back DOM value, prose and focus, and recover on the next valid input", async ({
  page,
}) => {
  await mount(
    page,
    '# Division\n@slider divisor = 1 (min: 0, max: 3, step: 1, label: "Divisor")\nResult: {{ 12 / divisor }}\n',
  );
  const slider = page.getByRole("slider");
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveValue("1");
  await expect(slider).toBeFocused();
  await expect(slider).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("article")).toContainText("Result: 12");
  await expect(page.getByRole("status")).toContainText("Change rejected.");
  expect(
    await page.evaluate(
      () => globalThis.readerTest.instances[0].session.getRevision().number,
    ),
  ).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("2");
  await expect(slider).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("article")).toContainText("Result: 6");
  await page.getByRole("button", { name: "Reset reading" }).click();
  await expect(slider).toHaveValue("1");
});

test("tables, captions, counts, empty views, Markdown alignment and local placeholders", async ({
  page,
}) => {
  const warnings = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) warnings.push(r.url());
  });
  await mount(
    page,
    `# Tables
@toggle empty = false (label: "Empty")
@data records
name:text | readings:number
Alpha | 2
Beta | 4
@end
@view selected = records (where: not empty)
@table selected (title: "Records")

| Left | Right |
| :--- | ---: |
| a | b |

![Local alt](assets/missing.png)

![Remote alt](https://example.invalid/image.png)
`,
  );
  await expect(page.locator("caption").first()).toHaveText("Records — 2 rows");
  await expect(page.locator("th[scope=col]")).toHaveCount(4);
  await expect(page.locator("table").nth(1).locator("th").nth(1)).toHaveCSS(
    "text-align",
    "right",
  );
  await expect(page.locator("article img")).toHaveCount(0);
  await expect(page.locator("article")).toContainText(
    "Image unavailable: Local alt",
  );
  await page.getByRole("checkbox", { name: "Empty" }).check();
  await expect(page.locator("caption").first()).toHaveText("Records — 0 rows");
  await expect(page.locator("article")).toContainText(
    "No rows match the current choices.",
  );
  const diagnostics = await page.evaluate(() =>
    globalThis.readerTest.instances[0].diagnostics.filter(
      (d) => d.code === "W_ASSET_UNAVAILABLE",
    ),
  );
  expect(diagnostics).toHaveLength(2);
  expect(diagnostics[0].span.uri).toBe("tinta:reader-test");
  expect(diagnostics[0].span.start.offset).toBeGreaterThan(0);
  expect(warnings).toEqual([]);
});

test("same-document anchors remain local across instances and do not reveal false branches", async ({
  page,
}) => {
  const source =
    "# Hello\n\n[go](#hello) [hidden](#secret) [missing](#missing)\n@when false\n## Secret\nHidden.\n@end\n";
  await mount(page, source);
  await mount(page, source);
  const ids = await page
    .locator("article [id]")
    .evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page
    .locator("article")
    .nth(1)
    .getByRole("link", { name: "go", exact: true })
    .click();
  await expect(
    page.locator("article").nth(1).getByRole("heading"),
  ).toBeFocused();
  await page
    .locator("article")
    .first()
    .getByRole("link", { name: "hidden", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Secret" })).toHaveCount(0);
});

test("resetPresentation preserves answers while reading reset restores the session baseline", async ({
  page,
}) => {
  await mount(page, documentSource, {
    baseline: { amount: 4, show: false, mode: "Long" },
  });
  await page.getByRole("slider").fill("6");
  await page.getByText("More context", { exact: true }).click();
  await page.evaluate(() =>
    globalThis.readerTest.instances[0].handle.resetPresentation(),
  );
  await expect(page.getByRole("slider")).toHaveValue("6");
  await expect(page.locator("details[open]")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset reading" }).click();
  await expect(page.getByRole("slider")).toHaveValue("4");
  await expect(
    page.getByRole("checkbox", { name: "Show explanation" }),
  ).not.toBeChecked();
});

test("mount rejects foreign, forged and duplicate hosts, preserves host siblings and isolates destruction", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const { session, host, handle } = globalThis.readerTest.instances[0];
    const invalid = [
      null,
      {},
      document,
      document.createTextNode("x"),
      document.createElementNS("http://www.w3.org/2000/svg", "svg"),
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    ];
    const frame = document.createElement("iframe");
    document.body.append(frame);
    invalid.push(frame.contentDocument.createElement("div"), host);
    const codes = invalid.map(
      (nativeElement) =>
        globalThis.readerTest.mountReader(
          session,
          { nativeElement },
          { assets: new Map() },
        ).diagnostics[0].code,
    );
    const sibling = document.createElement("p");
    sibling.textContent = "Host content";
    host.prepend(sibling);
    const field = host.querySelector("input[type=range]");
    handle.destroy();
    handle.destroy();
    handle.resetPresentation();
    field.value = "8";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    session.setControl("amount", 7);
    const left = host.textContent;
    const again = globalThis.readerTest.mountReader(
      session,
      { nativeElement: host },
      { assets: new Map() },
    );
    const value = host.querySelector("input[type=range]").value;
    again.value.destroy();
    frame.remove();
    return { codes, left, value, number: session.getRevision().number };
  });
  expect(result.codes).toEqual(Array(8).fill("E_PROTOCOL"));
  expect(result.left).toBe("Host content");
  expect(result.value).toBe("7");
  expect(result.number).toBe(1);
});

test("observer failures cannot stop updates or another reader instance", async ({
  page,
}) => {
  await mount(page, documentSource, { observerThrows: true });
  await mount(page);
  await page.locator("article").first().getByRole("slider").fill("5");
  await expect(page.locator("article").first()).toContainText("Amount: 5");
  await expect(
    page.locator("article").first().getByRole("status"),
  ).toContainText("E_INTERNAL");
  await expect(page.locator("article").nth(1).getByRole("slider")).toHaveValue(
    "2",
  );
  await page.evaluate(() =>
    globalThis.readerTest.instances[0].handle.destroy(),
  );
  await page.getByRole("slider").fill("8");
  await expect(page.locator("article")).toContainText("Amount: 8");
});

test("standalone runtime has a callable reader API and explicitly identifies pending charts", async ({
  page,
}) => {
  const script = await readFile("build/reader.js", "utf8");
  await page.addScriptTag({ content: script });
  expect(
    await page.evaluate(
      () => typeof globalThis.TintaReaderRuntime.TintaReader.mountReader,
    ),
  ).toBe("function");
  await mount(
    page,
    '# Figure\n@data d\nx:text | y:number\na | 1\n@end\n@chart bar d (x: "x", y: "y", title: "A figure")\n',
  );
  await expect(page.locator("figcaption")).toHaveText("A figure");
  await expect(page.locator("figure")).toContainText("not implemented");
});

test("accessible document reflows, supports keyboard and records screenshot baselines", async ({
  page,
}, info) => {
  await mount(page);
  await page.getByRole("button", { name: "Reset reading" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("slider")).toBeFocused();
  await expect(page.locator("li").last().locator("p")).toHaveCSS(
    "display",
    "inline",
  );
  const audit = await new AxeBuilder({ page }).include("article").analyze();
  expect(audit.violations).toEqual([]);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `reports/verification/reader-screenshots/${info.project.name}-${width}.png`,
      fullPage: true,
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await expect(page.locator("article")).toHaveCSS("transition-duration", "0s");
  await page.screenshot({
    path: `reports/verification/reader-screenshots/${info.project.name}-forced-colors.png`,
    fullPage: true,
  });
  await page.emulateMedia({ forcedColors: "none" });
  await page.locator("article").evaluate((element) => {
    element.style.fontSize = "34px";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `reports/verification/reader-screenshots/${info.project.name}-text-zoom.png`,
    fullPage: true,
  });
});

test("pointer dragging retains the native slider throughout successive updates and debounces announcements", async ({
  page,
}) => {
  await mount(page);
  const slider = page.getByRole("slider");
  const box = await slider.boundingBox();
  await page.evaluate(() => {
    globalThis.notices = [];
    const status = document.querySelector(".tinta-reader-status");
    new MutationObserver(() =>
      globalThis.notices.push(status.textContent),
    ).observe(status, { childList: true });
  });
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  expect(Number(await slider.inputValue())).toBeGreaterThanOrEqual(7);
  await expect(page.locator(".tinta-reader-status")).toHaveText(
    "Reading updated.",
  );
  expect(await page.evaluate(() => globalThis.notices.length)).toBe(1);
});

test("nested controls work, hidden details retain presentation, and source remount resets it", async ({
  page,
}) => {
  const source = `# Nested
@toggle shown = true (label: "Shown")
@when shown
@details "Remember me"
@slider nested = 1 (min: 0, max: 3, label: "Nested answer")
@end
@end
`;
  await mount(page, source);
  await page.getByText("Remember me", { exact: true }).click();
  await page.getByRole("slider").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider")).toHaveValue("2");
  await page.getByRole("checkbox").uncheck();
  await page.getByRole("checkbox").check();
  await expect(page.locator("details")).toHaveAttribute("open", "");
  await expect(page.getByRole("slider")).toHaveValue("2");
  await page.evaluate(() =>
    globalThis.readerTest.instances[0].handle.destroy(),
  );
  await mount(page, source);
  await expect(page.locator("details[open]")).toHaveCount(0);
});

test("untrusted render plans fail before host mutation and subscriber failures are contained", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const original = globalThis.readerTest.instances[0].session;
    const host = document.createElement("div");
    host.textContent = "Preserved";
    document.querySelector("main").append(host);
    const base = {
      kind: "element",
      id: "n000001",
      tag: "p",
      attributes: {},
      children: [],
    };
    const badNodes = [
      { ...base, tag: "script" },
      { ...base, attributes: { onclick: "alert(1)" } },
      { ...base, tag: "a", attributes: { href: "javascript:alert(1)" } },
      { ...base, tag: "input", attributes: { type: "text" } },
      { kind: "unknown", id: "n000001" },
      { kind: "text", id: "n000001", value: {} },
      { kind: "image", id: "n000001", destination: 1, alt: "a" },
      { kind: "chart", id: "n000001", chart: { title: null } },
      {
        kind: "control",
        id: "n000001",
        definition: {
          kind: "slider",
          name: "x",
          label: "X",
          min: 0,
          max: 2,
          step: 0,
        },
        value: 1,
      },
      {
        kind: "control",
        id: "n000001",
        definition: { kind: "toggle", name: "x", label: "X" },
        value: 1,
      },
      {
        kind: "control",
        id: "n000001",
        definition: { kind: "choice", name: "x", label: "X", options: ["a"] },
        value: "b",
      },
      {
        kind: "control",
        id: "n000001",
        definition: { kind: "unknown", name: "x", label: "X" },
        value: 1,
      },
      { kind: "control", id: "n000001", definition: null },
      null,
    ];
    const codes = badNodes.map(
      (node) =>
        globalThis.readerTest.mountReader(
          {
            ...original,
            getRevision: () => ({ ...original.getRevision(), nodes: [node] }),
          },
          { nativeElement: host },
          { assets: new Map() },
        ).diagnostics[0].code,
    );
    let listener;
    let unsubscribed = 0;
    const callbacks = [];
    const fake = {
      ...original,
      subscribe(fn) {
        listener = fn;
        return () => {
          unsubscribed++;
        };
      },
    };
    const mounted = globalThis.readerTest.mountReader(
      fake,
      { nativeElement: host },
      {
        assets: new Map(),
        onDiagnostic(d) {
          callbacks.push(d.code);
          throw new Error("Diagnostic observer");
        },
      },
    );
    listener({
      ...original.getRevision(),
      number: 1,
      nodes: [{ ...base, tag: "script" }],
    });
    const disabled = [
      ...host.querySelectorAll(".tinta-control input, .tinta-control select"),
    ].every((field) => field.disabled);
    const status = host.querySelector(".tinta-reader-status").textContent;
    mounted.value.destroy();
    mounted.value.destroy();
    return {
      codes,
      disabled,
      status,
      callbacks,
      unsubscribed,
      left: host.textContent,
    };
  });
  expect(result.codes).toEqual(Array(14).fill("E_PROTOCOL"));
  expect(result.disabled).toBe(true);
  expect(result.status).toContain("E_INTERNAL");
  expect(result.callbacks).toEqual(["E_INTERNAL"]);
  expect(result.unsubscribed).toBe(1);
  expect(result.left).toBe("Preserved");
});

test("one subscription per instance and no retained listeners or timer after repeated destroy", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const session = globalThis.readerTest.instances[0].session;
    globalThis.readerTest.instances[0].handle.destroy();
    const host = document.createElement("div");
    document.querySelector("main").append(host);
    let subscriptions = 0,
      unsubscriptions = 0,
      events = 0,
      removals = 0;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (...args) {
      events++;
      return add.apply(this, args);
    };
    EventTarget.prototype.removeEventListener = function (...args) {
      removals++;
      return remove.apply(this, args);
    };
    const wrapped = {
      ...session,
      subscribe(fn) {
        subscriptions++;
        const off = session.subscribe(fn);
        return () => {
          unsubscriptions++;
          off();
        };
      },
    };
    try {
      for (let i = 0; i < 100; i++) {
        const result = globalThis.readerTest.mountReader(
          wrapped,
          { nativeElement: host },
          { assets: new Map() },
        );
        if (!result.ok) throw new Error("Mount failed");
        result.value.resetPresentation();
        result.value.destroy();
        result.value.destroy();
      }
      await new Promise((done) => setTimeout(done, 200));
      return {
        subscriptions,
        unsubscriptions,
        events,
        removals,
        children: host.childElementCount,
      };
    } finally {
      EventTarget.prototype.addEventListener = add;
      EventTarget.prototype.removeEventListener = remove;
    }
  });
  expect(result.subscriptions).toBe(100);
  expect(result.unsubscriptions).toBe(100);
  expect(result.events).toBe(400);
  expect(result.removals).toBe(400);
  expect(result.children).toBe(0);
});

test("shared sessions reserve hidden headings and never steal focus from another mounted reader", async ({
  page,
}) => {
  await mount(
    page,
    '# Shared\n@toggle shown = false (label: "Shown")\n@when shown\n## Hidden heading\nNow visible.\n@end\n@details "Context"\nShared context.\n@end\n',
  );
  await page.evaluate(() => {
    const host = document.createElement("div");
    document.querySelector("main").append(host);
    const result = globalThis.readerTest.mountReader(
      globalThis.readerTest.instances[0].session,
      { nativeElement: host },
      { assets: new Map() },
    );
    if (!result.ok) throw new Error("Second mount failed");
  });
  await page
    .locator("article")
    .first()
    .getByText("Context", { exact: true })
    .focus();
  await page.evaluate(() =>
    globalThis.readerTest.instances[0].session.setControl("shown", true),
  );
  await expect(
    page.locator("article").first().getByText("Context", { exact: true }),
  ).toBeFocused();
  const ids = await page
    .locator("h1, h2")
    .evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
});

test("unavailable host callbacks and destroyed sessions yield local errors with usable reset", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const instance = globalThis.readerTest.instances[0];
    instance.handle.destroy();
    const broken = {
      ...instance.session,
      setControl() {
        throw new Error("host");
      },
      reset() {
        throw new Error("reset");
      },
      subscribe() {
        return () => {
          throw new Error("cleanup");
        };
      },
    };
    const mounted = globalThis.readerTest.mountReader(
      broken,
      { nativeElement: instance.host },
      {
        assets: new Map(),
        onDiagnostic(d) {
          instance.diagnostics.push(d);
        },
      },
    );
    instance.handle = mounted.value;
  });
  await page.getByRole("slider").fill("5");
  await expect(page.getByRole("slider")).toHaveValue("2");
  await expect(page.getByRole("status")).toContainText("E_INTERNAL");
  await page.getByRole("button", { name: "Reset reading" }).click();
  await expect(page.getByRole("status")).toContainText("Reader reset failed");
  await page.evaluate(() =>
    globalThis.readerTest.instances[0].handle.destroy(),
  );
  await expect(page.locator("article")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => globalThis.readerTest.instances[0].diagnostics.at(-1).message,
    ),
  ).toContain("cleanup failed");
});
