# Safe document reader API

`@tinta/reader` exports the browser-only `mountReader(session, host, options)` function from the public contract. Create a session through the engine's validated compile/decode and session APIs before mounting. The reader does not compile source or accept serialized IR in place of a session.

```ts
import { mountReader } from "@tinta/reader";

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

Compile warnings remain available from the compiler result and should also be displayed by the host. The reader's diagnostics callback reports its own warnings and host errors. An image placeholder produces `W_ASSET_UNAVAILABLE` with the source span. Image decoding is not implemented here yet: even supplied asset bytes remain unconsumed and never cause a resource request. Figures carry a visible chart-rendering-not-implemented notice. These development placeholders do not constitute complete document export support.

`pnpm build` produces a classic `build/reader.js` with `TintaReaderRuntime.TintaReader.mountReader`, plus `build/reader.css`. A trusted host supplies a validated session. There is no embedded compiler, React, CodeMirror, network loader or document payload decoder in this entry. Standalone document export is a separate capability.

## Verification

Use the pinned toolchain from [foundation tooling](09_FOUNDATION_TOOLCHAIN.md), then:

```sh
pnpm build
pnpm test:browser reading
node scripts/reader-coverage.mjs
node scripts/reader-size.mjs
pnpm verify --suite reading
```

The aggregate includes affected semantic/parser checks, real Chromium/Firefox/WebKit assertions, axe accessibility automation, source-mapped Chromium coverage (85% statements/functions/lines, 80% branches), bundle composition and size checks. Coverage conversion uses the exact transitive tools already locked with the Vitest coverage provider; no floating dependency is resolved.

Synthetic screenshot baselines at 1440, 1024, 768, 390 and 320 CSS px, forced colors and doubled text size are written under the ignored verification output directory. They are evidence for visual review, not approved golden snapshots or proof of manual assistive-technology acceptance. Full Safari/VoiceOver, Firefox/NVDA and real iOS acceptance remains part of release qualification.
