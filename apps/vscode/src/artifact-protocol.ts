import type {
  Artifact,
  AssetStore,
  ControlState,
  Enrichment,
  OpenedBundle,
  SourceInput,
} from "@tinta-lang/types";

export type ArtifactRequest =
  | { readonly kind: "open"; readonly bytes: Uint8Array }
  | { readonly kind: "enrich"; readonly source: SourceInput }
  | {
      readonly kind: "inspect" | "produce";
      readonly source: SourceInput;
      readonly format: "bundle" | "interactive" | "static";
      readonly baseline?: ControlState;
      readonly assets: AssetStore;
    };

export type ArtifactReply =
  | { readonly kind: "open"; readonly bundle: OpenedBundle }
  | { readonly kind: "enrich"; readonly enrichment: Enrichment }
  | { readonly kind: "inspect"; readonly destinations: readonly string[] }
  | { readonly kind: "produce"; readonly artifact: Artifact }
  | { readonly kind: "error"; readonly code: string; readonly message: string };
