import { compile, createSession } from "../../packages/engine/dist/index.js";
import { mountReader } from "../../packages/reader/dist/index.js";
import {
  createAsset,
  exportHtml,
  unwrap,
} from "../../packages/artifacts/dist/index.js";

let session;
let assets;
globalThis.exportTest = {
  mount(source, image) {
    assets = new Map();
    if (image) {
      const asset = unwrap(createAsset(Uint8Array.from(image)));
      assets.set(asset.path, asset);
    }
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
          assets,
        },
      ),
    );
  },
  async export(format) {
    const artifact = unwrap(
      await exportHtml(session, assets, {
        format,
        answers: "current",
      }),
    );
    return new TextDecoder().decode(artifact.bytes);
  },
};
