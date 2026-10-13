import { createAsset, unwrap } from "@tinta-lang/artifacts";
import type { Asset } from "@tinta-lang/types";
import { exampleAssets } from "./studio-runtime.js";

export function exampleAssetStore(name: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();

  for (const item of exampleAssets[name] ?? []) {
    const bytes = Uint8Array.from(atob(item.base64), (char) =>
      char.charCodeAt(0),
    );
    const asset = unwrap(createAsset(bytes));
    if (asset.path !== item.path) {
      throw new Error(`Invalid asset for example ${name}.`);
    }
    assets.set(item.path, asset);
  }

  return assets;
}
