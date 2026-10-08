import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { builtinModules } from "node:module";
export const edges = {
  types: [],
  syntax: ["types"],
  engine: ["types", "syntax"],
  charts: ["types", "engine"],
  reader: ["types", "engine", "charts"],
  artifacts: ["types", "syntax", "engine", "charts"],
  cli: ["types", "engine", "artifacts"],
  studio: ["types", "syntax", "engine", "charts", "reader", "artifacts"],
};
export function checkImport(owner, specifier) {
  if (
    specifier.startsWith("@tinta/") &&
    !edges[owner].includes(specifier.slice(7))
  )
    throw new Error(`Forbidden dependency: ${owner} -> ${specifier}`);
  if (
    owner !== "cli" &&
    (specifier.startsWith("node:") || builtinModules.includes(specifier))
  )
    throw new Error(`Host dependency in ${owner}: ${specifier}`);
  if (
    owner !== "studio" &&
    /^(react(?:-dom)?(?:\/|$)|@codemirror\/)/.test(specifier)
  )
    throw new Error(`Editor dependency in ${owner}`);
}
export function inspectSource(owner, text, filename = "input.ts") {
  const tree = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.ES2022,
    true,
  );
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      checkImport(owner, node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      throw new Error("Dynamic imports require an explicit capability review");
    if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text))
      throw new Error("String-to-code execution is forbidden");
    if (
      !["cli", "studio", "reader"].includes(owner) &&
      ts.isIdentifier(node) &&
      [
        "fetch",
        "localStorage",
        "indexedDB",
        "document",
        "window",
        "Date",
        "setTimeout",
      ].includes(node.text)
    )
      throw new Error(`Ambient capability in ${owner}: ${node.text}`);
    if (
      !["cli", "studio", "reader"].includes(owner) &&
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(tree) === "Math" &&
      node.name.text === "random"
    )
      throw new Error("Ambient randomness");
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
export function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
}
export function checkWorkspace(root = process.cwd()) {
  let count = 0;
  for (const owner of Object.keys(edges)) {
    const base = resolve(
      root,
      owner === "studio" ? "apps/studio" : `packages/${owner}`,
    );
    const manifest = JSON.parse(readFileSync(`${base}/package.json`, "utf8"));
    if (manifest.private !== true) throw new Error(`Public package: ${owner}`);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      checkImport(owner, dependency);
    for (const file of files(`${base}/src`).filter((p) => p.endsWith(".ts"))) {
      const text = readFileSync(file, "utf8");
      inspectSource(owner, text, file);
      const tree = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.ES2022,
        true,
      );
      for (const node of tree.statements)
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text.startsWith(".")
        ) {
          const target = resolve(file, "..", node.moduleSpecifier.text);
          if (relative(base, target).startsWith(".."))
            throw new Error(`Cross-package relative import: ${file}`);
        }
      count++;
    }
  }
  return count;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(`Architecture PASS: ${checkWorkspace()} source files`);
