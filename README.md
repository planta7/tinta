<p align="center">
  <img src="docs/assets/tinta-header.svg" alt="tinta — A document. With more to say." width="1280">
</p>

<p align="center">
  <strong>A language for documents you can explore.</strong>
</p>

<p align="center">
  <a href="https://planta7.github.io/tinta/">Try the studio</a> ·
  <a href="#write-in-vs-code">Use VS Code</a> ·
  <a href="examples/README.md">Explore examples</a> ·
  <a href="docs/CHEATSHEET.md">Syntax cheatsheet</a> ·
  <a href="spec/00_OVERVIEW.md">Read the specification</a>
</p>

---

**tinta is a language for interactive documents.** Add controls, calculations and charts to Markdown so readers can change assumptions and see the results in the text. Save the document as a text file or export HTML that works offline.

Write in Studio, VS Code or a text editor, and use the CLI to check and export files. Exported HTML opens in a browser without these tools.

| Work in                            | Use it to                                                      |
| ---------------------------------- | -------------------------------------------------------------- |
| [tinta studio](#meet-tinta-studio) | Explore examples, write and preview documents in a browser.    |
| [VS Code](#write-in-vs-code)       | Write with completion, diagnostics and an interactive preview. |
| [The CLI](#try-it-locally)         | Check documents and create HTML exports from the terminal.     |

## Meet tinta studio

> [!NOTE]
> **You can try tinta studio in your browser.** [Open the demo →](https://planta7.github.io/tinta/)
> Explore an example, change a control and watch the document respond. No account needed.

Studio shows your source beside an interactive preview.

<p align="center">
  <img src="docs/assets/studio.png" alt="tinta studio editing the illustrated newsletter article: Markdown source on the left and the live document with two sliders on the right." width="1100">
</p>

<p align="center"><em>An <a href="examples/article.tinta">interactive article</a> open in tinta studio.</em></p>

- **Write and preview.** Edit the source and see the preview update. Use search and undo, and jump to errors in the source.
- **Start from Markdown or an example.** Browse rendered examples and reusable snippets. Bring an existing Markdown file or import local CSV, JSON and raster images.
- **Try controls and charts.** Move a slider, choose a scenario or inspect a chart. Text, tables and charts update from the same data.
- **Recover a draft.** Studio keeps local recovery copies. Save a source file to keep your own copy, then export HTML for readers.

New documents open ready to type. Existing documents open in Reading mode. Studio runs as a static web app or as a single local HTML file, without an account or backend. You can also [run it locally](#try-it-locally).

## Write in VS Code

The VS Code Desktop extension provides completion, diagnostics, hover help, definitions and references for `.tinta` files, plus an interactive preview with controls and charts.

Enrich an existing Markdown file into a separate tinta document, select local images, open and save source bundles, and export interactive or static HTML. Markdown files keep their normal editing behavior. Image, bundle, enrichment and export commands require a trusted workspace.

Install a VSIX from the [release downloads](https://github.com/planta7/tinta/releases) with **Extensions: Install from VSIX…**, then reload VS Code. Open a `.tinta` file and run **tinta: Open Preview**.

To build the extension from source, install the [repository toolchain and dependencies](#try-it-locally), then run:

```sh
pnpm package:vscode
```

Install the resulting `build/vscode/tinta-0.1.0-dev.0.vsix` with the same command. If switching to a release extension, disable or uninstall the local extension first to avoid duplicate providers.

Use the extension in VS Code Desktop on macOS arm64, Linux arm64 or Windows x64. Remote workspaces and vscode.dev are unsupported. Rename, quick fixes and formatting are not available.

See the [VS Code quickstart](docs/14_VSCODE_QUICKSTART.md) for examples, local installation, diagnostics and exports, and the [host reference](docs/13_VSCODE.md) for behavior and limits.

## Example document

This is a complete document:

```tinta
@meta (title: "Plan a reading session", locale: "en-US")
@let minutes_per_page = 2

# How much time should we set aside?

@slider pages = 8 (min: 1, max: 40, label: "Pages")
@toggle discussion = false (label: "Include a discussion")
@calc minutes = pages * minutes_per_page + if(discussion, 15, 0)

Reading **{{ pages }} pages** takes about **{{ minutes }} minutes**
with these choices.

@when minutes > 45
Consider dividing the reading into two sessions.
@end
```

Changing the page count or including a discussion updates the total. When it exceeds 45 minutes, the document suggests two sessions. The calculations and conditions are written directly in the source.

tinta uses Markdown for text formatting and adds its own syntax for values, calculations, controls, data and conditional content. It supports CommonMark 0.31.2, with pipe tables, task lists and double-tilde strikethrough. A `.md` file stays in Markdown mode until you explicitly choose **Enrich as tinta**; the original file is preserved.

## Try it locally

Download the standalone Studio HTML from the [release downloads](https://github.com/planta7/tinta/releases) and open it in a browser to work offline.

To run from source, use **Node 24.21.0** and **pnpm 10.34.6**. From a checkout:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the loopback URL printed by Vite, then choose **Explore examples** or **New document**. You can also open `.md`, `.tinta` and `.tinta.zip` files.

<details>
<summary><strong>Prefer the production build or a standalone file?</strong></summary>

```sh
pnpm build
pnpm preview
```

The static application is in `build/studio/`.

Open **`build/tinta-studio.html`** directly in a browser to use the standalone editor. Save your source files separately from browser recovery copies.

See the [setup and toolchain guide](docs/09_FOUNDATION_TOOLCHAIN.md) for prerequisites and troubleshooting.

</details>

<details>
<summary><strong>Prefer the command line?</strong></summary>

After `pnpm build`, validate and export an included example:

```sh
pnpm --filter @tinta-lang/cli exec tinta check examples/article.tinta
pnpm --filter @tinta-lang/cli exec tinta build examples/article.tinta \
  --format interactive --output build/article.interactive.html
pnpm --filter @tinta-lang/cli exec tinta build examples/article.tinta \
  --format static --output build/article.static.html
```

Open either output in a browser. Interactive HTML keeps the controls; static HTML captures the visible document with its initial answers. Replacing an existing output requires an explicit `--force`.

The [CLI reference](docs/06_CLI.md) covers validation, enrichment, imports, exports, answer snapshots and exit codes.

</details>

Studio targets modern desktop Chromium, Firefox and Safari; the reader and HTML exports also support narrow layouts. Storage, file access and assistive technology support vary by browser and device. See [supported environments](docs/01_PRODUCT.md#supported-usage-environments) and [accessibility](docs/05_ACCESSIBILITY_AND_DESIGN.md), including the limitations of automated WebKit testing for Safari and iOS.

## Language features

| In your document                      | What it does                                                               |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `@slider` · `@toggle` · `@choice`     | Let the reader adjust a number, switch an option or choose a scenario.     |
| `@let` · `@calc` · `{{ expression }}` | Connect constants and calculated values to the prose.                      |
| `@when` · `@details`                  | Adapt an explanation or let the reader open more context.                  |
| `@data` · `@view` · `@table`          | Embed typed data and reuse filtered views across text, tables and figures. |
| `@chart`                              | Explore line, area, bar, scatter, pie, donut and histogram figures.        |

Charts include keyboard exploration and a complete data table. Compatible charts can bind selection to an existing control; histograms support inspection. Invalid answer updates leave the previous valid document intact.

Start with the [cheatsheet](docs/CHEATSHEET.md), then explore the [expression rules](spec/02_EXPRESSIONS_AND_STATE.md), [directives](spec/03_DIRECTIVES.md), [data model](spec/04_DATA.md) and [chart specification](spec/05_CHARTS.md).

## Examples

| Document                                                 | Try this                                                  |
| -------------------------------------------------------- | --------------------------------------------------------- |
| [An article you can explore](examples/article.tinta)     | Change the growth assumption and inspect a period.        |
| [A report with shared filters](examples/report.tinta)    | Watch totals, tables and charts respond to the same view. |
| [A guide that adapts](examples/guide.tinta)              | Choose a platform and follow the relevant instructions.   |
| [Seven ways to see the data](examples/chart-atlas.tinta) | Compare all seven chart types in one document.            |

The [example collection](examples/README.md) also includes a minimal starting point, function examples, Markdown enrichment and a [portable image bundle](examples/local-image.tinta.zip).

## Save and share your document

| Format               | What you keep                                                       |
| -------------------- | ------------------------------------------------------------------- |
| `.tinta`             | Editable UTF-8 source and embedded table data.                      |
| `.tinta.zip`         | Source together with local PNG, JPEG or WebP images.                |
| **Interactive HTML** | A complete offline document with controls and its embedded runtime. |
| **Static HTML**      | The visible result, with fixed values and no interactive controls.  |
| `.tinta.state.json`  | Reader answers saved for this exact document.                       |

> [!IMPORTANT]
> **Interactive HTML includes the complete source, hidden branches and all embedded data.** Hidden content is still present in the file. Static HTML contains only the resolved visible presentation and its referenced images. Images may retain metadata. Read about [file formats and exports](docs/02_FILES_AND_EXPORTS.md).

Studio's local recovery stores up to 10 copies and 30 MiB, replacing the oldest copies first. It can be disabled, and copies can be deleted. Reader answers are not automatically persisted. Studio can explicitly export an answers snapshot; the CLI can apply a matching snapshot during export. The VS Code preview keeps answers in memory and can include them in HTML exports, but does not provide snapshot import/export. [How saving and recovery work →](docs/03_EDITOR_AND_READER.md)

CSV and JSON imports in Studio or the CLI copy data into typed document tables; they do not retain a live connection to the original file. Images must be local PNG, JPEG or WebP files. Use a source bundle when moving a document together with its images. See the [data and import rules](spec/04_DATA.md) and [file formats](docs/02_FILES_AND_EXPORTS.md).

## Limitations

Documents cannot run scripts or plug-ins, apply custom CSS, fetch remote data or submit forms. HTML is displayed as text, and code blocks remain literal examples. Images must be selected from local files.

Files stay on your device; tinta does not upload, synchronize or host documents, collect telemetry or call AI models. It does not provide page layouts or generate websites. PDF and flattened Markdown exports are not supported. See [supported features](docs/01_PRODUCT.md) and [security and privacy](docs/04_SECURITY.md).

## Write with a coding agent

The [tinta authoring skill](docs/16_AGENT_AUTHORING.md) helps Codex and Claude Code write and edit `.tinta` documents, enrich existing Markdown, and check the result with the local CLI. It includes a platform guide, a time estimate, and a report with shared filters as starting points.

Install the same skill folder in either agent, then ask it to create a document or update one you already have. The skill needs access to local files and a working tinta CLI to validate or export documents.

## Build with the engine

The parser and semantic engine are portable TypeScript. The reader and export runtime are independent of React and CodeMirror; those belong to the studio.

| Layer                                               | Documentation                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Parse and enrich Markdown                           | [Syntax API](docs/10_SYNTAX_API.md)                                                                   |
| Compile, evaluate and manage transactional sessions | [Engine API](docs/11_ENGINE_API.md)                                                                   |
| Render safe documents, controls and charts          | [Reader API](docs/12_READER_API.md)                                                                   |
| Integrate editor analysis and native previews       | [Editor analysis](contracts/editor-analysis.d.ts) · [Webview protocol](contracts/vscode-webview.d.ts) |
| Understand package boundaries                       | [Architecture](architecture/MODULES.md) · [Stack](architecture/STACK.md)                              |
| Work with public contracts                          | [Interfaces](contracts/public-api.d.ts) · [Contract rules](contracts/CONTRACT_RULES.md)               |

## Documentation

| Looking for                                   | Start here                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Syntax and complete documents                 | [Cheatsheet](docs/CHEATSHEET.md) · [Examples](examples/README.md)                                                |
| Studio editing, imports, saving and recovery  | [Editor and reader reference](docs/03_EDITOR_AND_READER.md)                                                      |
| VS Code installation and everyday use         | [Quickstart](docs/14_VSCODE_QUICKSTART.md) · [Host behavior and limits](docs/13_VSCODE.md)                       |
| Terminal commands and automation              | [CLI reference](docs/06_CLI.md)                                                                                  |
| Source bundles, answers and HTML exports      | [File and export formats](docs/02_FILES_AND_EXPORTS.md)                                                          |
| Language semantics and error codes            | [Specification](spec/00_OVERVIEW.md) · [Limits and diagnostics](spec/06_LIMITS_AND_DIAGNOSTICS.md)               |
| Keyboard use, charts and accessible reading   | [Accessibility and design](docs/05_ACCESSIBILITY_AND_DESIGN.md)                                                  |
| Local resource access and untrusted documents | [Security model](docs/04_SECURITY.md) · [Security reporting](SECURITY.md)                                        |
| Development setup and checks                  | [Toolchain](docs/09_FOUNDATION_TOOLCHAIN.md) · [Testing](docs/07_VERIFICATION.md) · [Scripts](scripts/README.md) |
| Package formats and versions                  | [Software distribution](docs/15_DISTRIBUTION.md)                                                                 |
| Scope and compatibility                       | [Product contract](docs/01_PRODUCT.md) · [Change control](docs/08_CHANGE_CONTROL.md)                             |

## Status

The language contract is **1.0-draft.3**, targeting source-format version **1.0**. Its syntax may change before stabilization. The repository includes the specification, reusable packages, CLI, Studio and VS Code extension. See the [compatibility rules](docs/08_CHANGE_CONTROL.md) and [changelog](https://github.com/planta7/tinta/blob/main/CHANGELOG.md) for format and software versions.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md), the [architecture](architecture/MODULES.md) and [compatibility rules](docs/08_CHANGE_CONTROL.md) before proposing language or contract changes. Report security issues through [SECURITY.md](SECURITY.md).

See [testing and performance](docs/07_VERIFICATION.md) and [test commands](scripts/README.md) for development checks.

## License

The original specification, engine, reference tools, fixtures and examples are available under the [MIT License](LICENSE). Bundled dependencies retain their own licenses, collected in `THIRD_PARTY_NOTICES.txt` at the repository root.
