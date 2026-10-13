# @tinta-lang/language-service

Add tinta source analysis to an editor. The service provides diagnostics, completion context, hover information and document navigation from supplied source text.

```ts
import { analyze, catalog } from "@tinta-lang/language-service";
```

Your editor supplies the document and its version. This package does not read files, connect to an editor host or display a preview.

See the [editor analysis API](https://github.com/planta7/tinta/blob/main/docs/13_VSCODE.md#portable-language-analysis-api).
