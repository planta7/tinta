import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse, enrichMarkdown } from "../../packages/syntax/dist/index.js";

const parseErrors = new Set([
  "E_DIRECTIVE_UNKNOWN",
  "E_BLOCK_UNCLOSED",
  "E_BLOCK_END",
  "E_BLOCK_EMPTY",
  "E_DECLARATION_SCOPE",
  "E_PROPERTY_DUPLICATE",
  "E_PROPERTY_UNKNOWN",
  "E_META_POSITION",
  "E_EXPRESSION_SYNTAX",
  "E_NAME_RESERVED",
  "E_DATA_HEADER",
  "E_DATA_ARITY",
  "E_DATA_VALUE",
]);

/** Assert only syntax/enrichment; never substitute parse acceptance for compilation or evaluation. */
export function assertParseCase(fixture) {
  const input = {
    text: fixture.source,
    uri: "tinta:conformance/" + fixture.id,
    profile: fixture.profile,
  };
  if (fixture.phase === "csv" || fixture.phase === "json")
    return {
      id: fixture.id,
      parse: "NOT_APPLICABLE",
      semantic: "NOT_RUN",
    };

  const result =
    fixture.phase === "enrich" ? enrichMarkdown(input) : parse(input);
  if (fixture.phase === "enrich") {
    assert.equal(result.ok, fixture.expect.ok);
    assert.equal(result.value.source, fixture.expect.exactSource);
    assert.equal(result.value.edits.length, fixture.expect.editCount);
    assert.equal(
      parse({
        ...input,
        profile: "tinta",
        text: result.value.source,
      }).ok,
      true,
    );
    return {
      id: fixture.id,
      enrich: "PASS",
      semantic: "NOT_APPLICABLE",
      edits: result.value.edits,
    };
  }

  if (parseErrors.has(fixture.expect.code)) {
    assert.equal(result.ok, false, fixture.id);
    assert.equal(result.diagnostics[0].code, fixture.expect.code, fixture.id);
  } else {
    assert.equal(
      result.ok,
      true,
      fixture.id + ": " + JSON.stringify(result.diagnostics),
    );
    assert.equal(result.value.source, fixture.source);
    assert.ok(result.value.tree.children.length > 0);
    const visit = (node) => {
      assert.ok(
        node.span.start.offset >= 0 &&
          node.span.end.offset <= fixture.source.length,
      );
      if (node.directive?.name === "calc" || node.directive?.name === "let")
        assert.ok(node.directive.expression);
      if (node.kind === "interpolation") assert.ok(node.expression);
      node.children.forEach(visit);
    };
    visit(result.value.tree);
  }
  return {
    id: fixture.id,
    parse: "PASS",
    semantic: "NOT_RUN",
    diagnostics: result.diagnostics,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const bytes = readFileSync("conformance/cases.json");
  const fixtures = JSON.parse(bytes).cases;
  const results = fixtures.map((fixture) => {
    try {
      return assertParseCase(fixture);
    } catch (error) {
      return {
        id: fixture.id,
        parse: "FAIL",
        semantic: "NOT_RUN",
        error: error.message,
      };
    }
  });

  const failed = results.filter((r) => r.parse === "FAIL").length;
  const report = {
    suite: "parsing",
    node: process.version,
    command: process.argv,
    fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
    results,
  };

  mkdirSync("reports/verification", { recursive: true });
  writeFileSync(
    "reports/verification/parse-conformance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `Parse conformance: ${results.filter((r) => r.parse === "PASS" || r.enrich === "PASS").length} passed, ${failed} failed; semantic/import evaluation NOT_RUN.`,
  );
  process.exitCode = failed ? 1 : 0;
}
