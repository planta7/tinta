import type { AssetStore, Program } from "@tinta/types";
import { compile, createSession } from "@tinta/engine";
import { imageDestinationEdits } from "@tinta/syntax";
import { requiredAssets } from "./assets.js";
import { normalizeAssetPath } from "./assets.js";
import { reject, unwrap } from "./common.js";

export function canonicalSource(
  program: Program,
  assets: AssetStore,
): { program: Program; assets: AssetStore } {
  const required = requiredAssets(program, assets);
  const destinations = new Map<string, string>();
  const visit = (nodes: Program["flow"]): void => {
    for (const node of nodes) {
      if (node.kind === "image")
        destinations.set(
          node.destination,
          required.get(normalizeAssetPath(node.destination))!.path,
        );
      if ("children" in node) visit(node.children);
      if (node.kind === "list")
        for (const item of node.items) visit(item.children);
      if (node.kind === "markdown-table")
        for (const row of [node.header, ...node.rows])
          for (const cell of row) visit(cell);
    }
  };
  visit(program.flow);
  const input = {
    text: program.source,
    uri: program.sourceUri,
    profile: program.profile,
  };
  const edits = unwrap(imageDestinationEdits(input, destinations));
  let text = program.source;
  for (const edit of edits)
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  const copied = unwrap(
    compile({
      text,
      uri:
        program.profile === "tinta"
          ? "tinta:/document.tinta"
          : "tinta:/document.md",
      profile: program.profile,
    }),
  );
  const controls = (value: Program): string =>
    JSON.stringify(
      value.declarations.filter((entry) =>
        ["slider", "toggle", "choice"].includes(entry.kind),
      ),
      (key, value: unknown) =>
        key === "id" || key === "span" ? undefined : value,
    );
  if (controls(program) !== controls(copied))
    reject("E_EXPORT_INVALID", "Source rebasing changed control definitions.");
  const session = unwrap(createSession(copied));
  session.destroy();
  return {
    program: copied,
    assets: new Map([...required.values()].map((asset) => [asset.path, asset])),
  };
}
