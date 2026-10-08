import { compile, createSession } from "../../packages/engine/dist/index.js";
const { mountReader } = globalThis.TintaReaderRuntime.TintaReader;

const instances = [];

function mount(
  source,
  { profile = "tinta", baseline, observerThrows = false } = {},
) {
  const compiled = compile({ text: source, uri: "tinta:reader-test", profile });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled));
  const created = createSession(
    compiled.value,
    baseline ? { baseline } : undefined,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  const session = created.value;
  const diagnostics = [...compiled.diagnostics];
  if (observerThrows)
    session.subscribe(() => {
      throw new Error("Observer failure");
    });
  const host = document.createElement("div");
  document.querySelector("main").append(host);
  const result = mountReader(
    session,
    { nativeElement: host },
    {
      assets: new Map(),
      onDiagnostic: (d) => diagnostics.push(d),
    },
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
  instances.push({
    session,
    handle: result.value,
    host,
    diagnostics,
  });
  return instances.length - 1;
}

globalThis.readerTest = {
  mount,
  instances,
  mountReader,
  compile,
  createSession,
};
