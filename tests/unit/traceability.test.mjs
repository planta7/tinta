import { expect, test } from "vitest";
import {
  authorityClauses,
  digest,
  testDeclarations,
  validateCoverage,
} from "../../scripts/traceability-model.mjs";

function fixture() {
  const text = "# Contract\n\nThe update is atomic.\n";
  const tests = 'test("atomic update", () => { expect(result).toBe(true); });';
  const [clause] = authorityClauses("spec/sample.md", text);
  const [declaration] = testDeclarations("tests/sample.mjs", tests);
  const reference = {
    id: "atomic",
    kind: "test",
    ...declaration,
    fileSha256: digest(tests),
  };
  const mapping = {
    assertion: "The old revision survives rejection.",
    references: ["atomic"],
  };
  return {
    catalog: {
      executionStatus: "NOT_RUN",
      references: [reference],
      rules: [{ id: "RULE-001", ...clause, ...mapping }],
      diagnostics: [{ name: "E_LIMIT", ...mapping }],
      limits: [{ name: "rows", value: 2, kind: "maximum", ...mapping }],
    },
    clauses: [clause],
    registry: {
      errors: { E_LIMIT: "Limit exceeded" },
      warnings: {},
      limits: { rows: 2 },
    },
    read: () => tests,
  };
}

function check(value) {
  return validateCoverage(
    value.catalog,
    value.clauses,
    value.registry,
    value.read,
  );
}

test("clause inventory excludes fenced examples but preserves table obligations", () => {
  const clauses = authorityClauses(
    "spec/sample.md",
    [
      "# Contract",
      "",
      "## Behaviour",
      "",
      "Must be atomic.",
      "",
      "```text",
      "Illustration",
      "```",
      "",
      "| Bound | Value |",
      "|---|---|",
      "| rows | 2 |",
      "",
    ].join("\n"),
  );
  expect(clauses).toHaveLength(2);
  expect(clauses[0].section).toBe("Behaviour");
  expect(clauses[1].text).toContain("| rows | 2 |");
});

test("a complete mapping remains distinct from execution evidence", () => {
  const value = fixture();
  expect(check(value)).toEqual([]);
  value.catalog.executionStatus = "PASS";
  expect(check(value)).toContain(
    "Source mappings must remain expectations, not execution results.",
  );
});

test("new or changed clauses require review even when old references still exist", () => {
  const value = fixture();
  value.clauses.push(...authorityClauses("spec/new.md", "A new obligation."));
  expect(check(value)).toContain("Unmapped clause: spec/new.md:1");
  value.catalog.rules[0].sha256 = digest("changed");
  expect(check(value)).toContain("Changed or unknown clause: RULE-001");
});

test("removed assertions and changed fixture context invalidate a reference", () => {
  const value = fixture();
  value.read = () => 'test("atomic update", () => {});';
  expect(check(value)).toContain("Changed or missing test: atomic");
  value.read = () =>
    'const input = "different"; test("atomic update", () => { expect(result).toBe(true); });';
  expect(check(value)).toContain("Changed test context: atomic");
});

test("missing diagnostic, changed limit and dangling references cannot hide coverage gaps", () => {
  const value = fixture();
  value.catalog.diagnostics = [];
  value.catalog.limits[0].value = 3;
  value.catalog.rules[0].references = ["missing"];
  expect(check(value)).toEqual(
    expect.arrayContaining([
      "Missing or duplicate diagnostics: E_LIMIT",
      "Changed limit value: rows",
      "Unknown reference missing: RULE-001",
    ]),
  );
});

test("manual obligations require a concrete procedure and expected observation", () => {
  const value = fixture();
  value.catalog.rules[0].references = [];
  expect(check(value)).toContain("Unmapped obligation: RULE-001");
  value.catalog.rules[0].manual = { review: "keyboard-visual" };
  expect(check(value)).toContain("Incomplete manual procedure: RULE-001");
});
