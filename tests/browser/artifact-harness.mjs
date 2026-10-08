import { compile, createSession } from "../../packages/engine/dist/index.js";
import { mountReader } from "../../packages/reader/dist/index.js";
import { exportHtml, unwrap } from "../../packages/artifacts/dist/index.js";

let session;
globalThis.exportTest = {
  mount(source) {
    session = unwrap(
      createSession(
        unwrap(
          compile({
            text: source,
            uri: "tinta:export-test",
            profile: "tinta",
          }),
        ),
      ),
    );
    unwrap(
      mountReader(
        session,
        { nativeElement: document.body },
        {
          assets: new Map(),
        },
      ),
    );
  },
  async export(format) {
    const artifact = unwrap(
      await exportHtml(session, new Map(), {
        format,
        answers: "current",
      }),
    );
    return new TextDecoder().decode(artifact.bytes);
  },
};
