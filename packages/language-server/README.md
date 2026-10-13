# @tinta-lang/language-server

Run tinta language features in a local editor through the Language Server Protocol. The package offers a Node IPC entry point for diagnostics, completion and navigation.

```js
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const server = fork(
  fileURLToPath(import.meta.resolve("@tinta-lang/language-server/ipc")),
  [],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
```

The server uses UTF-16 positions and full document synchronization. Keep its sibling worker file beside the entry point. It has no stdio executable or root import.

See the [language server behavior](https://github.com/planta7/tinta/blob/main/docs/13_VSCODE.md#native-editing-and-source-diagnostics).
