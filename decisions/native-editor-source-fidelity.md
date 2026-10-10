# Native editor source fidelity

The source contract accepts UTF-8 BOM, LF, CRLF and CR and hashes original bytes. The VS Code native text model strips BOM and represents lone-CR/mixed line endings using its selected EOL. Saving an edited model can therefore rewrite untouched line endings. Replacement-decoded text cannot establish UTF-8 validity.

For example, disk bytes for `A\rB\n` become a uniform-EOL native buffer. An edit to `A` followed by native Save can also change the separator after `B`. Merely tracking native editor offsets cannot preserve that disk identity.

The adapter retains strictly validated original bytes for unchanged documents and maps compiler UTF-16 spans to the native model. Files with lone CR or mixed line endings require explicit conversion to a separate UTF-8/LF copy before Tinta preview/export of edited source. Show the conversion; retain the original. Native VS Code Save is outside Tinta's byte-preservation guarantee. Explain that limitation when encountering the file; never silently normalize or intercept native saves to overwrite source. Unverified restored dirty buffers likewise require a separate verified copy. Encoding/EOL changes invalidate snapshots.

This is a host limitation, not a new source restriction: CLI, engine and existing source artifacts continue accepting all specified line endings. Invalid bytes remain E_ENCODING. URI/instance/version/hash and asset/answer revisions must agree across preview, export and snapshots. No IR or source-format revision is needed. See [the complete host contract](../docs/13_VSCODE.md).

The host compatibility tests in `tests/vscode/host.mjs` exercise unmodified and edited saves, BOM, line endings, astral positions and invalid UTF-8. The mapping probe checks that source ranges refer to original bytes without representing a collapsed native newline position as invertible.
