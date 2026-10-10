import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { previewHtml } from "../../apps/studio/dist/runtime/previewHtml.js";

const digest = (value, encoding) =>
  createHash("sha256").update(value).digest(encoding);

describe("supported opaque preview build output", () => {
  it("ships the identical trusted runtime used by Studio with verified hashes", async () => {
    const html = await readFile("build/preview.html", "utf8");
    const manifest = JSON.parse(
      await readFile("build/preview-runtime.json", "utf8"),
    );
    expect(html).toBe(previewHtml);
    expect(manifest.protocol).toBe("tinta-host-1");
    expect(manifest.htmlSha256).toBe(digest(html, "hex"));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(manifest.scriptHash).toBe(digest(scripts[0][1], "base64"));
    expect(manifest.styleHash).toBe(digest(styles[0][1], "base64"));
    expect(html).toContain(`script-src 'sha256-${manifest.scriptHash}'`);
    expect(html).toContain(`style-src 'sha256-${manifest.styleHash}'`);
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "font-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "img-src data: blob:",
    ])
      expect(html).toContain(directive);
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval|<script\s+src=/);
  });

  it("contains the engine, reader and chart geometry without the editor shell", async () => {
    const manifest = JSON.parse(
      await readFile("build/preview-runtime.json", "utf8"),
    );
    for (const owner of ["engine", "reader", "charts", "artifacts"])
      expect(
        manifest.inputs.some((path) => path.startsWith(`packages/${owner}/`)),
      ).toBe(true);
    expect(
      manifest.inputs.filter((path) => path.startsWith("apps/studio/")),
    ).toEqual(["apps/studio/dist/protocol.js", "apps/studio/dist/preview.js"]);
    expect(
      manifest.inputs.some((path) =>
        /node_modules\/(?:react|react-dom|@codemirror)\//.test(path),
      ),
    ).toBe(false);
  });
});
