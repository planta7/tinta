# Safe document reader API

`@tinta-lang/reader` exports the browser-only `mountReader(session, host, options)` function from the public contract. Create a session through the engine's validated compile/decode and session APIs before mounting. The reader does not compile source or accept serialized IR in place of a session.

```ts
import { mountReader } from "@tinta-lang/reader";

const mounted = mountReader(session, { nativeElement: container }, {
  assets: new Map(),
  onDiagnostic(diagnostic) {
    displayDiagnostic(diagnostic);
  },
});

if (mounted.ok) {
  // Close details without changing answers.
  mounted.value.resetPresentation();
  // Unsubscribe and remove only this reader's owned article.
  mounted.value.destroy();
}
```

The host must be a real HTMLElement in the caller's document. Existing host children are preserved; a second mount on the same host requires explicit destruction. Different hosts can display independent sessions or subscribe to the same session. Host code retains session ownership: destroying a reader does not destroy its session. For new compiled source, destroy and remount; source reconciliation belongs to the editor host.

The reader constructs safe typed DOM nodes, validates its element/attribute vocabulary, and projects only committed revisions. Raw HTML is literal text and comments remain hidden. Links use the language's destination policy and external activation protections. Same-document links resolve against the complete heading map, including hidden branches, without revealing them. Simultaneous readers reserve distinct heading IDs; fragment navigation remains within its reader.

Controls retain native keyboard and pointer behavior. Persistent fields preserve focus across updates; hidden focused fields fall back to a preceding visible control or heading. Native details preserve their open state on answer updates, including temporary conditional hiding. The **Reset reading** button restores the session baseline and closes details. Rejected changes restore field values, show a diagnostic beside the field and announce the rejection in the reader's single polite status region. Successful updates are announced after 150 ms idle. Reader actions do not modify source or persist answers.

Compile warnings remain available from the compiler result and should also be displayed by the host. The reader's diagnostics callback reports its own warnings and host errors. An image placeholder produces `W_ASSET_UNAVAILABLE` with the source span. Supplied raster capabilities are validated and copied before mounting, then rendered as embedded data images. Invalid capabilities fail before changing the host. Unresolved or forbidden destinations remain inert placeholders. Figures render all seven chart types through the safe SVG geometry adapter and provide complete HTML inspection and data alternatives. Standalone exports use the artifact API to enforce their complete resource requirements.

`pnpm build` produces a classic `build/reader.js` with `TintaReaderRuntime.TintaReader.mountReader`, plus `build/reader.css`. A trusted host supplies a validated session. There is no embedded compiler, React, CodeMirror, network loader or document payload decoder in this entry. Standalone document export is a separate capability.

## Verification

Use the pinned toolchain from [foundation tooling](09_FOUNDATION_TOOLCHAIN.md), then:

```sh
pnpm build
pnpm test:browser charting
node scripts/reader-coverage.mjs
node scripts/reader-size.mjs
pnpm verify --suite charting
```

The aggregate includes affected semantic/parser checks, real Chromium/Firefox/WebKit assertions, axe accessibility automation, source-mapped Chromium coverage (85% statements/functions/lines, 80% branches), bundle composition and size checks. Coverage conversion uses the exact transitive tools already locked with the Vitest coverage provider; no floating dependency is resolved.

Synthetic screenshots at 1440, 1024, 768, 390 and 320 CSS px, forced colors and doubled text size are written under the ignored test output directory. They capture rendering at those settings; keyboard, screen-reader and physical-device behavior require direct interaction with the corresponding environment.

## Figures

Each figure has a decorative SVG, description, native integer range explorer, action button and permanent **Show data** disclosure. Arrow/Home/End keys use native range behavior; PageUp/PageDown moves ten entries. The explorer walks visible data in prepared row-major/series order. A one-point figure disables navigation while retaining its action; empty figures disable both. Inspection announcements are debounced by 150 ms. Hover never writes answers or streams live announcements.

Clicking or using an inspected linked value writes its x scalar through the normal session transaction. Rejection leaves the previous document revision intact. Shared figures highlight the committed x, including overlapping scatter observations. A filtered-out selection remains an answer and has an explicit explanation. Without a linked control, the action pins only local inspection. Escape clears the pin without clearing the answer.

Legend buttons change only local series/category visibility. Hidden preferences survive filtering within the mounted program; tables continue to show hidden data. Pie/donut descriptions identify the visible total. Reset reading and `resetPresentation()` restore legend visibility, clear pins and close figure data disclosures. Chart controls are retained across answer updates; ResizeObserver changes only geometry. Destruction disconnects observers and removes listeners and pending announcements.

`@tinta-lang/charts` exports the portable `chartScene(preparedChart, width, hiddenKeys?, selectedX?)` adapter. It consumes validated prepared data and returns a closed primitive scene, with no DOM or filesystem operations. Use width 720 for the nominal static geometry; this does not itself provide an HTML exporter. The engine's pure `chartPresentation`, `legendKey` and `numericDomain` helpers derive viewport-independent visibility, domains and totals. Scene coordinates use at most three fractional digits. The locked D3 array/scale/shape modules provide ticks and geometry, without author-controlled chart grammar.

The charts TypeScript project includes DOM declarations because the locked D3 declarations reference `ImageData` in an unused image-blur API. This is a declaration dependency only: charts source has no DOM access; syntax and engine retain their ES-only compiler libraries. The standalone reader includes only the engine's pure chart-presentation helper, never compilation, evaluation, program decoding or a framework.

Chart unit coverage requires 90% statements/lines and 85% branches. Chart tests include finite geometry, ordering, exact numeric boundaries, histogram conservation with 1,000 seeded inputs, keyboard/pointer selection, rollback, hidden preferences, native-browser resize and 100-cycle observer cleanup. Reader-effect results for the seed corpus are written separately from pure semantic results, with file/import behavior checked by the artifact and editor suites.
