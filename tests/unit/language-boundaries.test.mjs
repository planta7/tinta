import { expect, test } from "vitest";
import {
  compile,
  decodeProgram,
  encodeProgram,
} from "../../packages/engine/dist/index.js";

const input = (text) => ({
  text,
  uri: "tinta:language-boundaries",
  profile: "tinta",
});
function rejected(source, code) {
  const result = compile(input(source));
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty("value");
  expect(result.diagnostics.map((item) => item.code)).toContain(code);
  return result.diagnostics.find((item) => item.code === code);
}
function accepted(source) {
  const result = compile(input(source));
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  return result.value;
}

test("control labels and details summaries reject blank effective names without trimming valid text", () => {
  for (const blank of ["", " ", "\t\n", "\u00a0", "\u2003", "\ufeff"]) {
    for (const declaration of [
      "@toggle flag = true",
      "@slider amount = 1",
      '@choice answer = "A"',
    ]) {
      const options = declaration.startsWith("@choice")
        ? 'options: ["A"], '
        : "";
      const source = `${declaration} (${options}label: ${JSON.stringify(blank)})\n`;
      const diagnostic = rejected(source, "E_PROPERTY_VALUE");
      expect(
        source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
      ).toBe(JSON.stringify(blank));
    }
    rejected(
      `@details ${JSON.stringify(blank)}\nBody\n@end\n`,
      "E_PROPERTY_VALUE",
    );
  }
  rejected("@toggle ___ = true\n", "E_PROPERTY_VALUE");
  const program = accepted(
    '@toggle ___ = true (label: "  Visible label  ")\n@details\nBody\n@end\n',
  );
  expect(program.declarations.find((item) => item.name === "___").label).toBe(
    "  Visible label  ",
  );
  expect(decodeProgram(encodeProgram(program)).ok).toBe(true);
});

test("metadata permits only blanks and comments before it, not Markdown reference definitions", () => {
  accepted(
    '\ufeff\r\n<!-- Note -->\r\n\r\n@meta (title: "Allowed")\r\n# Heading\r\n',
  );
  const source = '[ref]: https://example.com\n\n@meta (title: "Late")\n';
  expect(rejected(source, "E_META_POSITION").span.start.line).toBe(3);
  rejected("# Heading\n@meta ()\n", "E_META_POSITION");
  rejected("@meta ()\n@meta ()\n", "E_META_POSITION");
  accepted("@meta ()\n\n[ref]: https://example.com\n\n[Link][ref]\n");
});

test("static options and selection bindings reject grouping while expression positions retain it", () => {
  for (const source of [
    '@toggle flag = true (label: ("Flag"))\n',
    '@meta (title: ("Title"))\n',
    '@choice answer = "A" (options: (["A"]))\n',
    '@choice answer = "A" (options: [("A")])\n',
    "@slider amount = 1 (min: - 1)\n",
  ])
    rejected(source, "E_PROPERTY_VALUE");
  rejected("@toggle flag = (true)\n", "E_DIRECTIVE_SYNTAX");
  const data =
    "@slider chosen = 1 (min: -1, max: +2)\n@data readings\nperiod:number | value:number\n1 | 2\n@end\n";
  rejected(
    data + '@chart line readings (x: "period", y: "value", select: (chosen))\n',
    "E_SELECTION_TARGET",
  );
  rejected(
    data + '@chart line readings (x: "period", y: ("value"))\n',
    "E_CHART_SERIES",
  );
  accepted(
    data +
      '@view visible = readings (where: (row.value > 0))\n@chart line visible (x: "period", y: (row.value * 2), select: chosen)\n@calc total = (sum(visible, "value"))\n{{ (total) }}\n',
  );
});

test("directive data examples use valid column names and retain reserved identifiers", () => {
  accepted(
    '@slider minimum = 0\n@data reading\nperiod:number | readings:number | completed:boolean\n0 | 100 | false\n1 | 105 | true\n@end\n@view visible = reading (where: row.readings >= minimum, sort: "period", descending: false)\n@chart bar visible (x: "period", y: "readings", title: "Readers by period")\n',
  );
  rejected("@data reading\ncount:number\n1\n@end\n", "E_DATA_HEADER");
});
