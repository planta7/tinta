import { test, expect } from "./fixtures.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classicBundle, inlineScript } from "../../scripts/packaging.mjs";

test("production helpers load in an offline classic file artifact", async ({
  page,
}, testInfo) => {
  const imports = [];
  let index = 0;
  for (const owner of ["syntax", "engine", "charts", "artifacts", "studio"]) {
    const manifest = resolve(
      owner === "studio"
        ? "apps/studio/package.json"
        : `packages/${owner}/package.json`,
    );
    const require = createRequire(manifest),
      pkg = JSON.parse(await readFile(manifest, "utf8"));
    for (const name of Object.keys(pkg.dependencies).filter(
      (n) => !n.startsWith("@tinta-lang/"),
    )) {
      const specifier =
        name === "@noble/hashes" ? "@noble/hashes/sha2.js" : name;
      imports.push(
        `import * as helper${index++} from ${JSON.stringify(require.resolve(specifier))};`,
      );
    }
  }

  const dir = resolve("build/browser-smoke", testInfo.project.name);
  await mkdir(dir, { recursive: true });
  const entry = resolve(dir, "imports.js");
  await writeFile(
    entry,
    imports.join("\n") +
      `\nglobalThis.helperCounts = [${Array.from({ length: index }, (_, i) => `Object.keys(helper${i}).length`).join(",")}];`,
  );

  const bundle = await classicBundle(entry);
  const html = resolve(dir, "index.html");
  await writeFile(
    html,
    `<!doctype html><html lang="en"><title>Dependency smoke</title><body>${inlineScript(bundle.code)}</body></html>`,
  );

  const errors = [],
    network = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) network.push(r.url());
  });

  await page.context().setOffline(true);
  await page.goto(pathToFileURL(html).href);

  const counts = await page.evaluate(() => globalThis.helperCounts);

  expect(counts).toHaveLength(index);
  expect(counts.every((n) => n > 0)).toBe(true);
  expect(errors).toEqual([]);
  expect(network).toEqual([]);
});

test("reader and compiler worker build as standalone classic scripts", async ({
  page,
}, info) => {
  await page.goto(pathToFileURL(resolve("build/tinta-studio.html")).href);
  await expect(
    page.getByRole("heading", {
      name: "A document. With more to say.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New document", exact: true }),
  ).toBeVisible();
  const smoke = info.outputPath("reader-worker.html");
  await writeFile(
    smoke,
    '<!doctype html><html lang="en"><title>Runtime smoke</title><body></body></html>',
  );
  await page.goto(pathToFileURL(smoke).href);
  await page.addScriptTag({ path: "build/reader.js" });
  expect(
    await page.evaluate(
      () => typeof globalThis.TintaReaderRuntime.TintaReader.mountReader,
    ),
  ).toBe("function");

  const worker = await readFile("build/worker.js", "utf8");
  expect(
    await page.evaluate(
      (code) =>
        new Promise((resolve, reject) => {
          const url = URL.createObjectURL(
            new Blob([code + '\npostMessage("foundation-loaded");'], {
              type: "text/javascript",
            }),
          );

          const worker = new Worker(url);
          worker.onmessage = (e) => {
            worker.terminate();
            URL.revokeObjectURL(url);
            resolve(e.data);
          };
          worker.onerror = (e) => {
            worker.terminate();
            URL.revokeObjectURL(url);
            reject(e.message);
          };
        }),
      worker,
    ),
  ).toBe("foundation-loaded");
});
