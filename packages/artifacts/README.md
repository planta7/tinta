# @tinta-lang/artifacts

Create and open portable tinta files: source bundles with local images, answer snapshots, and standalone interactive or static HTML.

```ts
import { packSource, openBundle, exportHtml } from "@tinta-lang/artifacts";
```

Supply document source and permitted assets explicitly. Interactive HTML retains the document and its data so readers can change answers; static HTML contains the selected visible result. This package does not read or write filesystem paths.

See [files and exports](https://github.com/planta7/tinta/blob/main/docs/02_FILES_AND_EXPORTS.md) and the [public API](https://github.com/planta7/tinta/blob/main/contracts/public-api.d.ts).
