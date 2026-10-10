import { readFileSync, readdirSync, existsSync } from "node:fs";
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
  cli: ["types", "engine", "artifacts", "local-files"],
  studio: ["types", "syntax", "engine", "charts", "reader", "artifacts"],
};

export const editorEdges = {
  "language-service": ["types", "syntax", "engine"],
  "language-server": ["types", "language-service"],
  "local-files": ["types", "artifacts"],
  vscode: ["types", "language-service", "local-files", "artifacts"],
  "vscode-webview": ["types", "engine", "reader", "artifacts"],
  "vscode-artifacts": ["types", "engine", "artifacts"],
};

const nodeCapabilities = {
  "local-files": new Set(["fs", "fs/promises", "path", "crypto", "buffer"]),
  "language-server": new Set([
    "worker_threads",
    "path",
    "url",
    "crypto",
    "events",
    "buffer",
    "process",
  ]),
  vscode: new Set(["path", "url", "crypto", "buffer", "worker_threads"]),
  "vscode-artifacts": new Set(["worker_threads"]),
};

export function ownerPath(owner) {
  return ["studio", "vscode"].includes(owner)
    ? `apps/${owner}`
    : `packages/${owner}`;
}

export function workspaceOwners(root = process.cwd()) {
  return [
    ...Object.keys(edges),
    ...Object.keys(editorEdges).filter(
      (owner) =>
        !["vscode-webview", "vscode-artifacts"].includes(owner) &&
        existsSync(resolve(root, ownerPath(owner))),
    ),
  ];
}

export function checkRelativeImport(owner, base, file, specifier) {
  const target = resolve(file, "..", specifier);
  const boundary =
    owner === "vscode-webview" ? resolve(base, "src/webview") : base;
  if (
    owner === "vscode" &&
    ["src/webview/", "src/artifact-worker/"].some((directory) =>
      relative(base, target).replaceAll("\\", "/").startsWith(directory),
    )
  )
    throw new Error(`Isolated runtime imported by native host: ${file}`);
  if (
    owner === "vscode-artifacts" &&
    !relative(base, target)
      .replaceAll("\\", "/")
      .startsWith("src/artifact-worker/") &&
    target !== resolve(base, "src/artifact-protocol.js")
  )
    throw new Error(`Native host imported by artifact worker: ${file}`);

  if (relative(boundary, target).startsWith(".."))
    throw new Error(`Cross-boundary relative import: ${file}`);
}

export function checkImport(owner, specifier) {
  if (specifier === "vscode" && owner !== "vscode")
    throw new Error(`VS Code API outside native host: ${owner}`);
  if (
    /^(vscode-language|@vscode\/)/.test(specifier) &&
    !(
      (owner === "vscode" &&
        ["vscode-languageclient", "vscode-languageclient/node"].includes(
          specifier,
        )) ||
      (owner === "language-server" &&
        ["vscode-languageserver", "vscode-languageserver/node"].includes(
          specifier,
        ))
    )
  )
    throw new Error(
      "Editor SDK dependencies require exact line/provenance approval",
    );

  if (
    specifier.startsWith("@tinta/") &&
    !(edges[owner] ?? editorEdges[owner] ?? []).includes(
      specifier.slice(7).split("/")[0],
    )
  )
    throw new Error(`Forbidden dependency: ${owner} -> ${specifier}`);

  if (
    owner !== "cli" &&
    (specifier.startsWith("node:") || builtinModules.includes(specifier)) &&
    !nodeCapabilities[owner]?.has(specifier.replace(/^node:/, ""))
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
      ![
        "cli",
        "studio",
        "reader",
        "vscode",
        "vscode-webview",
        "local-files",
        "language-server",
      ].includes(owner) &&
      ts.isIdentifier(node) &&
      !(
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node &&
        !["globalThis", "self", "global"].includes(
          node.parent.expression.getText(tree),
        )
      ) &&
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
      ![
        "cli",
        "studio",
        "reader",
        "vscode",
        "vscode-webview",
        "local-files",
        "language-server",
      ].includes(owner) &&
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(tree) === "Math" &&
      node.name.text === "random"
    )
      throw new Error("Ambient randomness");

    const denied = {
      "vscode-webview": [
        "fetch",
        "localStorage",
        "indexedDB",
        "process",
        "require",
      ],
      "language-server": [
        "fetch",
        "localStorage",
        "indexedDB",
        "document",
        "window",
        "require",
      ],
      "local-files": [
        "fetch",
        "localStorage",
        "indexedDB",
        "document",
        "window",
        "require",
      ],
      vscode: ["fetch", "localStorage", "indexedDB", "require"],
      "language-service": [
        "process",
        "require",
        "setInterval",
        "queueMicrotask",
        "performance",
      ],
    };

    if (ts.isIdentifier(node) && denied[owner]?.includes(node.text))
      throw new Error(`Forbidden host capability in ${owner}: ${node.text}`);

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

  for (const owner of workspaceOwners(root)) {
    const base = resolve(root, ownerPath(owner));
    const manifest = JSON.parse(readFileSync(`${base}/package.json`, "utf8"));
    if (manifest.private !== true) throw new Error(`Public package: ${owner}`);

    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      checkImport(owner, dependency);

    for (const file of files(`${base}/src`).filter((p) =>
      /\.[cm]?[jt]sx?$/.test(p),
    )) {
      const text = readFileSync(file, "utf8");
      const sourceOwner =
        owner === "vscode" &&
        relative(base, file).replaceAll("\\", "/").startsWith("src/webview/")
          ? "vscode-webview"
          : owner === "vscode" &&
              relative(base, file)
                .replaceAll("\\", "/")
                .startsWith("src/artifact-worker/")
            ? "vscode-artifacts"
            : owner;

      inspectSource(sourceOwner, text, file);
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
          checkRelativeImport(
            sourceOwner,
            base,
            file,
            node.moduleSpecifier.text,
          );
        }

      count++;
    }
  }

  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(`Architecture PASS: ${checkWorkspace()} source files`);
