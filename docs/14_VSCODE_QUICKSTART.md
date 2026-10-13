# tinta for VS Code

Write interactive documents in the VS Code editor. Start with Markdown, then add controls, calculations, tables and charts. The extension highlights `.tinta` files, helps you write expressions and directives, reports errors in Problems, and shows a live preview beside your source.

Learn more about the language, examples and other tools in the [tinta project on GitHub](https://github.com/planta7/tinta). The [syntax cheatsheet](https://github.com/planta7/tinta/blob/main/docs/CHEATSHEET.md) is a useful reference while writing.

## Install and start writing

Install the supplied `.vsix` with **Extensions: Install from VSIX…**, then reload VS Code. Open a `.tinta` file, or choose **tinta** as the language for a new untitled editor. The extension runs in VS Code Desktop on macOS arm64, Linux arm64 and Windows x64. Remote workspaces, containers, virtual filesystems and vscode.dev are unsupported.

Try this in `example.tinta`:

```tinta
# My document

@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")
@calc doubled = amount * 2

Twice the amount is {{ doubled }}.
```

Run **tinta: Open Preview** and move the slider. The result changes as you read. Use **tinta: Reset Reading** to return to the document's starting values.

Type `@` to see available directives. Completion also helps inside expressions and options. Hover over a name for help, or use **Go to Definition** and **Find All References** to navigate names in the document. Run **tinta: Check** to update diagnostics immediately.

Add a chart with a small table:

```tinta
@data readings
name: text | value: number
A | 2
B | 5
@end
@chart bar readings (x: "name", y: "value")
```

## Work with Markdown and images

To build on an existing `.md` file, run **tinta: Enrich Markdown**. Review the proposed changes and create a separate `.tinta` document. Your Markdown file stays as it was.

For an image such as `![Photo](images/photo.png)`, run **tinta: Select Image Root** and choose the directory containing `images`. Use **tinta: Refresh Images** after changing an image on disk. Images must be local raster files; missing images appear as placeholders in the preview.

Use **tinta: Open Source Bundle** to open a `.tinta.zip` containing source and local images. **tinta: Save Source Bundle** creates a portable bundle. Save ordinary `.tinta` files with VS Code's usual Save command.

## Export a document

Run **tinta: Export Interactive HTML** to give readers working controls and charts, or **tinta: Export Static HTML** to save the current visible result. You can export the document's starting values or the current preview answers. Both HTML files open in a browser without the extension.

Interactive HTML contains the complete source, data and hidden branches. Static HTML contains the visible result and its required images. Review the export choice when the document contains private content.

## Limits and help

Preview answers stay in memory and reset when the preview is closed or recreated. Editing an existing file with mixed or lone-CR line endings may require **tinta: Create UTF-8/LF Copy for Preview**; the original remains untouched. Image, bundle, Markdown enrichment and export commands require a trusted workspace.

The extension has no rename, quick fix or formatting command. It does not run authored JavaScript, CSS or HTML. For language details and troubleshooting, see the [project documentation](https://github.com/planta7/tinta/tree/main/docs).
