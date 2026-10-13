# @tinta-lang/types

Shared TypeScript types for tinta documents and the tools that read them. Use this package when building on the parser, engine or reader APIs and you need their source, diagnostic, document or session types.

```ts
import type { SourceInput, Result, Diagnostic } from "@tinta-lang/types";
```

It also provides explicit subpaths for UTF-8, assets, editor messages and version identifiers. This package does not parse or render documents.

See the [API contracts](https://github.com/planta7/tinta/blob/main/contracts/public-api.d.ts) and [project overview](https://github.com/planta7/tinta#readme).
