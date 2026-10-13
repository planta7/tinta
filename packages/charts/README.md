# @tinta-lang/charts

Turn prepared tinta chart data into SVG-ready geometry. The engine prepares values; `chartScene` places the visible marks, axes and labels for a requested width.

```ts
import { chartScene } from "@tinta-lang/charts";

const scene = chartScene(preparedChart, 720);
```

The input must be a prepared chart from `@tinta-lang/engine`. This package does not create DOM elements or accept an arbitrary chart configuration language.

See the [reader and figures API](https://github.com/planta7/tinta/blob/main/docs/12_READER_API.md).
