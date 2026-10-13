# @tinta-lang/syntax

Parse ordinary Markdown or tinta source while preserving original text positions. You can also create a separate tinta version of an existing Markdown document with `enrichMarkdown`.

```ts
import { parse } from "@tinta-lang/syntax";

const result = parse({
  uri: "tinta:example",
  profile: "tinta",
  text: "# Hello\n",
});
```

A successful parse confirms syntax only. To check names, types and calculations, use `@tinta-lang/engine`. The parser does not render HTML or read files.

See the [syntax API](https://github.com/planta7/tinta/blob/main/docs/10_SYNTAX_API.md) and [language guide](https://github.com/planta7/tinta/blob/main/docs/CHEATSHEET.md).
