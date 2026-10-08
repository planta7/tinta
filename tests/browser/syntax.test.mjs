import { test, expect } from "./fixtures.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classicBundle, inlineScript } from "../../scripts/packaging.mjs";
import { parse, enrichMarkdown } from "../../packages/syntax/dist/index.js";

test("portable syntax and enrichment agree with Node offline", async ({
  page,
}, testInfo) => {
  const input = {
    uri: "tinta:portable",
    profile: "tinta",
    text: "\ufeff@let x = (\r\n1 + 2\r\n)\r\n@when true\r\n# 😀 {{ x }}\r\n```\r\n@end\r\n```\r\n@end\r\n<script>globalThis.authorExecuted = true</script>",
  };
  const markdown = {
    uri: "tinta:prose",
    profile: "markdown",
    text: "{{ literal }}\n\n@team prose\n\n![{{ alt }}](asset.png)\n",
  };
  const expected = JSON.parse(
    JSON.stringify({
      parsed: parse(input),
      enriched: enrichMarkdown(markdown),
    }),
  );

  const dir = resolve("build/parser-browser", testInfo.project.name);
  await mkdir(dir, { recursive: true });
  const entry = resolve(dir, "entry.js");
  await writeFile(
    entry,
    `import {parse,enrichMarkdown} from ${JSON.stringify(resolve("packages/syntax/dist/index.js"))};\nglobalThis.syntaxResult = {parsed:parse(${JSON.stringify(input)}),enriched:enrichMarkdown(${JSON.stringify(markdown)})};`,
  );

  const bundle = await classicBundle(entry);
  const html = resolve(dir, "index.html");
  await writeFile(
    html,
    '<!doctype html><meta charset="UTF-8"><title>Portable parser test</title>' +
      inlineScript(bundle.code),
  );

  const errors = [],
    network = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) network.push(r.url());
  });

  await page.context().setOffline(true);
  await page.goto(pathToFileURL(html).href);

  expect(
    await page.evaluate(() =>
      JSON.parse(JSON.stringify(globalThis.syntaxResult)),
    ),
  ).toEqual(expected);
  expect(await page.evaluate(() => globalThis.authorExecuted)).toBeUndefined();
  expect(errors).toEqual([]);
  expect(network).toEqual([]);
});
