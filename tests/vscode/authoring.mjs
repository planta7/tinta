import * as vscode from "vscode";
import assert from "node:assert/strict";

export async function testAuthoring(open, results) {
  const text =
    "@let amount = 2\n# 😀 Heading\n{{ amount }}\n\namount `amount`\n";
  const source = await open("authoring.tinta", text);
  const definitions = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    source.uri,
    new vscode.Position(2, 5),
  );
  assert.equal(definitions.length, 1);
  const target = definitions[0].targetSelectionRange ?? definitions[0].range;
  assert.equal(source.getText(target), "amount");
  assert.equal(target.start.line, 0);
  assert.equal(target.start.character, 5);
  const references = await vscode.commands.executeCommand(
    "vscode.executeReferenceProvider",
    source.uri,
    new vscode.Position(0, 7),
  );
  assert.ok(references.some((item) => item.range.start.line === 2));
  assert.ok(references.every((item) => [0, 2].includes(item.range.start.line)));
  const [symbols, overlappingSymbols] = await Promise.all([
    vscode.commands.executeCommand(
      "vscode.executeDocumentSymbolProvider",
      source.uri,
    ),
    vscode.commands.executeCommand(
      "vscode.executeDocumentSymbolProvider",
      source.uri,
    ),
  ]);
  assert.deepEqual(
    overlappingSymbols.map((item) => item.name),
    ["amount", "😀 Heading"],
  );
  assert.deepEqual(
    symbols.map((item) => item.name),
    ["amount", "😀 Heading"],
  );
  const hovers = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    source.uri,
    new vscode.Position(2, 5),
  );
  assert.ok(
    hovers[0].contents.some(
      (item) =>
        item.value ===
        new vscode.MarkdownString().appendText("amount: number").value,
    ),
  );
  for (const content of hovers[0].contents) {
    assert.ok(!content.isTrusted);
    assert.ok(!content.supportHtml);
  }
  results.push(
    "native definition, references, symbols and untrusted plain-text hover",
  );

  const incomplete = await open("completion.tinta", "@sl");
  const completions = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    incomplete.uri,
    new vscode.Position(0, 3),
  );
  const example = completions.items.find(
    (item) => item.label === "slider example",
  );
  assert.ok(example, "Missing complete slider example");
  assert.ok(!completions.items.some((item) => item.label === "end"));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(incomplete.uri, example.range, example.insertText);
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.equal(
    incomplete.getText(),
    '@slider example = 5 (min: 0, max: 10, step: 1, label: "Amount")',
  );
  const sliderSymbols = await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    incomplete.uri,
  );
  assert.equal(sliderSymbols[0].name, "example");
  assert.equal(vscode.languages.getDiagnostics(incomplete.uri).length, 0);
  results.push("native unfinished completion and inserted complete example");

  const table = "@data records\nvalue:number | title:text\n1 | A\n@end\n";
  const columns = await open(
    "columns.tinta",
    table + "@view subset = records (where: row.",
  );
  const choices = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    columns.uri,
    columns.positionAt(columns.getText().length),
  );
  assert.deepEqual(choices.items.map((item) => item.label).sort(), [
    "title",
    "value",
  ]);
  const call = await open("signature.tinta", "{{ pow(2, round(1.2, ");
  const signatures = await vscode.commands.executeCommand(
    "vscode.executeSignatureHelpProvider",
    call.uri,
    new vscode.Position(0, call.getText().length),
  );
  assert.equal(
    signatures.signatures[0].label,
    "round(number, number=0) -> number",
  );
  assert.equal(signatures.activeParameter, 1);
  results.push("native row columns and nested incomplete signature help");

  const broken = await open(
    "ambiguous.tinta",
    "@let amount = 1\n@let amount = 2\n{{ amount }}\n@slider size = 1\n",
  );
  const ambiguous = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    broken.uri,
    new vscode.Position(2, 5),
  );
  assert.equal(ambiguous.length, 0);
  const local = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    broken.uri,
    new vscode.Position(3, 3),
  );
  assert.ok(
    local[0].contents.some((item) =>
      item.value.includes(
        new vscode.MarkdownString().appendText("Numeric control").value,
      ),
    ),
  );
  const fenced = await open("inactive-authoring.tinta", "```tinta\n@sl\n```\n");
  const inactive = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    fenced.uri,
    new vscode.Position(1, 3),
  );
  assert.equal(
    inactive.items.length,
    0,
    JSON.stringify({
      text: fenced.getText(),
      items: inactive.items,
    }),
  );
  results.push(
    "native ambiguous navigation, safe local help and literal isolation",
  );
}
