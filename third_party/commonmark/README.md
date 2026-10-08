# CommonMark corpus

The unmodified 652 examples in `spec.json` are the official CommonMark 0.31.2 corpus, downloaded from [the versioned specification](https://spec.commonmark.org/0.31.2/spec.json). `provenance.json` records the original URLs and SHA-256 digests of the corpus and upstream license.

The specification examples are copyright John MacFarlane and licensed under CC-BY-SA 4.0, as stated in the accompanying unmodified upstream `LICENSE`. They are not covered by this repository's MIT license. No test expectations have been altered. Tests validate the pinned tokenizer against the official HTML oracle, then compare the product's Markdown-profile parse structure with the base Markdown AST for every example, including raw HTML. The unsafe upstream HTML oracle exists only in tests; the product exposes syntax nodes and does not render HTML.
