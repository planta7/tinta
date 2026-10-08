# Files, local resources, state and export

## Source files

`.tinta` is always human-readable UTF-8 source, never a renamed ZIP or opaque database. `.md` is safe Markdown-profile source. A source with no images is a complete single file because all runtime tables are embedded. Local image links may reference sidecar files within an explicitly selected document root. Source save does not rewrite reader answers into control defaults.

An unmodified existing source saves byte-for-byte, including BOM and line endings. New/modified regions use the buffer's original dominant line ending (first encountered style breaks a tie); no whole-file normalization. A generated source from a template/import uses LF and no BOM. HTML/source-bundle serializers use their canonical output encodings independently of the source buffer.

Do not overwrite the originating `.md` during enrichment or overwrite an input with an output artifact, even with force. A browser download is not proof that a file reached disk; UI states must distinguish an acknowledged filesystem-handle save from an initiated download.

## Permitted images and local resolution

Images are only static PNG, JPEG and WebP. Sniff bytes and decode dimensions; extension or a declared MIME type is not sufficient. Reject SVG, GIF, APNG and animated WebP; reject malformed formats and any image over asset byte/pixel limits. Do not execute or inject image metadata. Imported bytes and metadata are preserved exactly, not automatically sanitized or stripped; export privacy text must mention that images may retain metadata.

Paths are relative to the selected document root; decode URL escapes once, require valid UTF-8, reject NUL/ASCII controls, absolute paths, drive prefixes, UNC paths, scheme-relative paths, backslashes, empty components, `.` and `..` components. A single optional leading `./` is removed before component validation. Query strings/fragments in image paths are not supported. A final normalized path must stay inside the granted root. Runtime document code cannot expand the grant.

Browser mode resolves only explicitly selected File objects/directory handles. Opening one `.tinta` file does not grant access to its neighbouring files automatically; unresolved sidecars prompt **Add local images** or **Open source bundle**. CLI can resolve inside the input directory or an explicit `--asset-root`; reject symlinks/reparse points and directory traversal. Check identity/root membership around opening, and never fall back to an HTTP fetch. No remote image or author data/blob URL is loaded. Preview displays a labelled placeholder and a warning; portable export fails if any image required by that export is unresolved or forbidden.

Imported images receive `assets/<lowercase-sha256>.<ext>`, with canonical extensions png/jpg/webp and MIME image/png, image/jpeg, image/webp. Deduplicate identical bytes by hash. Alt text is plain static source text; default insertion requires the author to enter meaningful alt text or explicitly mark decorative with an empty alt. The original filename is shown in the import dialog but is not retained in the exported bundle manifest.

## `.tinta.zip` source bundle

An ordinary ZIP containing exactly these non-directory entries:

```text
manifest.json
 document.tinta                 (no leading space in the actual name)
assets/<sha256>.png|jpg|webp  (zero to 100 images)
```

The first two required entries are exactly `manifest.json` and `document.tinta`. `schemas/bundle.schema.json` defines the manifest. Source bytes/hash must match; asset path hash, manifest hash and actual byte hash must all agree. Reject unknown entries, missing entries, extra manifest assets, duplicate paths (including case-fold collisions), duplicate JSON keys, nonmatching byte lengths, invalid UTF-8 metadata and excessive sizes.

ZIP methods: stored (0) or deflate (8), no encryption, no ZIP64, no symlinks/device entries, no multi-disk archives, no trailing embedded archive, no absolute/relative-escape paths. CRC must be checked after inflation. Enforce actual compressed/uncompressed totals while streaming; do not trust size headers. Directory entries are not accepted. Stop on an exceeded limit, discard partially decoded buffers, and do not write anything to disk.

Canonical writer: entries in manifest/source/lexically sorted assets order; JSON UTF-8, two-space indentation, LF and final LF; sorted object keys; ZIP timestamp 1980-01-01 00:00:00, file mode regular 0644, no extra fields/comments; compression method stored. Canonical output is deterministic for identical inputs. Readers still accept permitted deflate input.

Packing first resolves images and generates a **copy** of source whose image destinations use canonical hashed paths. This transformation changes only resolved image destination source spans, not prose or formatting. Recompile that copy and validate its authored-initial state; a source bundle never includes current reader answers. Hash the actual packed source, not the original buffer. The original buffer is not silently rewritten by packing. Raw `.tinta` download with sidecars warns that it is not a portable asset bundle and offers `.tinta.zip` as the default portable choice.

## State snapshot

A `tinta-state` JSON envelope contains source SHA-256, format version, sorted control name/value pairs and no computed values or figure-local presentation. Its exact schema is `schemas/state.schema.json`. All current controls must occur exactly once; unknown, missing, wrong-type or out-of-domain values fail. Duplicate JSON keys fail before schema validation. It contains no browser file paths, user identifier, timestamp or host locale. Validate against the actual source fingerprint and compiled control schema, not just the JSON shape.

Only explicit **Answers snapshot** creates a `.tinta.state.json` file; normal reading stores no answers. CLI build accepts such a file to reproduce a selected answer state. Source files/bundles do not contain reader-state snapshots. They retain authored defaults. This is a serialization utility, not multi-user persistence.

## Interactive standalone HTML

Inputs: valid compiled source, permitted resolved images, and `initial` or `current answers`. The UI exposes those choices explicitly, default `initial`; CLI uses `initial` or a supplied snapshot. Export validates the selected answers and every required visible figure, then separately confirms all source resources are resolved because interactive readers may reveal any branch later.

Output: UTF-8 `.html`, one file with embedded trusted CSS, classic reader IIFE, typed compiled-program payload, inert source string, source/asset metadata and base64 raster resources. No external scripts, style/font URLs, workers, editor, React, CodeMirror, source maps, import maps, dependencies on a local server or runtime fetches. It must open through actual `file://` in the tested browsers. The script validates its envelope before reading the embedded program.

Use a JSON payload in `<script type="application/json" id="tinta-payload">`; JSON-escape `<` as `\u003c`, `>` as `\u003e`, `&` as `\u0026`, and U+2028/U+2029. Never interpolate raw source inside a script or HTML attribute. Do not use base64 as a substitute for schema/resource validation. Payload/program version must exactly match its embedded reader ABI.

The chosen answer state becomes the artifact reset baseline. Reset returns there, not necessarily to source defaults. Figure legends, local pins and details-open states are **not** exported: all series/categories start visible and details start closed. The export chooser says **Current answers**, not “exact screen snapshot”. No source mutation occurs.

The no-script presentation contains an export-time static rendering of the selected answers and the sentence `Interactivity requires JavaScript; the values below are the exported answers.` This is a fallback, not another runtime. When JavaScript initializes successfully it replaces the fallback with the reader; do not show two copies. An initialization error leaves the fallback and a clear local error. Screen-reader labels are not dependent on generated SVG text.

Privacy notice, shown before first export per editor session and printed in About/details of the artifact: **This interactive file contains the complete source, all embedded data, hidden explanations and image metadata. Hidden content is not private. It does not send data anywhere.** That last statement refers to automatic product behaviour; external links may open a destination only when activated by the reader.

## Static standalone HTML

Inputs are the same `initial` or `current answers` choice. Produce resolved Markdown content for true conditions only. Replace controls with labelled static answer text. Expand every visible details body. Include complete tables from visible table/figure nodes and SVG figures with all series visible. No JS, event handlers, embedded source, program AST, hidden conditions, answer state envelope or unreferenced data/resources. Visible figure tables necessarily disclose their included data; static export is not an automatic anonymizer.

Only images referenced by the visible result need be bundled. Source must still compile globally, but unresolved images exclusively inside false conditions do not block static export; interactive export requires them. Metadata may include a generated-by string with format/engine version but no timestamps, paths, usernames or host identifiers. Includes print CSS; browser printing is not a promised programmatic PDF exporter.

Static geometry uses the nominal dimensions in the chart contract. Set the HTML `lang` from metadata. Link/HTML safety is identical to the reader. `script-src 'none'` is mandatory in static export.

## CSP and network behaviour

Interactive artifact policy: `default-src 'none'; script-src 'sha256-<exact-reader-hash>'; style-src 'sha256-<exact-style-hash>'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'`. Include the exact hash of the inert JSON payload script in script-src as well; its type remains application/json. Never add unsafe-inline or unsafe-eval to solve a script problem. Static output substitutes `script-src 'none'` and its own CSS hash. Hash the precise encoded inline bytes, including whitespace; insert CSP before content/resources.

CSS is one trusted stylesheet; dynamic SVG values are safe numeric/presentation attributes, not inline style strings. HTML uses known class names. No runtime injected style tag in exports. No font fetches, telemetry, prefetch, remote error collection, network data lookup or update check. Browser-initiated unrelated traffic is distinguished from application resource requests in tests. Deliberate external-link navigation is allowed and tested separately from the zero-request document-load gate.

## Atomicity

Construct an export completely in memory (within limits), validate, then hand off to the selected save mechanism. CLI writes to a same-directory temporary file, fsyncs, and renames after validation; existing outputs require `--force` and are never partially truncated. If Windows replacement semantics cannot provide the same rename guarantee, use a backed-up staged replacement with restoration on failure and report the platform behaviour; never delete the old file first without a recoverable copy. Browser File System Access writes through its writable stream and aborts on error; fallback downloads report initiation only. Cancel leaves source and current answers unchanged.


## Asset map keys and export rebasing

The host AssetStore is keyed by the normalized image destination as used in source. Each Asset.path is its canonical content-hash path; multiple source keys may refer to the same hash/bytes. The store is constructed by an explicit file grant/import, not by source code. Validate key normalization, MIME/bytes/hash and root capability before mounting; a destination must never select an unrelated entry through a basename-only match.

A source bundle rewrites only image destination spans in a copy to Asset.path, recompiles that copy and uses only canonical keys in its packaged asset store. The source SHA-256 changes when a destination changes. A snapshot from the original source is therefore not a snapshot for that rewritten source; export a new snapshot from the reopened bundle when needed.

Interactive HTML uses the same destination-only canonicalization on a source copy before encoding ProgramIR. Recompile using a neutral source URI `tinta:/document.tinta` (`tinta:/document.md` for Markdown profile); all diagnostic spans in the embedded IR use that URI, never a local filesystem path. Transfer the chosen complete answer values by control name after verifying identical control definitions, evaluate the selected baseline, then fingerprint the copied source and build its StateEnvelope. Do not change the editor buffer, its revision or its external snapshot. Imported source/comments remain intact except these declared destination edits; artifact notices describe this canonical copy, not byte-for-byte preservation of input paths.

Static output does not embed source or IR. It resolves visible destinations through AssetStore and embeds only the resulting bytes. Its transient evaluation may carry source spans in memory, but no path-bearing diagnostic/source objects are serialized into the HTML. No static image marked hidden is included just because it exists in the source asset map.
