import { encodeProgram } from "@tinta/engine";
import type { AssetStore, ControlState, Program } from "@tinta/types";
import {
  base,
  baseKeys,
  controls,
  exact,
  identity,
  integer,
  token,
  type Base,
} from "./protocol.js";
import { previewHtml } from "./studio-runtime.js";

export class PreviewHost {
  readonly frame = document.createElement("iframe");
  private port?: MessagePort;
  private header: Base;
  private enabled = true;
  private ready = false;
  private current: {
    program: Program;
    assets: AssetStore;
    baseline: ControlState;
  };
  private onHello: (event: MessageEvent<unknown>) => void;
  constructor(
    parent: HTMLElement,
    program: Program,
    assets: AssetStore,
    baseline: ControlState,
    revision: number,
    changed: (state: ControlState) => void,
    failure: (message: string) => void,
  ) {
    this.current = { program, assets, baseline };
    this.header = {
      protocol: "tinta-host-1",
      documentId: token(),
      capability: token(),
      requestId: 0,
      sourceRevision: revision,
    };
    this.frame.title = "Document preview";
    this.frame.setAttribute(
      "sandbox",
      "allow-scripts allow-popups allow-popups-to-escape-sandbox",
    );
    this.onHello = (event) => {
      if (
        event.source !== this.frame.contentWindow ||
        this.port ||
        typeof event.data !== "object" ||
        event.data === null ||
        JSON.stringify(event.data) !==
          JSON.stringify({ protocol: "tinta-host-1", kind: "hello" })
      )
        return;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = (message: MessageEvent<unknown>) => {
        const data = message.data;
        if (
          !base(data) ||
          !identity(data, this.header) ||
          data.sourceRevision > this.header.sourceRevision ||
          data.requestId > this.header.requestId
        ) {
          this.destroy();
          failure("E_PROTOCOL: Invalid preview message.");
          return;
        }
        if (
          data.sourceRevision < this.header.sourceRevision &&
          data.kind !== "ready"
        )
          return;
        if (data.kind === "ready" && !this.ready && exact(data, baseKeys)) {
          this.ready = true;
          this.loadCurrent();
          this.setEnabled(this.enabled);
        } else if (
          data.kind === "state" &&
          exact(data, [...baseKeys, "controls", "sessionRevision"]) &&
          controls(data.controls) &&
          integer(data.sessionRevision)
        ) {
          changed(data.controls as ControlState);
        } else {
          this.destroy();
          failure("E_PROTOCOL: Unexpected preview message.");
        }
      };
      this.frame.contentWindow!.postMessage(
        { ...this.header, kind: "connect" },
        "*",
        [channel.port2],
      );
    };
    window.addEventListener("message", this.onHello);
    this.frame.srcdoc = previewHtml;
    parent.replaceChildren(this.frame);
  }

  update(
    program: Program,
    assets: AssetStore,
    baseline: ControlState,
    revision: number,
  ): void {
    this.current = { program, assets, baseline };
    this.header.sourceRevision = revision;
    if (this.ready) this.loadCurrent();
    this.setEnabled(true);
  }

  private loadCurrent(): void {
    const { program, assets, baseline } = this.current;
    this.send("load", {
      program: encodeProgram(program),
      assets: [
        ...new Map(
          [...assets.values()].map((asset) => [asset.path, asset]),
        ).values(),
      ],
      assetPaths: Object.fromEntries(
        [...assets]
          .filter(([path, asset]) => path !== asset.path)
          .map(([path, asset]) => [path, asset.path]),
      ),
      baseline,
    });
  }

  private send(kind: string, extra: Record<string, unknown> = {}): void {
    this.port?.postMessage({
      ...this.header,
      requestId: ++this.header.requestId,
      kind,
      ...extra,
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.ready) this.send("set-enabled", { enabled });
  }

  reset(): void {
    this.send("reset");
  }

  destroy(): void {
    this.port?.close();
    window.removeEventListener("message", this.onHello);
    this.frame.remove();
  }
}
