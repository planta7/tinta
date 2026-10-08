import { compile, createSession } from "../../packages/engine/dist/index.js";
import { chartScene } from "../../packages/charts/dist/index.js";
import { mountReader } from "../../packages/reader/dist/index.js";
import { exportHtml, unwrap } from "../../packages/artifacts/dist/index.js";

const input = (text) => ({ text, uri: "tinta:performance", profile: "tinta" });
const elapsed = (operation) => {
  const start = performance.now();
  const value = operation();
  return { value, ms: performance.now() - start };
};

function charts(nodes) {
  return nodes.flatMap((node) =>
    node.kind === "chart"
      ? [node.chart]
      : "children" in node
        ? charts(node.children)
        : [],
  );
}

async function sample(source) {
  const compilation = elapsed(() => compile(input(source)));
  if (!compilation.value.ok)
    return {
      compile: compilation.ms,
      diagnostics: compilation.value.diagnostics,
    };
  const evaluation = elapsed(() =>
    unwrap(createSession(compilation.value.value)),
  );
  const session = evaluation.value;
  const geometry = elapsed(() =>
    charts(session.getRevision().nodes).map((chart) => chartScene(chart, 720)),
  );
  const host = document.querySelector("main");
  const mounting = elapsed(() =>
    unwrap(
      mountReader(
        session,
        { nativeElement: host },
        {
          assets: new Map(),
        },
      ),
    ),
  );
  const update = elapsed(() => unwrap(session.setControl("answer_0", 2)));
  const exportStart = performance.now();
  unwrap(
    await exportHtml(session, new Map(), {
      format: "interactive",
      answers: "current",
    }),
  );
  const exportMs = performance.now() - exportStart;
  mounting.value.destroy();
  session.destroy();
  host.replaceChildren();
  return {
    compile: compilation.ms,
    evaluate: evaluation.ms,
    initial: compilation.ms + evaluation.ms,
    geometry: geometry.ms,
    mount: mounting.ms,
    geometryAndMount: geometry.ms + mounting.ms,
    update: update.ms,
    export: exportMs,
  };
}

function cycles(source, count) {
  const program = unwrap(compile(input(source)));
  const host = document.querySelector("main");
  for (let i = 0; i < count; i++) {
    const session = unwrap(createSession(program));
    const reader = unwrap(
      mountReader(session, { nativeElement: host }, { assets: new Map() }),
    );
    reader.destroy();
    session.destroy();
    host.replaceChildren();
  }
}
globalThis.performanceTest = { sample, cycles };
