# Tinta for VS Code Desktop

Write Markdown-first interactive documents locally with controls, formulas, tables and seven chart types. This development extension targets language contract **1.0-draft.3**, source format **1.0**, and VS Code Desktop **1.141.0**. No account, global CLI, external Node installation or network service is needed.

## Install offline

Use **Extensions: Install from VSIX…** and choose the downloaded `.vsix` file, then reload VS Code. Alternatively, run `code --install-extension /path/to/tinta.vsix`. The extension is not available on the Marketplace yet. Only macOS arm64 has native test observations; Linux and Windows remain unverified. Remote workspaces, containers, virtual filesystems and vscode.dev are unsupported.

If you switch from the local `tinta-local.tinta` extension to `tinta.tinta`, disable or uninstall the local extension before enabling the new one to avoid duplicate language providers. Keep your documents and check your settings after switching; settings are not migrated automatically.

## Create a document

Create `example.tinta`, or select **Tinta** as the language of a new untitled editor. Insert:

```tinta
# My document

@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")
@calc doubled = amount * 2

Twice the amount is {{ doubled }}.
```

Type `@` to complete a directive, or use completion inside an expression or option list. Hover over a name for help; use **Go to Definition** or **Find All References** for resolvable globals. Change `amount` in the expression to `missing`, run **Tinta: Check**, and inspect `E_NAME_UNKNOWN` in Problems. Restore `amount` to resolve the error.

Run **Tinta: Open Preview** and move the slider. **Tinta: Reset Reading** restores authored defaults. To add a chart, append:

```tinta
@data readings
name: text | value: number
A | 2
B | 5
@end
@chart bar readings (x: "name", y: "value")
```

To enrich Markdown, open a `.md` file and run **Tinta: Enrich Markdown**. Review the diff and confirm a separate Tinta buffer. Markdown files never acquire Tinta behavior automatically.

## Images, bundles and exports

For `![Photo](images/photo.png)`, run **Tinta: Select Image Root** and explicitly choose the directory containing `images`. Refresh changed images with **Tinta: Refresh Images**. Only validated local raster images are allowed; the workspace itself grants no access. Missing images are reported separately from source diagnostics.

Use **Tinta: Open Source Bundle** for `.tinta.zip`. It validates the archive and opens a new source buffer with images retained in memory; nothing is implicitly extracted. **Tinta: Save Source Bundle** saves source and local images. Ordinary text saves remain native VS Code operations.

Run **Tinta: Export Interactive HTML** or **Tinta: Export Static HTML**, choose authored initial or current reading answers, review the disclosure and choose a destination. Current answers require a matching valid preview. Exports include unsaved verified edits; source changes during export cancel the operation. Open the HTML directly in a browser with networking disabled. Interactive exports contain all source/data and hidden branches; static exports contain only the resolved visible presentation and required images. Neither needs this extension after export.

## Features and limits

| Feature | Behavior |
|---|---|
| Editing | Native text editor, diagnostics, semantic highlighting, folding, completion, hover, signatures and outline |
| Navigation | Exact global definitions/references; ambiguous bindings and column navigation are unavailable |
| Preview | Existing reader, controls and line/area/bar/scatter/pie/donut/histogram charts; invalid source retains a visibly stale disabled preview |
| Restricted Mode | Text checks and preview; image-root, bundle, enrichment and export commands require trust and explicit file choices |
| Source fidelity | Validated UTF-8; unchanged BOM/EOL bytes retained; edited mixed/lone-CR files and unverified restored buffers require a separate UTF-8/LF copy for preview/export |
| Answers | Memory only; closing/reconstructing the preview resets answers; no automatic answer persistence |
| Excluded | Rename, quick fixes, formatter, publication, remote data, author JavaScript/CSS/HTML execution |

## Diagnostics and recovery

**Tinta: Check** validates the active source immediately. Problems retain diagnostic codes and exact source locations. `E_NAME_UNKNOWN` means an unresolved name; `E_NAME_DUPLICATE` means a repeated declaration; `E_ENCODING` means invalid UTF-8; `E_LIMIT` means a bounded resource limit was reached. Asset failures, source-fidelity failures and host capacity are separate from language validity. A host failure shows an opaque incident identifier rather than authored text or a stack trace. Fix the source and check again; do not discard the buffer. A stalled worker is terminated and restarted. Avoid editing more than eight actively analyzed documents at once.

## CLI and CI

The extension does not install a global CLI. In a repository with the separately provisioned Tinta CLI, use `tinta check document.tinta --json` for source diagnostics; see the CLI documentation for asset-check options and exit-code usage. With the source workspace and pinned toolchain, the equivalent is `pnpm --filter @tinta/cli exec tinta check document.tinta --json`. CI should fail on the command's nonzero exit status. Never choose a workspace executable from authored document text.

The minimum and currently tested VS Code build are both 1.141.0, commit `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`. Later desktop versions require fresh compatibility testing. Language draft changes can narrow accepted input; preserve original source files and inspect diagnostics before exporting.
