import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

export async function installedWorkflow(root, open, groups) {
  let id = 0;
  const ui = async (action, extra = {}) => {
    const request = { id: ++id, action, ...extra };
    await writeFile(join(root, "ui-request.json"), JSON.stringify(request));
    return request;
  };
  const finished = async (request) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const response = await readFile(join(root, "ui-response.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (response?.id === request.id) {
        assert.equal(response.error, undefined, response.error);
        return;
      }
      await new Promise((accept) => setTimeout(accept, 25));
    }
    throw new Error(`UI did not complete ${request.action}.`);
  };
  const markdown = await open(
    "enrich.md",
    "# Markdown\nLiteral {{ amount }}\n",
  );
  const enrichment = await ui("enrich");
  await vscode.commands.executeCommand("tinta.enrichMarkdown");
  await finished(enrichment);
  assert.equal(markdown.getText(), "# Markdown\nLiteral {{ amount }}\n");
  assert.equal(vscode.window.activeTextEditor.document.languageId, "tinta");
  assert.notEqual(
    vscode.window.activeTextEditor.document.uri.toString(),
    markdown.uri.toString(),
  );
  groups.push(
    "installed enrichment diff creates a separate Tinta buffer via actual UI confirmation",
  );
  const source = `@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")
Value: {{ amount }}

@data readings
name:text | value:number
A | 2
B | 5
@end
@chart bar readings (x: "name", y: "value")

![Photo](photo.png)

@when false
Hidden confidential prose
@end
`;
  const document = await open("workflow.tinta", source);
  const rootChoice = await ui("root", { path: join(root, "workspace") });
  await vscode.commands.executeCommand("tinta.selectImageRoot");
  await finished(rootChoice);
  await vscode.commands.executeCommand("tinta.openPreview");
  const controls = await ui("controls");
  await finished(controls);
  groups.push(
    "installed preview renders chart and granted image; real slider changes reading state",
  );
  for (const [command, name] of [
    ["exportInteractive", "interactive.html"],
    ["exportStatic", "static.html"],
  ]) {
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const path = join(root, "workspace", name);
    const request = await ui("export", { path });
    await vscode.commands.executeCommand(`tinta.${command}`);
    await finished(request);
    assert.ok((await stat(path)).size > 1000);
    const html = await readFile(path, "utf8");
    assert.ok(html.includes("image/png"));
    if (name === "static.html") {
      assert.ok(!html.includes("Hidden confidential prose"));
      assert.ok(!html.includes("@slider"));
    }
    groups.push(
      `installed ${command} writes current reading snapshot through native dialogs`,
    );
  }
  const offline = await ui("offline", { directory: join(root, "workspace") });
  await finished(offline);
  groups.push(
    "both installed HTML exports open offline; interactive controls still operate",
  );
}
