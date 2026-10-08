# Resource limits and diagnostics

`spec/registry.json` is the machine-readable source of names and numeric bounds. Limits are ceilings, not performance promises. A conforming implementation cannot silently sample/truncate source, rows, charts or resources to fit them. Return an explicit error before accepting the oversized object. A caller may set stricter limits through the embedding API; it may not weaken the reference safety profile while claiming V1 conformance.

## Limits

Bytes are binary byte counts; units refer to UTF-16 code units unless code points is named. `tableCount` counts source tables plus views. `totalCells` counts cells in source tables, not view references to those rows. `declarations` counts constants/calculations/controls/tables/views. `chartCount` is syntactic across all branches; chart-mark limits concern a visible evaluated revision. `bundleEntries` includes manifest/source/assets. `sourceLineUnits` includes indentation, not newline bytes. Asset totals count unique content hashes.

| Limit | Maximum |
|---|---:|
| `sourceBytes` | 2097152 |
| `sourceLineUnits` | 65536 |
| `expressionUnits` | 8192 |
| `expressionDepth` | 32 |
| `astNodes` | 100000 |
| `tintaBlockDepth` | 16 |
| `markdownDepth` | 64 |
| `declarations` | 512 |
| `controls` | 128 |
| `identifierUnits` | 64 |
| `textValueUnits` | 65536 |
| `literalListItems` | 1000 |
| `tableCount` | 64 |
| `tableRows` | 10000 |
| `tableColumns` | 64 |
| `totalCells` | 100000 |
| `chartRows` | 2000 |
| `chartCategories` | 200 |
| `chartSectors` | 24 |
| `chartSeries` | 6 |
| `chartMarks` | 12000 |
| `documentChartMarks` | 32000 |
| `chartCount` | 32 |
| `histogramBinsMin` | 2 |
| `histogramBinsMax` | 30 |
| `histogramBinsDefault` | 8 |
| `choiceOptions` | 50 |
| `choiceOptionCodePoints` | 120 |
| `labelCodePoints` | 200 |
| `sliderTicks` | 100000 |
| `sliderFractionalDigits` | 6 |
| `sliderMagnitude` | 1000000000 |
| `evaluationOperations` | 2000000 |
| `compileOperations` | 5000000 |
| `diagnostics` | 100 |
| `importBytes` | 5242880 |
| `assetCount` | 100 |
| `assetBytes` | 10485760 |
| `totalAssetBytes` | 26214400 |
| `imagePixels` | 20000000 |
| `bundleCompressedBytes` | 31457280 |
| `bundleExpandedBytes` | 31457280 |
| `bundleEntries` | 102 |
| `htmlBytes` | 41943040 |
| `workerWatchdogMs` | 3000 |
| `editorDebounceMs` | 200 |
| `recoveryDebounceMs` | 1000 |
| `recoveryEntries` | 10 |
| `recoveryTotalBytes` | 31457280 |

`compileOperations` counts one per tokenizer state transition, emitted AST node, binding resolution edge and semantic visitor step. `evaluationOperations` counts one per visited expression node, row predicate, sort comparison, aggregate addition, chart-datum preparation and generated data mark. Built-in `pow` counts as one bounded native operation after argument evaluation. Text output is additionally limited by `textValueUnits`. Charge nested row work to one total transaction counter; do not reset the budget per chart/view. Exhaustion is `E_LIMIT` with `limitName`, `observed` and `maximum` details. A worker timeout is an additional host safeguard, not a substitute for operation budgets or a deterministic semantic error.

Source/ZIP/JSON parsing must enforce depth and byte limits incrementally. Do not decompress an untrusted archive in full before checking declared/uncompressed limits. Actual expanded bytes, not just ZIP headers, determine acceptance. The maximum literal number token length is 128 UTF-16 units; more is `E_LIMIT`. Layout may not allocate arrays proportional to an unvalidated numeric value.

## Errors

| Code | Meaning |
|---|---|
| `E_ENCODING` | Invalid UTF-8 source or import encoding. |
| `E_LIMIT` | A named resource limit was exceeded. |
| `E_DIRECTIVE_UNKNOWN` | Unregistered column-1 directive. |
| `E_DIRECTIVE_SYNTAX` | Malformed directive operands/options. |
| `E_BLOCK_END` | Unexpected closing @end. |
| `E_BLOCK_UNCLOSED` | Tinta block has no closing @end. |
| `E_BLOCK_EMPTY` | Conditional/detail block contains no renderable content. |
| `E_DECLARATION_SCOPE` | Root-only declaration used in a nested block. |
| `E_PROPERTY_UNKNOWN` | Unsupported option key. |
| `E_PROPERTY_DUPLICATE` | Option key repeated. |
| `E_PROPERTY_REQUIRED` | Required option missing. |
| `E_PROPERTY_DEPENDENCY` | Option depends on another missing option. |
| `E_PROPERTY_VALUE` | Option has an invalid literal value. |
| `E_VERSION` | Unsupported source format version. |
| `E_META_POSITION` | Repeated or misplaced metadata. |
| `E_META_VALUE` | Unsupported metadata setting. |
| `E_EXPRESSION_SYNTAX` | Invalid/unfinished expression token sequence. |
| `E_NAME_RESERVED` | Reserved or invalid identifier. |
| `E_NAME_DUPLICATE` | Document name declared more than once. |
| `E_NAME_UNKNOWN` | Unresolved global name. |
| `E_ROW_SCOPE` | row.field used outside a supported row context. |
| `E_COLUMN_UNKNOWN` | Referenced table column does not exist. |
| `E_TYPE` | Types do not satisfy an operator/directive/function contract. |
| `E_FUNCTION_ARITY` | Incorrect number of function arguments. |
| `E_CONST_DEPENDENCY` | Constant depends on nonconstant state/data. |
| `E_CYCLE` | Dependency cycle detected. |
| `E_NUMBER_RANGE` | Numeric operation produced a non-finite/non-real result. |
| `E_DIV_ZERO` | Division or remainder by zero. |
| `E_DIGITS_RANGE` | Formatting/rounding digits are outside integer 0–10. |
| `E_EMPTY_MEAN` | Mean requested for an empty table/view. |
| `E_STATE_NAME` | Update names an unknown/non-control symbol. |
| `E_STATE_DOMAIN` | Control update/default violates its allowed domain. |
| `E_DATA_HEADER` | Invalid or duplicate typed table header. |
| `E_DATA_ARITY` | Row cell count differs from the schema. |
| `E_DATA_VALUE` | Cell is not a valid scalar for its declared type. |
| `E_CHART_TYPE` | Unknown chart type. |
| `E_CHART_SERIES` | Invalid series count/form for chart type. |
| `E_CHART_DUPLICATE_X` | Chart requires unique x values. |
| `E_CHART_VALUE` | Invalid chart datum, e.g. negative sector value. |
| `E_CHART_DOMAIN` | Finite chart geometry cannot be constructed. |
| `E_SELECTION_TARGET` | Invalid linked-control type/name. |
| `E_SELECTION_DOMAIN` | Chart x cannot be represented by the linked control. |
| `E_IMPORT_SCHEMA` | Unsupported import structure or conversion. |
| `E_IMPORT_PRESERVATION` | Markdown enrichment changed unintended semantics. |
| `E_ASSET_MISSING` | Referenced local image was not supplied. |
| `E_ASSET_EXTERNAL` | Remote/nonlocal image is not permitted. |
| `E_ASSET_TYPE` | Unsupported/mismatched raster image format. |
| `E_ASSET_PATH` | Unsafe resource or ZIP entry path. |
| `E_BUNDLE` | Malformed bundle, duplicate keys/entries, CRC or manifest mismatch. |
| `E_HASH_MISMATCH` | Source/resource hash does not match its envelope. |
| `E_SNAPSHOT` | State envelope does not match source/schema/controls. |
| `E_EXPORT_INVALID` | Export requested for invalid/stale source or an invalid state. |
| `E_OUTPUT_EXISTS` | Output already exists and replacement is not authorized. |
| `E_IO` | Authorized filesystem operation failed. |
| `E_WORKER_TIMEOUT` | Worker did not complete before the watchdog. |
| `E_PROTOCOL` | Malformed or unauthorized host protocol message; stale valid results are ignored. |
| `E_INTERNAL` | Unexpected engine fault; not a document syntax diagnosis. |

## Warnings

| Code | Meaning |
|---|---|
| `W_NUL_REPLACED` | NUL displayed as the replacement character. |
| `W_HTML_INERT` | Raw author HTML displayed as text. |
| `W_LINK_LOCAL_UNSUPPORTED` | Local document navigation is not implemented. |
| `W_LINK_UNSAFE` | Unsafe/unsupported link disabled. |
| `W_ASSET_UNAVAILABLE` | Preview image unavailable; export remains blocked. |
| `W_RECOVERY_UNAVAILABLE` | Local browser recovery is unavailable. |
| `W_MARKDOWN_COLLISION` | Enrichment proposes escapes for Tinta-looking literal text. |

## Diagnostic object and location rules

Every diagnostic contains code, severity (`error`/`warning`), phase (`decode`, `parse`, `bind`, `type`, `evaluate`, `assets`, `export`, `host`), an English sentence, a primary span, optional related spans and a JSON-safe details object. No HTML in messages. Messages may include a short identifier or escaped bounded token; never include entire imported/private files or image bytes. Truncate embedded offending text to 80 code points.

A source diagnostic points to the smallest token causing the issue; a missing token uses a zero-length position. Duplicate declarations/options point at the second declaration and relate the first. Cycle diagnostics point at the earliest declaration in the cycle and relate participating declarations in stable source order. Unknown names point at that occurrence. Row-value errors point at the cell. Runtime errors preserve the expression's source span and include an optional row ID/control name, not a copied row payload. Host IO errors without a source token use a zero-length span at the supplied source URI's start, plus an operation field.

Sort errors by phase order above, then start offset, then code lexicographically. Return at most 100 diagnostics total. If more would be emitted, return the first 99 in the defined order and one final `E_LIMIT` naming `diagnostics`; do not return a 101st entry. Downstream diagnostics from an unparsable node are suppressed. A warning does not permit a forbidden export: unavailable image warnings in preview correspond to hard asset errors at export.

## State-transition errors

A rejected control event returns diagnostics to that event and retains the previous successful revision. It does not transform an error into null, zero or stale values. Reader output describes the failed action near the affected control and in one polite status region. The source is still valid if only a particular candidate state failed; this is distinguished from an invalid source edit. Clearing a displayed interaction error requires a successful subsequent action or explicit dismissal; it does not mutate source.

`E_INTERNAL` is never used for an ordinary syntax/type/domain mistake. Catch the internal exception at the host boundary, report an opaque incident ID generated by the host, preserve local content, and keep any stack trace local to developer tooling. No automatic telemetry or remote crash report.
