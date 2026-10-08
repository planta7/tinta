# Markdown integration, source positions and lexical grammar

## Encoding and losslessness

Files are UTF-8. Invalid byte sequences are `E_ENCODING`, not replacement decoding. An initial UTF-8 BOM is accepted, preserved in saved source and ignored for recognition of the first directive. CRLF, LF and CR are accepted as line endings; lexical line counting treats a CRLF pair as one newline. Preserve original source bytes on an unmodified save. New files use UTF-8 without BOM and LF. The editor must not normalize the entire existing file as a side effect of preview.

All source offsets and columns are UTF-16 code-unit counts, matching JavaScript/CodeMirror. Offsets are zero-based, half-open `[start,end)`; line and column are one-based. An astral character counts as two code units. CRLF advances one line, resets column to 1 and occupies two offsets. Every syntax and semantic node retains a span in the original source, not a deindented copy. Hashes cover the original UTF-8 bytes, including any BOM and original line endings.

In ordinary Markdown, NUL is rendered as U+FFFD according to the base parser and emits `W_NUL_REPLACED`; the source stays intact. A NUL in a Tinta identifier/token is invalid. JSON-escaped control characters in text values are data, never executable syntax; unsafe control characters in paths are prohibited separately.

## Block recognition

A Tinta directive begins with an unescaped `@` at **physical column 1**, outside Markdown fenced/indented code, raw HTML nodes, HTML comments, block quotes and list-item contents. It begins a new flow node and may interrupt a paragraph. The command token is `[a-z][a-z0-9_]*`, followed by whitespace, `(`, newline or end of input. A recognized prefix with an unknown command is `E_DIRECTIVE_UNKNOWN`. An `@` in normal prose, an email address or `@name.example` is not a command. Indented ` @slider ...`, quoted `> @slider ...` and list text `- @slider ...` are ordinary Markdown text, not active controls. Inline interpolations still work in their eligible prose contexts.

The engine uses a Markdown tokenizer extension with context, not a global line regex followed by a Markdown parse. CommonMark code and raw-node boundaries take precedence over directive discovery. A literal `@end` in a fenced code block never closes a Tinta block.

### Block boundaries

`@when`, `@details` and `@data` open blocks terminated by an exact column-1 `@end` line with optional trailing spaces/tabs and no other tokens. The innermost active Tinta block is closed. Unmatched `@end` is `E_BLOCK_END`; missing closure is `E_BLOCK_UNCLOSED` on the opener with an EOF related span. Nesting is limited by the registry.

`@when` and `@details` parse their bodies as Markdown+Tinta flow at the same physical indentation, so existing lists and code can be wrapped without reindentation. They may nest each other, controls, charts and tables. Root declarations are forbidden inside them. Empty bodies (only blank lines or comments) are `E_BLOCK_EMPTY`. `@data` has typed rows, not Markdown, and cannot contain another directive or a Tinta block. A quoted text cell containing `"@end"` is just data.

Because block directives are column-1 constructs, they are not supported inside a Markdown list item or block quote in V1. Authors can place a full list/quote inside a condition instead. No hidden indentation-based directive syntax is accepted as an alias for the old prototype.

### Option lists and line continuation

Directive options use one parenthesized list after the required positional operands, with comma-separated `key: value` entries. Spaces/tabs are optional around punctuation. A trailing comma is allowed. Duplicate or unsupported keys are errors. One option list at most is accepted. Expressions within a group follow the same comma/parenthesis balancing rules as function calls; a comma in a string is not a separator.

```tinta
@choice platform = "macOS" (
  options: ["macOS", "Windows", "Linux"],
  label: "Your platform",
)
```

A directive may cross a physical newline only while an expression parenthesis, list bracket or option-list parenthesis is open. Strings do not contain literal newlines; use JSON escapes. A line with no open delimiters ends a leaf directive. `@calc result =` followed by an unparenthesized expression on the next line is an error. To split it, write `@calc result = (` and a balanced expression. Leaf directives cannot have trailing prose. `@end` is never required for a leaf directive.

## Inline interpolation

In Tinta mode, the unescaped token `{{` begins an inline expression, closed by `}}` outside expression strings. Whitespace around the expression is allowed. Newlines are forbidden inside an interpolation. Empty expressions, missing closures, illegal tokens and nesting over the limit are errors.

Eligible contexts: paragraph text, headings, emphasis/strong/strikethrough contents, list/quote text, GFM table cell text and link labels. Ineligible contexts: code spans, fenced or indented code, link destinations/titles, autolinks, image destinations/alt text, raw HTML and comments. Interpolation results are escaped text; they are never reparsed as Markdown, a URL, HTML or another interpolation. Only scalar results are printable. Boolean output is the English text `true` or `false`, independent of formatting locale.

Single braces remain ordinary text: JSON snippets and `{example}` do not activate Tinta. To display literal double braces in an eligible context, escape the first opening brace: `\{{ example }}`. The normal CommonMark backslash semantics apply; an already escaped backslash does not escape the next brace. Entity expansion cannot create active `{{` or `@` tokens after lexing.

## Comments and raw HTML

CommonMark HTML comments are hidden author notes. They are not secret and remain in `.tinta` and interactive exports. `//` has no Tinta comment meaning and is ordinary text. All other author HTML nodes are rendered as literal escaped source, not converted into live tags and not passed to a browser HTML parser. Emit `W_HTML_INERT` once per raw node. Markdown inside a raw HTML node is not reparsed. Script/style/template tags are equally inert. The standard Markdown parser, not a handwritten HTML scanner, defines raw-node extent.

## Markdown extensions and links

The only added Markdown dialect features are GFM tables, task lists and strikethrough requiring **two** tildes (`~~text~~`); one tilde remains literal. Task checkboxes are disabled and not runtime controls. GFM autolink literals and footnotes are not enabled by bundling a broad convenience plugin. Markdown link reference definitions follow CommonMark scope and normalization across the full document, including condition/detail bodies. Duplicate reference handling follows the base spec. An implementation must not accidentally give each Tinta block an isolated reference map.

Links allow `https:`, `http:`, `mailto:` and same-document `#fragment`. External links use explicit user activation only, `target="_blank"`, `rel="noopener noreferrer"` and no prefetch. Relative non-image links are rendered as inert link-label text with `W_LINK_LOCAL_UNSUPPORTED`, because V1 has no document navigation resolver. Scheme-relative, `javascript:`, `data:`, `file:`, `vbscript:` and unknown schemes are inert and `W_LINK_UNSAFE`. Image policy is stricter and lives in the artifact contract. URI validation occurs after Markdown entity/backslash decoding and rejects embedded ASCII control/space obfuscation around a scheme.

Heading IDs are stable under state changes. Take literal non-interpolated heading text, Unicode-normalize NFKD, discard combining marks, retain Unicode letters/digits, lower-case with locale-independent mapping, replace every run of other characters with one hyphen and trim hyphens. Use `section` if empty. Prefix `tinta-`; append `-2`, `-3`, etc. for duplicates in source order across all branches. An interpolation is omitted from the slug. For `# Hello {{ name }}` use `tinta-hello`. Generated DOM IDs for controls/charts occupy separate prefixes and never come from arbitrary author IDs.

## Same-document anchor resolution

Preserve conventional Markdown heading links despite renderer-owned ID prefixes. Build a heading map from every heading across the complete source, including hidden bodies. For a `#fragment`, decode percent escapes once as strict UTF-8; match the resulting string against a heading's unprefixed generated slug first (for example `hello` or `hello-2`), then against the full generated ID (for example `tinta-hello`). Comparison is exact and case-sensitive. On a match, render href with that heading's canonical `#tinta-...` ID. This changes only the rendered destination, not source. The unprefixed-first rule also defines the rare collision where a heading's own slug starts with `tinta-`.

An unmatched well-formed fragment remains an inert same-document navigation attempt with no external request, not an inferred file path. A target inside a false condition is not force-revealed and does not change answers. Fragment resolution never synthesizes HTML or interprets expressions in destinations. Markdown and Tinta profiles use the same safe heading/link policy, so enrichment preserves it.

## Markdown enrichment algorithm

`enrichMarkdown(source)` parses in Markdown mode and returns a new source plus exact text edits. It does not modify the source file. Work on source spans, not a pretty-printed AST. In eligible normal-text locations, insert one backslash before every unescaped raw `{{`. At root flow locations where a column-1 directive candidate would be recognized in Tinta mode, insert one backslash before `@`, including unknown directive names and `@end`. Do not touch code, raw HTML/comments, escaped tokens, link/image destinations or image alt text. Apply edits from greatest to least source offset.

Reparse the resulting source in Tinta mode and compare its safe-render semantic Markdown tree with the original Markdown-mode tree, ignoring inserted escapes/source positions. Any unexpected semantic difference is `E_IMPORT_PRESERVATION`; return no transformed source. Return the proposed changes and warnings for review. This is safe Markdown-profile equivalence, not equivalence to an arbitrary external renderer with executable HTML or extra plugins. No metadata or formatting rewrite is silently inserted. The original file remains openable; save of the new enriched buffer defaults to a distinct `.tinta` path.
