import { compile, createSession } from "../../packages/engine/dist/index.js";
import { mountReader } from "../../packages/reader/src/index.ts";

const source =
  "# Preserved\n@slider amount = 2 (min: 0, max: 10)\nValue: {{ amount }}";
const compiled = compile({
  text: source,
  profile: "tinta",
  uri: "tinta:/incident.tinta",
});
const session = createSession(compiled.value).value;
const diagnostics = [];
let operation = "action";
const hostSession = {
  ...session,
  setControl(...args) {
    if (operation === "action") throw new Error("private action payload");
    return session.setControl(...args);
  },
  reset() {
    throw new Error("private reset payload");
  },
  subscribe(listener) {
    const unsubscribe = session.subscribe(listener);
    return () => {
      unsubscribe();
      throw new Error("private cleanup payload");
    };
  },
};
const result = mountReader(
  hostSession,
  { nativeElement: document.querySelector("main") },
  {
    assets: new Map(),
    onDiagnostic(item) {
      diagnostics.push(item);
      if (operation === "diagnostic")
        throw new Error("private subscriber payload");
    },
  },
);
if (!result.ok) throw new Error("Synthetic reader did not mount");
globalThis.incidentTest = {
  diagnostics,
  result,
  session,
  setOperation(value) {
    operation = value;
  },
  failSubscriber() {
    session.subscribe(() => {
      throw new Error("private engine subscriber payload");
    });
  },
};
