import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  compile,
  createSession,
  importCsv,
  importJson,
} from "../../packages/engine/dist/index.js";
import { enrichMarkdown } from "../../packages/syntax/dist/index.js";

export function observe(fixture) {
  const input = {
    text: fixture.source,
    uri: "tinta:conformance/" + fixture.id,
    profile: fixture.profile,
  };
  if (fixture.phase === "csv" || fixture.phase === "json") {
    const result = (fixture.phase === "csv" ? importCsv : importJson)(
      new TextEncoder().encode(fixture.source),
      { name: fixture.importName },
    );
    return {
      result,
      ...(result.ok
        ? {
            columnTypes: result.value.columns.map((c) => c.type),
            rowCount: result.value.rowCount,
          }
        : {}),
    };
  }
  if (fixture.phase === "enrich") {
    const result = enrichMarkdown(input);
    return {
      result,
      ...(result.ok
        ? {
            exactSource: result.value.source,
            editCount: result.value.edits.length,
          }
        : {}),
    };
  }
  const compiled = compile(input);
  if (!compiled.ok || fixture.phase === "compile") return { result: compiled };
  const initial = createSession(compiled.value);
  if (!initial.ok) return { result: initial };
  const session = initial.value;
  const result =
    fixture.phase === "transition"
      ? session.setControls(fixture.update)
      : initial;
  const current = session.getRevision();
  const flat = [];
  const walk = (nodes) =>
    nodes.forEach((n) => {
      flat.push(n);
      if (n.children) walk(n.children);
    });
  walk(current.nodes);
  const charts = flat
    .filter((n) => n.kind === "chart")
    .map((n) => ({
      type: n.chart.type,
      pointCount: n.chart.points.length,
      seriesCount: n.chart.series.length,
      empty: n.chart.empty,
      yValues: n.chart.points.map((p) => p.y),
      binCounts: n.chart.bins.map((b) => b.count),
      binEdges: n.chart.bins.length
        ? [n.chart.bins[0].lower, ...n.chart.bins.map((b) => b.upper)]
        : [],
    }));
  return {
    result,
    warningCodes: [...compiled.diagnostics, ...result.diagnostics]
      .filter((d) => d.severity === "warning")
      .map((d) => d.code),
    revision: current.number,
    controls: current.state,
    values: current.values,
    controlCount: Object.keys(current.state).length,
    rowCounts: Object.fromEntries(
      Object.entries(current.tables).map(([k, v]) => [k, v.rows.length]),
    ),
    tableRows: Object.fromEntries(
      Object.entries(current.tables).map(([k, v]) => [
        k,
        v.rows.map((r) => r.cells),
      ]),
    ),
    text: flat
      .filter((n) => n.kind === "text")
      .map((n) => n.value)
      .join("\n"),
    charts,
  };
}

export function assertSemanticCase(fixture) {
  const observed = observe(fixture),
    expected = fixture.expect;
  assert.equal(
    observed.result.ok,
    expected.ok,
    fixture.id + ": " + JSON.stringify(observed.result.diagnostics),
  );
  const deferred = [];
  for (const [key, value] of Object.entries(expected)) {
    if (key === "ok") continue;
    if (key === "code")
      assert.ok(
        observed.result.diagnostics.some((d) => d.code === value),
        JSON.stringify(observed.result.diagnostics),
      );
    else if (key === "textContains")
      value.forEach((v) =>
        assert.ok(observed.text.includes(v), `${fixture.id}: missing ${v}`),
      );
    else if (key === "textExcludes")
      value.forEach((v) => assert.ok(!observed.text.includes(v)));
    else if (key === "warningCodes")
      value.forEach((v) =>
        assert.ok(
          observed.warningCodes.includes(v),
          `${fixture.id}: missing ${v}`,
        ),
      );
    else if (key === "noAuthorExecution" || key === "noActiveUnsafeLinks")
      deferred.push({
        assertion: key,
        status: "NOT_RUN",
        reason: "Requires browser effect verification.",
      });
    else if (key === "charts") {
      assert.equal(observed.charts.length, value.length);
      value.forEach((chart, i) =>
        Object.entries(chart).forEach(([k, v]) =>
          assert.deepEqual(observed.charts[i][k], v),
        ),
      );
    } else if (["controls", "values", "rowCounts", "tableRows"].includes(key))
      Object.entries(value).forEach(([k, v]) =>
        assert.deepEqual(observed[key][k], v),
      );
    else assert.deepEqual(observed[key], value);
  }
  return {
    id: fixture.id,
    semantic: "PASS",
    expected,
    observed: {
      ...observed,
      result: {
        ok: observed.result.ok,
        diagnostics: observed.result.diagnostics,
      },
    },
    deferred,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const bytes = readFileSync("conformance/cases.json");
  const results = JSON.parse(bytes).cases.map((fixture) => {
    try {
      return assertSemanticCase(fixture);
    } catch (error) {
      return {
        id: fixture.id,
        semantic: "FAIL",
        expected: fixture.expect,
        error: error.message,
      };
    }
  });
  const failed = results.filter((r) => r.semantic === "FAIL");
  mkdirSync("reports/verification", { recursive: true });
  writeFileSync(
    "reports/verification/semantic-conformance.json",
    JSON.stringify(
      {
        node: process.version,
        command: process.argv,
        fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
        results,
      },
      null,
      2,
    ) + "\n",
  );
  failed.forEach((r) => console.error(r.id, r.error));
  console.log(
    `Semantic conformance: ${results.length - failed.length} passed, ${failed.length} failed; browser effects NOT_RUN.`,
  );
  process.exitCode = failed.length ? 1 : 0;
}
