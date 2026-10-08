import type {
  Artifact,
  AssetStore,
  ExportOptions,
  ResolvedNode,
  Result,
  Session,
} from "@tinta/types";
import { createSession, encodeProgram } from "@tinta/engine";
import { chartScene } from "@tinta/charts";
import {
  artifact,
  attempt,
  base64,
  encodeUtf8,
  hash,
  limits,
  reject,
  unwrap,
  utf8ByteLength,
} from "./common.js";
import { normalizeAssetPath, validateAssets } from "./assets.js";

import { canonicalSource } from "./source.js";
import { createStateSnapshot } from "./state.js";
import { readerCode, readerStyle } from "./runtime-data.js";

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const attributes = (
  values: Readonly<Record<string, string | number | boolean>>,
): string =>
  Object.entries(values)
    .filter(([, value]) => value !== false)
    .map(([key, value]) => ` ${key}="${escapeHtml(String(value))}"`)
    .join("");
const css =
  `.tinta-reader{max-width:800px;margin:auto;padding:1rem;` +
  `color:#1f2328;background:#fff;font:18px/1.6 system-ui,sans-serif}` +
  `img,svg{max-width:100%;height:auto}` +
  `table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}` +
  `th,td{border:1px solid #666;padding:.3rem;text-align:left}` +
  `pre{white-space:pre-wrap}a{color:#005a9c}` +
  `@media print{details{display:block}table{display:table;font-size:10pt}` +
  `figure{break-inside:avoid}}`;

export function staticNodes(
  nodes: readonly ResolvedNode[],
  assets: AssetStore,
  budget = { bytes: 0 },
): string {
  const render = (node: ResolvedNode): string => {
    if (node.kind === "text") return escapeHtml(node.value);
    if (node.kind === "control")
      return (
        `<p><strong>${escapeHtml(node.definition.label)}</strong>: ` +
        `${escapeHtml(String(node.value))}</p>`
      );
    if (node.kind === "image") {
      const asset = assets.get(normalizeAssetPath(node.destination));
      if (!asset)
        reject("E_ASSET_MISSING", "A visible image was not supplied.");
      if (
        budget.bytes + Math.ceil(asset.bytes.length / 3) * 4 >
        limits.htmlBytes
      )
        reject("E_LIMIT", "HTML image expansion exceeds the byte limit.");
      return (
        `<img src="data:${asset.mime};base64,${base64(asset.bytes)}"` +
        ` alt="${escapeHtml(node.alt)}"` +
        (node.title === undefined ? "" : ` title="${escapeHtml(node.title)}"`) +
        `>`
      );
    }
    if (node.kind === "chart") {
      const chart = node.chart,
        scene = chartScene(chart, 720);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg"` +
        ` viewBox="0 0 ${scene.width} ${scene.height}" role="img"` +
        ` aria-label="${escapeHtml(chart.title)}">` +
        scene.nodes
          .map(
            (item) =>
              `<${item.tag}${attributes(item.attributes)}>` +
              `${escapeHtml(item.text ?? "")}</${item.tag}>`,
          )
          .join("") +
        `</svg>`;
      const table =
        `<table><caption>${escapeHtml(chart.title)} — complete data ` +
        `(${chart.table.rows.length} rows)</caption><thead><tr>` +
        chart.table.columns
          .map((column) => `<th scope="col">${escapeHtml(column.name)}</th>`)
          .join("") +
        `</tr></thead><tbody>` +
        chart.table.rows
          .map(
            (row) =>
              `<tr>` +
              row.cells
                .map((cell) => `<td>${escapeHtml(String(cell))}</td>`)
                .join("") +
              `</tr>`,
          )
          .join("") +
        `</tbody></table>`;
      return (
        `<figure><figcaption>${escapeHtml(chart.title)}</figcaption>` +
        `${svg}<p>${escapeHtml(scene.message)}</p>${table}</figure>`
      );
    }
    const content = staticNodes(node.children, assets, budget);
    return (
      `<${node.tag}${attributes(node.attributes)}` +
      (node.tag === "a" && !String(node.attributes.href).startsWith("#")
        ? ' target="_blank" rel="noopener noreferrer"'
        : "") +
      (node.tag === "input"
        ? ` aria-label="${node.attributes.checked ? "Completed task" : "Incomplete task"}"`
        : "") +
      `${node.tag === "details" ? " open" : ""}>` +
      (["br", "hr", "input"].includes(node.tag)
        ? ""
        : `${content}</${node.tag}>`)
    );
  };
  return nodes
    .map((node) => {
      const before = budget.bytes;
      const rendered = render(node);
      budget.bytes += utf8ByteLength(rendered) - (budget.bytes - before);
      if (budget.bytes > limits.htmlBytes)
        reject("E_LIMIT", "HTML byte limit exceeded.");
      return rendered;
    })
    .join("");
}
export function staticHtml(
  session: Session,
  assets: AssetStore,
  options: ExportOptions,
): Artifact {
  const checked = validateAssets(assets);
  const selected = unwrap(
    createSession(
      session.program,
      options.answers === "current"
        ? { baseline: session.getRevision().state }
        : undefined,
    ),
  );
  try {
    const content = staticNodes(selected.getRevision().nodes, checked);
    const digest = base64(
      Uint8Array.from(
        hash(encodeUtf8(css))
          .match(/../g)!
          .map((byte) => parseInt(byte, 16)),
      ),
    );
    const policy =
      `default-src 'none'; script-src 'none'; style-src 'sha256-${digest}'; ` +
      `img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; ` +
      `base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'`;
    const html =
      `<!doctype html><html lang="${session.program.metadata.locale}">` +
      `<head><meta charset="UTF-8">` +
      `<meta http-equiv="Content-Security-Policy"` +
      ` content="${escapeHtml(policy)}">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(session.program.metadata.title)}</title>` +
      `<style>${css}</style></head><body>` +
      `<article class="tinta-reader">${content}</article></body></html>`;
    const bytes = encodeUtf8(html);
    if (bytes.length > limits.htmlBytes)
      reject("E_LIMIT", "HTML byte limit exceeded.");
    return artifact(bytes, "text/html", "document.html");
  } finally {
    selected.destroy();
  }
}
export async function exportHtml(
  session: Session,
  assets: AssetStore,
  options: ExportOptions,
): Promise<Result<Artifact>> {
  return attempt(() => {
    if (
      !["static", "interactive"].includes(options.format) ||
      !["initial", "current"].includes(options.answers)
    )
      reject("E_EXPORT_INVALID", "Invalid export options.");
    if (options.format === "interactive")
      return interactiveHtml(session, assets, options);
    return staticHtml(session, assets, options);
  });
}

function interactiveHtml(
  session: Session,
  assets: AssetStore,
  options: ExportOptions,
): Artifact {
  const copy = canonicalSource(session.program, assets);
  const baseline =
    options.answers === "current" ? session.getRevision().state : undefined;
  const chosen = unwrap(
    createSession(copy.program, baseline ? { baseline } : undefined),
  );
  try {
    const envelope = {
      kind: "tinta-interactive",
      formatVersion: "1.0",
      engineVersion: "0.0.0",
      abi: "tinta-ir-1",
      program: encodeProgram(copy.program),
      baseline: createStateSnapshot(chosen),
      assets: [...copy.assets.values()].map((asset) => ({
        path: asset.path,
        mime: asset.mime,
        sha256: asset.sha256,
        base64: base64(asset.bytes),
      })),
    };
    const payload = JSON.stringify(envelope)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    const code =
      readerCode +
      `\nTintaExportRuntime.start("${hash(encodeUtf8(payload))}");\n`;
    if (/<\/script/i.test(code) || /<\/style/i.test(readerStyle))
      reject("E_EXPORT_INVALID", "Unsafe trusted runtime delimiter.");
    const digest = (value: string): string =>
      base64(
        Uint8Array.from(
          hash(encodeUtf8(value))
            .match(/../g)!
            .map((byte) => parseInt(byte, 16)),
        ),
      );
    const policy =
      `default-src 'none'; script-src 'sha256-${digest(code)}' ` +
      `'sha256-${digest(payload)}'; style-src 'sha256-${digest(readerStyle)}'; ` +
      `img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; ` +
      `base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'`;
    const fallback = staticNodes(chosen.getRevision().nodes, copy.assets);
    const notice =
      "This interactive file contains the complete source, all embedded data, " +
      "hidden explanations and image metadata. Hidden content is not private. " +
      "It does not send data anywhere.";
    const html =
      `<!doctype html><html lang="${copy.program.metadata.locale}">` +
      `<head><meta charset="UTF-8">` +
      `<meta http-equiv="Content-Security-Policy"` +
      ` content="${escapeHtml(policy)}">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(copy.program.metadata.title)}</title>` +
      `<style>${readerStyle}</style></head><body>` +
      `<details><summary>About this interactive file</summary>` +
      `<p>${notice}</p></details><main id="tinta-content">` +
      `<p>Interactivity requires JavaScript; ` +
      `the values below are the exported answers.</p>` +
      `<article class="tinta-reader">${fallback}</article></main>` +
      `<script type="application/json" id="tinta-payload">${payload}</script>` +
      `<script>${code}</script></body></html>`;
    const bytes = encodeUtf8(html);
    if (bytes.length > limits.htmlBytes)
      reject("E_LIMIT", "HTML byte limit exceeded.");
    return artifact(bytes, "text/html", "document.html");
  } finally {
    chosen.destroy();
  }
}
