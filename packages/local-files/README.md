# @tinta-lang/local-files

Read selected local tinta files and images, and write exports from Node applications. Its file operations use explicit input paths, asset roots and output targets.

```ts
import { readOpenedSource } from "@tinta-lang/local-files";

const bytes = await readOpenedSource(pathToOpenedDocument);
```

`readOpenedSource` reads the selected file; it does not grant access to nearby images or directories. Use the separate asset and output operations when your application has those permissions. This package is for Node, not browser code.

See the [local file behavior](https://github.com/planta7/tinta/blob/main/docs/13_VSCODE.md#files-and-workspace-trust) and [file formats](https://github.com/planta7/tinta/blob/main/docs/02_FILES_AND_EXPORTS.md).
