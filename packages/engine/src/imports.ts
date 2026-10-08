import { decodeUtf8, encodeUtf8, parse } from "@tinta/syntax";
import type {
  DataImport,
  DataImportOptions,
  ImportColumn,
  Result,
  Scalar,
  ScalarType,
} from "@tinta/types";
import { attempt, Budget, Failure, fail, scalarType } from "./common.js";
import { registry } from "./registry.js";

const span = {
  uri: "tinta:import",
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 0, line: 1, column: 1 },
};
const numberToken = /^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const validName = (name: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) &&
  !(registry.reservedIdentifiers as readonly string[]).includes(name);
function decode(bytes: Uint8Array, budget: Budget): string {
  budget.limit("importBytes", bytes.length);
  try {
    return decodeUtf8(bytes).replace(/^\uFEFF/, "");
  } catch {
    fail("E_ENCODING", span, "decode");
  }
}
function mapping(headers: readonly string[]): string[] {
  const used = new Set<string>();
  return headers.map((header) => {
    let name =
      header
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .replace(/[^A-Za-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "") || "column";
    if (
      /^[0-9]/.test(name) ||
      (registry.reservedIdentifiers as readonly string[]).includes(name)
    )
      name = "column_" + name;
    name = name.slice(0, 56);
    let candidate = name,
      index = 2;
    while (used.has(candidate)) candidate = `${name}_${index++}`;
    used.add(candidate);
    return candidate;
  });
}
function candidate(
  headers: string[],
  rows: Scalar[][],
  options: DataImportOptions,
  budget: Budget,
  json: boolean,
): DataImport {
  if (
    !validName(options.name) ||
    !headers.length ||
    headers.some((h) => !h.length) ||
    new Set(headers).size !== headers.length
  )
    fail("E_IMPORT_SCHEMA", span);
  budget.limit("tableColumns", headers.length);
  budget.limit("tableRows", rows.length);
  budget.limit("totalCells", rows.length * headers.length);
  const names = mapping(headers);
  const inferred: ImportColumn[] = headers.map((input, i) => {
    const cells = rows.map((row) => row[i]!);
    let type: ScalarType = "text";
    if (json) {
      type = scalarType(cells[0]!);
      if (cells.some((c) => scalarType(c) !== type))
        fail("E_IMPORT_SCHEMA", span);
    } else if (
      cells.length &&
      cells.every((c) => c === "true" || c === "false")
    )
      type = "boolean";
    else if (
      cells.length &&
      cells.every(
        (c) =>
          typeof c === "string" &&
          numberToken.test(c) &&
          c.length <= 128 &&
          Number.isFinite(Number(c)),
      )
    )
      type = "number";
    return { input, name: names[i]!, type };
  });
  const columns = options.columns ? [...options.columns] : inferred;
  if (
    columns.length !== headers.length ||
    new Set(columns.map((c) => c.name)).size !== columns.length ||
    columns.some(
      (c, i) =>
        c.input !== headers[i] ||
        !validName(c.name) ||
        !["text", "number", "boolean"].includes(c.type),
    )
  )
    fail("E_IMPORT_SCHEMA", span);
  const lines = [
    `@data ${options.name}`,
    columns.map((c) => `${c.name}:${c.type}`).join(" | "),
  ];
  for (const row of rows) {
    budget.charge();
    if (row.length !== headers.length) fail("E_IMPORT_SCHEMA", span);
    lines.push(
      columns
        .map((column, i) => {
          const value = row[i]!;
          if (
            json &&
            column.type !== "text" &&
            scalarType(value) !== column.type
          )
            fail("E_IMPORT_SCHEMA", span);
          if (column.type === "text") {
            const text = String(value);
            budget.limit("textValueUnits", text.length);
            return JSON.stringify(text);
          }
          if (column.type === "boolean") {
            if (
              value !== true &&
              value !== false &&
              value !== "true" &&
              value !== "false"
            )
              fail("E_IMPORT_SCHEMA", span);
            return String(value);
          }
          const token = String(value);
          if (
            !numberToken.test(token) ||
            token.length > 128 ||
            !Number.isFinite(Number(token))
          )
            fail("E_IMPORT_SCHEMA", span);
          return String(Number(token));
        })
        .join(" | "),
    );
  }
  lines.push("@end", "");
  const source = lines.join("\n");
  // A candidate must already fit the source parser's limits and string grammar.
  const parsed = parse({ uri: span.uri, profile: "tinta", text: source });
  if (!parsed.ok) fail("E_IMPORT_SCHEMA", span);
  return { source, columns, rowCount: rows.length };
}
export function importCsv(
  bytes: Uint8Array,
  options: DataImportOptions,
): Result<DataImport> {
  return attempt(() => {
    const budget = new Budget(span, "decode");
    const source = decode(bytes, budget),
      records: string[][] = [];
    let row: string[] = [],
      field = "",
      quoted = false,
      closed = false,
      start = true;
    const cell = (): void => {
      budget.limit("textValueUnits", field.length);
      row.push(field);
      budget.limit("tableColumns", row.length);
      field = "";
      closed = false;
      start = true;
    };
    const record = (): void => {
      const blank = row.length === 0 && field === "" && !closed;
      cell();
      if (blank) fail("E_IMPORT_SCHEMA", span);
      records.push(row);
      budget.limit("tableRows", records.length - 1);
      budget.limit("totalCells", Math.max(0, records.length - 1) * row.length);
      row = [];
    };
    for (let i = 0; i < source.length; i++) {
      budget.charge();
      const char = source[i]!;
      if (quoted) {
        if (char === '"') {
          if (source[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
            closed = true;
          }
        } else field += char;
      } else if (char === ",") cell();
      else if (char === "\n" || char === "\r") {
        record();
        if (char === "\r" && source[i + 1] === "\n") i++;
      } else if (char === '"' && start) {
        quoted = true;
        start = false;
      } else {
        if (closed || char === '"') fail("E_IMPORT_SCHEMA", span);
        field += char;
        start = false;
      }
      budget.limit("textValueUnits", field.length);
    }
    if (quoted) fail("E_IMPORT_SCHEMA", span);
    if (field.length || row.length || closed) record();
    const headers = records.shift();
    if (!headers || records.some((r) => r.length !== headers.length))
      fail("E_IMPORT_SCHEMA", span);
    return candidate(headers, records, options, budget, false);
  });
}
/** A bounded JSON reader detects repeated keys before they can be erased. */
export function importJson(
  bytes: Uint8Array,
  options: DataImportOptions,
): Result<DataImport> {
  return attempt(() => {
    const budget = new Budget(span, "decode");
    const source = decode(bytes, budget);
    let offset = 0;
    const space = (): void => {
      while (/[ \t\r\n]/.test(source[offset] ?? "x")) offset++;
    };
    const token = (expected: string): void => {
      space();
      if (source[offset++] !== expected) fail("E_IMPORT_SCHEMA", span);
    };
    const string = (): string => {
      space();
      const begin = offset;
      token('"');
      let escaped = false;
      while (offset < source.length) {
        budget.charge();
        const char = source[offset++]!;
        if (char === '"' && !escaped) {
          try {
            const value: unknown = JSON.parse(source.slice(begin, offset));
            if (typeof value !== "string") fail("E_IMPORT_SCHEMA", span);
            encodeUtf8(value);
            budget.limit("textValueUnits", value.length);
            return value;
          } catch (error) {
            if (error instanceof Failure) throw error;
            fail("E_IMPORT_SCHEMA", span);
          }
        }
        escaped = char === "\\" && !escaped;
      }
      fail("E_IMPORT_SCHEMA", span);
    };
    const scalar = (): Scalar => {
      space();
      if (source[offset] === '"') return string();
      const begin = offset;
      while (offset < source.length && !/[,}\s]/.test(source[offset]!))
        offset++;
      const raw = source.slice(begin, offset);
      if (raw === "true" || raw === "false") return raw === "true";
      if (
        !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw) ||
        raw.length > 128 ||
        !Number.isFinite(Number(raw))
      )
        fail("E_IMPORT_SCHEMA", span);
      return Number(raw) || 0;
    };
    const rows: Scalar[][] = [];
    let headers: string[] | undefined;
    token("[");
    space();
    if (source[offset] === "]") fail("E_IMPORT_SCHEMA", span);
    while (true) {
      token("{");
      space();
      const fields = new Map<string, Scalar>();
      if (source[offset] === "}") fail("E_IMPORT_SCHEMA", span);
      while (true) {
        const key = string();
        if (fields.has(key)) fail("E_IMPORT_SCHEMA", span);
        token(":");
        fields.set(key, scalar());
        budget.limit("tableColumns", fields.size);
        space();
        if (source[offset] === "}") {
          offset++;
          break;
        }
        token(",");
      }
      headers ??= [...fields.keys()];
      if (
        fields.size !== headers.length ||
        headers.some((key) => !fields.has(key))
      )
        fail("E_IMPORT_SCHEMA", span);
      rows.push(headers.map((key) => fields.get(key)!));
      budget.limit("tableRows", rows.length);
      budget.limit("totalCells", rows.length * headers.length);
      space();
      if (source[offset] === "]") {
        offset++;
        break;
      }
      token(",");
    }
    space();
    if (offset !== source.length) fail("E_IMPORT_SCHEMA", span);
    return candidate(headers, rows, options, budget, true);
  });
}
