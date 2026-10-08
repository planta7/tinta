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
const manual = catalog.rules
  .filter((rule) => rule.manual)
  .map(({ id, authority, line, manual }) => ({
    id,
    authority,
    line,
    ...manual,
    executionStatus: "NOT_RUN",
  }));
const report = {
  status: issues.length ? "BLOCKED" : "MAPPED",
  executionStatus: "NOT_RUN",
  explanation:
    "Mapping integrity is separate from test execution and manual acceptance. A mapped requirement is not a conformance claim. Named manual records remain required.",
  counts: {
    clauses: clauses.length,
    diagnostics: catalog.diagnostics.length,
    limits: catalog.limits.length,
    references: catalog.references.length,
    manualObligations: manual.length,
  },
  issues,
  manual,
  diagnostics: catalog.diagnostics,
  limits: catalog.limits,
};
mkdirSync("reports/verification", { recursive: true });
writeFileSync(
  "reports/verification/traceability.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `${report.status}: ${clauses.length} clauses, ${catalog.diagnostics.length} diagnostics, ${catalog.limits.length} limits; ${manual.length} manual obligations remain separately recorded.`,
);
for (const issue of issues) console.error(issue);
process.exitCode = issues.length ? 1 : 0;
