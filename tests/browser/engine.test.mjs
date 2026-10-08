import { test, expect } from "./fixtures.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classicBundle, inlineScript } from "../../scripts/packaging.mjs";
import * as engine from "../../packages/engine/dist/index.js";

function execute(api, cases) {
  return cases
    .filter((c) => c.phase !== "enrich")
    .map((c) => {
      if (c.phase === "csv" || c.phase === "json")
        return (c.phase === "csv" ? api.importCsv : api.importJson)(
          new TextEncoder().encode(c.source),
          { name: c.importName },
        );
      const compiled = api.compile({
        text: c.source,
        uri: "tinta:portable",
        profile: c.profile,
      });
      if (!compiled.ok) return compiled;
      const decoded = api.decodeProgram(
        JSON.parse(JSON.stringify(api.encodeProgram(compiled.value))),
      );
      if (!decoded.ok) return decoded;
      const created = api.createSession(decoded.value);
      if (!created.ok) return created;
      const session = created.value;
      const transition =
        c.phase === "transition" ? session.setControls(c.update) : undefined;
      return { revision: session.getRevision(), transition };
    });
}

test("typed engine agrees with Node across offline compilation, decoding and transactions", async ({
  page,
}, testInfo) => {
  const cases = JSON.parse(
    await readFile("conformance/cases.json", "utf8"),
  ).cases;
  const expected = JSON.parse(JSON.stringify(execute(engine, cases)));
  const dir = resolve("build/engine-browser", testInfo.project.name);
  await mkdir(dir, { recursive: true });
  const entry = resolve(dir, "entry.js");
  await writeFile(
    entry,
    `import * as api from ${JSON.stringify(resolve("packages/engine/dist/index.js"))};\nglobalThis.engineResult = (${execute.toString()})(api, ${JSON.stringify(cases)});`,
  );
  const bundle = await classicBundle(entry),
    html = resolve(dir, "index.html");
  await writeFile(
    html,
    '<!doctype html><meta charset="UTF-8"><title>Portable engine tests</title>' +
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
      JSON.parse(JSON.stringify(globalThis.engineResult)),
    ),
  ).toEqual(expected);
  expect(errors).toEqual([]);
  expect(network).toEqual([]);
});
