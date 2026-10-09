import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  authorityClauses,
  authorityFiles,
  validateCoverage,
} from "./traceability-model.mjs";

const catalog = JSON.parse(
  readFileSync("conformance/rule-coverage.json", "utf8"),
);
const registry = JSON.parse(readFileSync("spec/registry.json", "utf8"));
const clauses = authorityFiles().flatMap((path) => authorityClauses(path));
const issues = validateCoverage(catalog, clauses, registry);
const inspections = catalog.rules
  .filter((rule) => rule.inspection)
  .map(({ id, authority, line, inspection }) => ({
    id,
    authority,
    line,
    ...inspection,
  }));
const report = {
  status: issues.length ? "BLOCKED" : "MAPPED",
  explanation:
    "This report checks references and contract mappings. It does not execute tests or perform the described behavior inspections.",
  counts: {
    clauses: clauses.length,
    diagnostics: catalog.diagnostics.length,
    limits: catalog.limits.length,
    references: catalog.references.length,
    behaviorInspections: inspections.length,
  },
  issues,
  inspections,
  diagnostics: catalog.diagnostics,
  limits: catalog.limits,
};
mkdirSync("reports/verification", { recursive: true });
writeFileSync(
  "reports/verification/traceability.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `${report.status}: ${clauses.length} clauses, ${catalog.diagnostics.length} diagnostics, ${catalog.limits.length} limits; ${inspections.length} behavior inspections.`,
);
for (const issue of issues) console.error(issue);
process.exitCode = issues.length ? 1 : 0;
