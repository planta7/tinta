import assert from "node:assert/strict";

export function checkParser({ parse, parseRecovering }) {
  const input = (text, profile = "markdown") => ({
    text,
    profile,
    uri: "tinta:consumer",
  });
  const budget = parse(input("ordinary ".repeat(100)), {
    limits: { compileOperations: 100 },
  });
  assert.equal(
    budget.ok,
    false,
    "Missing ordinary Markdown tokenizer budget hook",
  );
  assert.deepEqual(budget.diagnostics[0].details, {
    limitName: "compileOperations",
    observed: 101,
    maximum: 100,
  });
  assert.equal(budget.diagnostics[0].span.uri, "tinta:consumer");
  for (const [depth, ok] of [
    [62, true],
    [63, false],
    [1000, false],
  ]) {
    const result = parse(input("> ".repeat(depth) + "text"));
    assert.equal(result.ok, ok);
    if (!ok) assert.equal(result.diagnostics[0].code, "E_LIMIT");
  }
  const recovered = parseRecovering(input("@let =\n\n# After", "tinta"));
  assert.ok(recovered.diagnostics.length);
  assert.ok(
    recovered.value.tree.children.some((node) => node.kind === "heading"),
  );
}

if (process.argv[2] === "--installed") {
  checkParser(await import("@tinta-lang/syntax"));
}
