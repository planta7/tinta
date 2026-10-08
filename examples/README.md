# Reference inputs

These examples specify expected behaviour for contract revision 1.0-draft.2. Runtime conformance is not yet implemented.

| File | Intended check | Initial outcome |
|---|---|---|
| minimal.tinta | Control, calculation and guarded prose | people=5; total=95; large-team paragraph absent. |
| article.tinta | Computed curve and bidirectional numeric selection | growth=5; period=2; selected_readers=110. |
| report.tinta | Shared view, aggregate, bar and donut | Two weekdays; total=280; average=140; selected Mon=120. |
| guide.tinta | Existing Markdown inside explicit conditional blocks | macOS paragraph visible; Windows/Linux absent; extra details absent. |
| chart-atlas.tinta | All seven types | 7 figures; all series visible; period=1, format=Text. |
| all-functions.tinta | Eleven built-ins | n=3; sum=60; mean=20; count=3. |
| import-before.md / import-after.tinta | Safe literal-preserving enrichment | Same safe Markdown presentation, with two inserted escapes only. |
| local-image.tinta / local-image.tinta.zip | Source/asset portability | One hashed raster asset, exact byte preservation. |
| article.tinta.state.json | Explicit answer snapshot | growth=10 and period=2 produce selected_readers=121 when applied. |

The one-pixel image is only a binary asset test fixture. The example bundle has been structurally constructed according to the manifest contract; this does not prove that the not-yet-implemented Tinta packer produced it. All example data is fictional.
