import { editorNames } from "@tinta/syntax";

export const catalog = Object.freeze({
  ...editorNames,
  signatures: Object.freeze({
    if: "if(boolean, T, T) -> T",
    min: "min(number, number) -> number",
    max: "max(number, number) -> number",
    round: "round(number, number=0) -> number",
    pow: "pow(number, number) -> number",
    count: "count(list<T> or table<S>) -> number",
    sum: 'sum(table<S>, "column") -> number',
    mean: 'mean(table<S>, "column") -> number',
    fixed: "fixed(number, number) -> text",
    percent: "percent(number) -> text",
    money: "money(number) -> text",
  }),
  descriptions: Object.freeze({
    meta: "Document version, title, locale and currency. Must precede content.",
    let: "Root constant; may depend only on other constants.",
    calc: "Root derived scalar or scalar list, evaluated on every update.",
    slider:
      "Numeric control with a literal initial value and exact decimal grid.",
    toggle: "Boolean control with a literal initial value.",
    choice:
      "Text control with a literal initial value and distinct text options.",
    when: "Conditionally visible Markdown; ends with @end.",
    details:
      "Collapsible Markdown with a nonblank literal summary; ends with @end.",
    data: "Embedded typed table with a header and literal rows; ends with @end.",
    view: "Filtered, stably sorted table retaining its source schema.",
    table: "Display all columns of a table or view.",
    chart: "Display a supported chart from a table or view.",
    end: "Close the innermost Tinta block.",
  }),
});
