# @tinta-lang/cli

Use `tinta` in a terminal to check documents, enrich Markdown, import local data, make source bundles and export standalone HTML.

```sh
npx --package @tinta-lang/cli tinta --help
npx --package @tinta-lang/cli tinta check document.tinta
npx --package @tinta-lang/cli tinta build document.tinta --format interactive --output document.html
```

The command works with local files. Image access requires an explicit asset root where the command offers one. `tinta studio` prints the local editor’s file URL. Open that URL in a browser, or use `--output` to copy the HTML file. The command does not start a server.

See the [CLI guide](https://github.com/planta7/tinta/blob/main/docs/06_CLI.md) and [quickstart](https://github.com/planta7/tinta#try-it-locally).
