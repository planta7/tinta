# Expressions, types, binding and reactive state

## Tokens and values

Identifiers match `[A-Za-z_][A-Za-z0-9_]*`, are case-sensitive and at most 64 characters. Reserved identifiers are `true`, `false`, `and`, `or`, `not`, `row`, the eleven function names, `__proto__`, `prototype`, and `constructor`. Table column names use the same rule and exclusions. Directive and property names are syntactic tokens, not ordinary names. No namespace qualification except the special `row.field` is allowed.

Numbers have this unsigned token form: `(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`. A leading minus/plus is a unary operator. `.5`, `5.`, leading-zero `01`, hexadecimal, infinities and NaN are invalid tokens. Literals and all computed results must be finite binary64. Normalize negative zero to positive zero at every value boundary. Extremely large finite values are legal general numbers, subject to output/resource limits; slider limits are narrower.

Strings are JSON-style double-quoted literals. Escape syntax is exactly JSON strings, including Unicode escapes and paired surrogate escapes; reject invalid/unpaired surrogate escapes. Literal newlines/control characters in strings are invalid. Unicode prose outside literals is unrestricted by ASCII identifier rules. Booleans are `true` and `false`.

Types are `number`, `text`, `boolean`, homogeneous `list<T>` of scalars, and `table<schema>`. Empty lists have `list<never>` and may be counted or unified with a scalar list branch; they cannot determine a typed table or option type on their own. Nested lists and heterogeneous lists are `E_TYPE`. No `null`, objects, dates, function values, property lookup, indexing or implicit casts. Tables are declaration/view values, never literal objects or `@calc` results.

## Expression grammar and precedence

From highest to lowest: primary values/calls/grouping/`row.field`; unary `+ - not`; `* / %`; `+ -`; `< <= > >=`; `== !=`; `and`; `or`. Binary operators at one level associate left-to-right. Comparison chaining is not a special feature: `a < b < c` attempts to compare a boolean with `c` and fails. Parentheses explicitly group.

Arithmetic and ordering `< <= > >=` accept numbers only. For V1, text order is available for view sorting but not expression comparison. Equality accepts two same-type scalars, not arrays/tables; a mixed-type comparison is `E_TYPE`, not `false`. Logical operators require booleans. `+` never concatenates strings. Division/modulo by zero is `E_DIV_ZERO`; remainder follows the sign of the dividend (JavaScript numeric remainder, not mathematical modulo). A non-finite result is `E_NUMBER_RANGE`.

`and` and `or` short-circuit at evaluation. `if` evaluates only the chosen branch. Both branches still participate in name resolution, type checking and cycle detection. All function names are fixed symbols, not replaceable values. There is no assignment expression or general call expression.

`row.field` is permitted only inside a view `where` expression or a chart's computed `y`. Its type is resolved from that expression's input table schema. Bare `field` always means a global document name, even if a column has that name. Unknown row fields are `E_COLUMN_UNKNOWN`. Access such as `row["field"]`, `row.field.x`, `global.name`, methods and prototype access is invalid syntax.

## Function signatures — exactly eleven

| Function  | Accepted signature                     | Exact behaviour                                                                                                                                        |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `if`      | `if(boolean, T, T) -> T`               | Scalar or scalar-list branches of compatible type; evaluate one branch only. No table branches.                                                        |
| `min`     | `min(number, number) -> number`        | Smaller operand; exactly two arguments.                                                                                                                |
| `max`     | `max(number, number) -> number`        | Larger operand; exactly two arguments.                                                                                                                 |
| `round`   | `round(number, number=0) -> number`    | Digits must be integer 0–10. Compute `Math.round(n * 10^d) / 10^d`; reject non-finite intermediate. Ties round toward positive infinity, normalize -0. |
| `pow`     | `pow(number, number) -> number`        | Binary64 real power; 0^0 is 1; reject non-real/non-finite results.                                                                                     |
| `count`   | `count(list<T> or table<S>) -> number` | Number of elements/rows; empty is 0.                                                                                                                   |
| `sum`     | `sum(table<S>, "column") -> number`    | Literal numeric-column name required; sum in current view row order, starting at 0. Empty is 0. Reject overflow.                                       |
| `mean`    | `mean(table<S>, "column") -> number`   | Same literal-column constraints; `sum / count`; empty is `E_EMPTY_MEAN`.                                                                               |
| `fixed`   | `fixed(number, number) -> text`        | Digits integer 0–10; localized fixed decimal places, grouping disabled.                                                                                |
| `percent` | `percent(number) -> text`              | Ratio formatting (0.125 -> 12.5% in en-US); grouping disabled, minimum 0/maximum 1 fractional digits.                                                  |
| `money`   | `money(number) -> text`                | Metadata locale/currency; grouping enabled; currency symbol; standard 0 digits for JPY, 2 for all other supported currencies.                          |

For `sum`/`mean`, even empty tables and unexecuted branches require an existing numeric column. The second operand must be a string literal, not a computed text value. For `round` and `fixed`, a dynamic digit value is legal but checked each evaluation. Do not accept extra arguments. Formatting uses `Intl.NumberFormat` with the exact options above and the supported locale set in metadata. It is not based on the browser's ambient language. Currency defaults are in the registry.

Ordinary numeric interpolation uses grouping disabled and maximum 10 fractional digits, minimum 0. It is display formatting, not value rounding. Values with absolute magnitude at least 1e21 or nonzero magnitude below 1e-10 use the ECMAScript canonical finite number string to avoid displaying a nonzero as zero. Charts use at most two fractional display digits for axes; inspection/data tables use ordinary scalar formatting and expose the canonical numeric value in copyable text. No formatted value is fed back into evaluation.

ECMAScript binary64 arithmetic and the selected rounding procedure are normative. For power operations, test comparisons allow the numeric tolerance in the verification contract across engines; exact formatting whitespace may differ with ICU versions. Artifact byte reproducibility is required within one locked build/runtime, not across all locales and browser engines. Financial precision is not promised.

## Declarations and dependency graph

`@let` binds immutable scalar/list values. It may reference other `@let` declarations, including forward references, but must not depend on a control, a `@calc` or a table/view. Built-ins other than table aggregates may be used if all arguments are constant and correctly typed.

`@calc` binds a derived scalar/list expression and may reference constants, controls, other calculations, and tables/views through the defined aggregate functions. It cannot be a table alias. `@view` binds a table with the same schema as its input. Source tables are immutable. Control initial values and static directive properties are literals, not name references.

Collect all declarations, including controls inside conditions/details, before binding. Duplicate names anywhere are `E_NAME_DUPLICATE`. `@let`, `@calc`, `@data` and `@view` are allowed only at document root. `@meta` has additional first-position rules. A control nested in a false condition exists globally and has a validated initial value. No shadowing and no block-local scope.

Build dependency edges from every bound global reference, including inactive function branches and view filters. Row fields are not global edges. Report a cycle for every strongly connected component with size >1 or a self edge, including a related span path. Do not evaluate a cyclic program. Chart selection is an external state event, not a derived dependency edge; a chart reading a control it can select is permitted.

## Evaluation and visibility

Evaluate constants once per compiled program. On initial evaluation and each candidate control update, evaluate all calculations and views in topological order. All names/types in every document branch are compiled, but inline outputs and chart rendering under false `@when` ancestors are **not evaluated**. A collapsed `@details` is not a false condition: its body is evaluated and validated even when closed. This lets `@when denominator != 0` guard an inline division, but does not guard an unconditional `@calc value = 1 / denominator` elsewhere.

All controls exist independent of visibility. Hiding a control does not reset or erase it. A false condition removes its rendered body from accessibility and tab order. Hidden source/data remains in the file. Opening details changes only presentation, not the evaluation graph.

## Atomic state transitions

State is a map containing exactly one value for every declared control. `setControls` accepts a partial update; missing controls retain their current value. Validate every updated name/type/domain before evaluating. No auto-conversion, clamping or option substitution. A rejected transition returns diagnostics and preserves the prior revision, state, derived values, selected highlights, legend state and focus. On success, emit one revision containing all computed content. Duplicate writes in one API update cannot exist because the host DTO rejects duplicate JSON keys before interpretation.

Interactive source export chooses `initial` or `current` explicitly. A standalone artifact's **Reset reading** returns to that artifact's chosen initial snapshot, which may differ from the source defaults when exported with `current`. Resetting an editor preview returns to source defaults. Reader activity never edits source text. Snapshot persistence is opt-in through explicit export only.

## Slider domain

Slider initial, min, max and step are numeric literals representable with at most six decimal places, absolute min/max <= 1e9 and step >= 1e-6. `min < max`; `(max-min)/step` must be an exact integer between 1 and 100000 in base-10 arithmetic. Initial must be exactly on that grid and in range. Convert these literals to scaled integers using their decimal token text, not floating-point division. Ensure distinct ticks convert to distinct finite binary64 values. Defaults are min 0, max 100, step 1.

The native range element uses integer tick indices from 0 through tickCount. Its displayed/global value is derived from the exact decimal grid. API and chart-selection numbers must map to an exact authored decimal grid value when represented by their canonical number string; no epsilon-based accepting or silent snapping. Thus 0.3 can match a 0.1 grid, but 0.30000000000000004 is rejected. This limitation is explicit and tested.
