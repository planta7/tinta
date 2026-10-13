# @tinta-lang/reader

Display an interactive tinta document in a browser. The reader mounts accessible controls, text and charts from a validated engine session.

```ts
import { mountReader } from "@tinta-lang/reader";

const mounted = mountReader(session, { nativeElement: container }, {
  assets: new Map(),
});

if (mounted.ok) mounted.value.destroy();
```

Create the session with `@tinta-lang/engine` first, and keep ownership of it after unmounting the reader. Include `@tinta-lang/reader/reader.css` for the reader styles. This package does not compile source or save answers.

See the [reader API](https://github.com/planta7/tinta/blob/main/docs/12_READER_API.md).
