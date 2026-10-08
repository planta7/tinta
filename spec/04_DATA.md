# Tables, views and local data import

## Typed data syntax

The header is one nonblank line of `identifier:type` cells separated by `|`. Types are exactly `text`, `number` and `boolean`. There is no Markdown separator line or optional outer bars. Each subsequent nonblank line has exactly the same cell count. Maximums are in the limit registry. At least one column is required; zero data rows is legal.

```tinta
@data notes
name:text | score:number | approved:boolean
First draft | 9.5 | false
"A title with | inside" | 10 | true
"  Preserve these spaces  " | 8 | false
"" | 0 | false
@end
```

Split rows at unquoted pipe characters. A double quote starts a quoted cell only when it is the first non-space/tab character of that cell. A quoted text cell is a complete JSON string; after its closing quote only spaces/tabs and a separator/end of line are legal. JSON `\n` is decoded into a newline inside the cell value; it does not split source rows. JSON escapes are the only cell escape language; use a quoted string for a pipe. An unquoted text cell is trimmed of leading/trailing ASCII space/tab; internal characters are literal, including braces and Markdown. An empty unquoted text cell is an error; use `""`. Quotes that occur after the first unquoted character are literal.

Numeric cells accept a signed numeric literal and surrounding ASCII space/tab only. No formulas, decimal commas, separators, quoted numbers or empty values. Boolean cells accept only lowercase true/false. No null, NaN, infinity, missing cells, nested data or inferred mixed types. Rows with extra or missing cells are `E_DATA_ARITY`; bad scalar parsing is `E_DATA_VALUE`; duplicate/invalid header names are diagnosed before rows.

The `@end` delimiter must be at physical column 1. A one-column text value `@end` must therefore be quoted; the quotes are not an optional decoration in that case. Data rows may have leading spaces for visual alignment; those spaces are not a structural indentation system.

## Table value and row identity

Each table has an ordered schema and ordered immutable rows. Each row's ID is `<table declaration node ID>:<zero-based original row index>`. Views preserve those IDs and the original row payloads, not object copies with new identity. An input edit produces a new program and may produce new IDs; state reconciliation never relies on row IDs across arbitrary source edits.

Neither a view nor a chart can mutate a table. Cells are scalars. Table values may be passed to the defined aggregate functions only, not interpolated as an object, indexed, serialized by author code or assigned to a scalar control.

## Filtering and ordering

Evaluate where for every incoming row using `row.field` and global state. The result must be boolean for every row, including when a different row would already determine a count. Preserve order among accepted rows. If sort exists, apply a stable sort on that column. Numbers sort numerically, text sorts by Unicode code-point lexicographic order (not locale collation), and false sorts before true. Descending reverses the primary comparison, not the stable input-index tie break. Empty views retain the schema.

A view of a view sees only the earlier view's rows. All references, row-field types and cycles are validated even for empty data. A control update re-evaluates views and every dependent aggregate/figure in the same transaction. Legend visibility is not a view filter and never changes aggregate totals.

## Local CSV import

CSV is an **editor/CLI import operation**, not a runtime language feature. UTF-8 only, optional BOM, comma delimiter, RFC-4180-style double-quote escaping, CRLF/LF/CR records, first record header. A trailing record separator does not create an extra empty record; other blank records are errors. Commas and line breaks inside a quoted cell are allowed. Delimiter auto-detection, semicolon/TSV, comments and Excel-specific formats are outside V1.

Parse completely within file/row/cell limits before presenting a candidate. Require unique nonempty header strings; map them to Tinta identifiers with this deterministic algorithm: Unicode NFKD, remove marks, replace every non-ASCII alphanumeric/underscore run with `_`, trim `_`, use `column` if empty, prefix `column_` when the result starts with a digit or is reserved, truncate to 56 ASCII characters, then append `_2`, `_3`, etc. for collisions. Present the mapping and permit explicit edits to valid unique identifiers before commit. Do not change headers silently.

Infer one type per column using **all rows**, never a sample: boolean if every cell is exactly true/false; otherwise number if every cell is a valid finite signed numeric token with no leading-zero ambiguity; otherwise text. Empty cells force text. A column with no rows defaults to text. Do not interpret dates, formulas, percentages, currencies or leading-zero strings as numbers. `00123` remains text. The user may explicitly choose any supported type; conversion failure blocks import and identifies the first failing row. Text is always available. Numeric conversion never evaluates formulas such as `=1+1`.

Serialize approved values into one root `@data` block, quoting text with JSON string encoding. The operation inserts one undoable source edit at the nearest root boundary after the current selection; if the cursor is inside a Markdown/Tinta block, insert after that complete outer root block. The dialog shows the exact insertion point and generated block before confirmation. The chosen table name must be valid and unused; default is a normalized filename with `_2` suffixes as needed. Importing data does not retain the original file path or a live reference.

## Local JSON import

Accept a UTF-8 JSON array of flat objects only. No JSON5, comments, duplicate object keys, nested arrays/objects, null values, mixed row schemas or non-finite numbers. All objects must have exactly the same property set; order of schema is the first object's property order, remaining objects may list keys differently. Keys are mapped with the same identifier algorithm as CSV. Each column must have one scalar type across all rows. An empty array is `E_IMPORT_SCHEMA` because there is no column schema. JSON strings that look numeric remain text; no coercion. Bounds are checked during parsing before a large allocation is accepted.

The editor presents type/schema preview and can rename columns but cannot flatten nested JSON automatically. Unsupported input gets a clear error, not an invented schema. Approval produces embedded `@data` source; there is no JSON runtime loader.

## Import atomicity and errors

Source and asset collections change only after the user accepts a valid candidate. Cancel leaves the document unchanged. The operation participates in editor undo/redo. A bad import cannot overwrite a previous declaration or clear the editor. Import warnings are not language compile errors; a committed block must itself pass the syntax/schema validation of the new source. File content must never be logged or transmitted.
