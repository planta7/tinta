import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

export const digest = (text) => createHash("sha256").update(text).digest("hex");

export function authorityFiles() {
  return [
    ...readdirSync("spec")
      .filter((name) => name.endsWith(".md"))
      .map((name) => `spec/${name}`),
    ...readdirSync("docs")
      .filter((name) => /^0[1-8]_.*\.md$/.test(name))
      .map((name) => `docs/${name}`),
    "contracts/CONTRACT_RULES.md",
  ].sort();
}

export function authorityClauses(path, source = readFileSync(path, "utf8")) {
  const clauses = [];
  let section = "Introduction";
  let offset = 0;
  let fenced = false;
  for (const block of source.split(/\n\s*\n/)) {
    const start = source.indexOf(block, offset);
    offset = start + block.length;
    const heading = block.match(/^#{1,3} (.+)$/m);
    if (heading && block.startsWith("#")) {
      section = heading[1];
      continue;
    }
    const fences = block.match(/^```/gm)?.length ?? 0;
    const illustration = fenced || block.trimStart().startsWith("```");
    if (fences % 2) fenced = !fenced;
    if (!block.trim() || illustration) continue;
    clauses.push({
      authority: path,
      section,
      line: source.slice(0, start).split("\n").length,
      sha256: digest(block),
      text: block,
    });
  }
  return clauses;
}

function calleeRoot(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression))
    return calleeRoot(expression.expression);
  if (ts.isCallExpression(expression)) return calleeRoot(expression.expression);
  return undefined;
}

export function testDeclarations(path, source = readFileSync(path, "utf8")) {
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const tests = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ["test", "it"].includes(calleeRoot(node.expression))
    ) {
      const [name, callback] = node.arguments;
      if (
        name &&
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        const start = node.getStart(parsed);
        tests.push({
          path,
          line: parsed.getLineAndCharacterOfPosition(start).line + 1,
          title: name.getText(parsed),
          sha256: digest(node.getText(parsed)),
          body: node.getText(parsed),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return tests;
}

export function validateCoverage(
  catalog,
  clauses,
  registry,
  load = readFileSync,
) {
  const issues = [];
  if (Object.hasOwn(catalog, "executionStatus")) {
    issues.push(
      "Source mappings must remain expectations, not execution results.",
    );
  }
  for (const dependency of catalog.supportingInputs ?? []) {
    try {
      if (digest(load(dependency.path, "utf8")) !== dependency.sha256) {
        issues.push(`Changed supporting input: ${dependency.path}`);
      }
    } catch {
      issues.push(`Unreadable supporting input: ${dependency.path}`);
    }
  }
  const expected = new Map(
    clauses.map((clause) => [`${clause.authority}:${clause.sha256}`, clause]),
  );
  const covered = new Set();
  const references = new Map();
  for (const reference of catalog.references) {
    if (references.has(reference.id))
      issues.push(`Duplicate reference: ${reference.id}`);
    references.set(reference.id, reference);
    try {
      const source = load(reference.path, "utf8");
      if (reference.kind === "test") {
        if (digest(source) !== reference.fileSha256) {
          issues.push(`Changed test context: ${reference.id}`);
        }
        const candidates = testDeclarations(reference.path, source).filter(
          (test) => test.title === reference.title,
        );
        if (
          candidates.length !== 1 ||
          candidates[0].sha256 !== reference.sha256
        ) {
          issues.push(`Changed or missing test: ${reference.id}`);
        }
      } else if (reference.kind === "check") {
        if (digest(source) !== reference.sha256)
          issues.push(`Changed check: ${reference.id}`);
      } else {
        issues.push(`Unsupported reference kind: ${reference.id}`);
      }
    } catch {
      issues.push(`Unreadable reference: ${reference.id}`);
    }
  }
  const checkReferences = (entry, id) => {
    if (!entry.assertion?.trim())
      issues.push(`Missing assertion description: ${id}`);
    if (!entry.references?.length && !entry.inspection)
      issues.push(`Unmapped obligation: ${id}`);
    for (const ref of entry.references ?? []) {
      if (!references.has(ref)) issues.push(`Unknown reference ${ref}: ${id}`);
    }
    if (Object.hasOwn(entry, "manual")) {
      issues.push(`Unexpected process metadata: ${id}`);
    }
    if (
      entry.inspection &&
      ![
        "contract",
        "security",
        "accessibility",
        "performance",
        "distribution",
      ].includes(entry.inspection.kind)
    ) {
      issues.push(`Unknown inspection kind: ${id}`);
    }
    if (
      entry.inspection &&
      (typeof entry.inspection.procedure !== "string" ||
        !entry.inspection.procedure.trim() ||
        typeof entry.inspection.expected !== "string" ||
        !entry.inspection.expected.trim())
    ) {
      issues.push(`Incomplete behavior inspection: ${id}`);
    }
  };
  for (const rule of catalog.rules) {
    const key = `${rule.authority}:${rule.sha256}`;
    if (!expected.has(key))
      issues.push(`Changed or unknown clause: ${rule.id}`);
    if (covered.has(key)) issues.push(`Duplicate clause: ${rule.id}`);
    covered.add(key);
    checkReferences(rule, rule.id);
  }
  for (const [key, clause] of expected) {
    if (!covered.has(key))
      issues.push(`Unmapped clause: ${clause.authority}:${clause.line}`);
  }
  for (const [section, names] of [
    [
      "diagnostics",
      [...Object.keys(registry.errors), ...Object.keys(registry.warnings)],
    ],
    ["limits", Object.keys(registry.limits)],
  ]) {
    const entries = catalog[section];
    for (const name of names) {
      const matches = entries.filter((entry) => entry.name === name);
      if (matches.length !== 1)
        issues.push(`Missing or duplicate ${section}: ${name}`);
      else {
        checkReferences(matches[0], name);
        if (
          section === "limits" &&
          matches[0].value !== registry.limits[name]
        ) {
          issues.push(`Changed limit value: ${name}`);
        }
      }
    }
    for (const entry of entries) {
      if (!names.includes(entry.name))
        issues.push(`Unknown ${section}: ${entry.name}`);
    }
  }
  return issues;
}
