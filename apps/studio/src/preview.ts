import { createSession, decodeProgram } from "@tinta/engine";
import { mountReader } from "@tinta/reader";
import { validateAssets } from "@tinta/artifacts";
import type { Asset, ControlState, ReaderHandle, Session } from "@tinta/types";
import {
  base,
  baseKeys,
  controls,
  exact,
  identity,
  record,
  type Base,
} from "./protocol.js";

let port: MessagePort | undefined;
let connected = false;
let session: Session | undefined;
let reader: ReaderHandle | undefined;
let expected: Base | undefined;
let lastRequest = -1;
let enabled = true;
const host = document.createElement("main");
document.body.append(host);

function dispose(): void {
  reader?.destroy();
  session?.destroy();
  port?.close();
  port = undefined;
}

function reject(): void {
  if (expected) {
    const position = { offset: 0, line: 1, column: 1 };
    port?.postMessage({
      ...expected,
      kind: "diagnostics",
      diagnostics: [
        {
          code: "E_PROTOCOL",
          severity: "error",
          phase: "host",
          message: "Invalid preview message. The channel has been closed.",
          span: {
            uri: "tinta:/preview",
            start: position,
            end: position,
          },
        },
      ],
    });
  }
  dispose();
}

function state(): void {
  if (expected && session)
    port?.postMessage({
      ...expected,
      kind: "state",
      controls: session.getRevision().state,
      sessionRevision: session.getRevision().number,
    });
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    connected ||
    event.source !== parent ||
    !base(event.data) ||
    event.data.kind !== "connect" ||
    !exact(event.data, baseKeys) ||
    event.ports.length !== 1
  )
    return;
  expected = event.data;
  connected = true;
  port = event.ports[0]!;
  port.onmessage = (message: MessageEvent<unknown>) => {
    const data = message.data;
    if (
      !base(data) ||
      !expected ||
      !identity(data, expected) ||
      data.requestId <= lastRequest ||
      (data.sourceRevision !== expected.sourceRevision &&
        !(
          data.kind === "load" && data.sourceRevision > expected.sourceRevision
        ))
    )
      return reject();
    lastRequest = data.requestId;
    expected = {
      protocol: data.protocol,
      documentId: data.documentId,
      capability: data.capability,
      requestId: data.requestId,
      sourceRevision: data.sourceRevision,
    };
    if (
      data.kind === "load" &&
      exact(data, [
        ...baseKeys,
        "program",
        "assets",
        "assetPaths",
        "baseline",
      ]) &&
      Array.isArray(data.assets) &&
      data.assets.length <= 100 &&
      (data.baseline === undefined || controls(data.baseline))
    ) {
      const program = decodeProgram(data.program);
      if (!program.ok) return reject();
      const assets = new Map<string, Asset>();

      for (const asset of data.assets) {
        if (
          !record(asset) ||
          !exact(asset, ["path", "mime", "bytes", "sha256"]) ||
          !(asset.bytes instanceof Uint8Array) ||
          typeof asset.sha256 !== "string" ||
          typeof asset.mime !== "string" ||
          typeof asset.path !== "string" ||
          assets.has(asset.path)
        )
          return reject();
        assets.set(asset.path, asset as unknown as Asset);
      }
      if (data.assetPaths !== undefined) {
        if (
          !record(data.assetPaths) ||
          Object.keys(data.assetPaths).length > 100000
        )
          return reject();
        const canonical = new Map(assets);
        for (const [path, target] of Object.entries(data.assetPaths)) {
          if (typeof target !== "string") return reject();
          const asset = canonical.get(target);
          if (!asset || (canonical.has(path) && path !== target))
            return reject();
          assets.set(path, asset);
        }
      }
      try {
        validateAssets(assets);
      } catch {
        return reject();
      }

      const created = createSession(program.value);
      if (!created.ok) return reject();
      if (
        data.baseline !== undefined &&
        !created.value.setControls(data.baseline as ControlState).ok
      ) {
        created.value.destroy();
        return reject();
      }

      const scroll = window.scrollY;
      reader?.destroy();
      session?.destroy();
      session = created.value;
      const mounted = mountReader(session, { nativeElement: host }, { assets });
      if (!mounted.ok) return reject();
      reader = mounted.value;
      requestAnimationFrame(() => window.scrollTo(0, scroll));
      session.subscribe(state);
      state();
    } else if (
      data.kind === "set-enabled" &&
      exact(data, [...baseKeys, "enabled"]) &&
      typeof data.enabled === "boolean"
    ) {
      enabled = data.enabled;
      host.inert = !enabled;
      host
        .querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLButtonElement
        >("input,select,button")
        .forEach((element) => {
          if (!enabled && element.dataset.wasDisabled === undefined) {
            element.dataset.wasDisabled = String(element.disabled);
            element.disabled = true;
          } else if (enabled && element.dataset.wasDisabled !== undefined) {
            element.disabled = element.dataset.wasDisabled === "true";
            delete element.dataset.wasDisabled;
          }
        });
    } else if (data.kind === "reset" && exact(data, baseKeys)) {
      session?.reset();
      reader?.resetPresentation();
      state();
    } else if (data.kind === "get-state" && exact(data, baseKeys)) state();
    else if (
      data.kind === "set-controls" &&
      enabled &&
      exact(data, [...baseKeys, "controls"]) &&
      controls(data.controls) &&
      session
    ) {
      port?.postMessage({
        ...expected,
        kind: "action-result",
        result: session.setControls(data.controls as ControlState),
      });
    } else if (data.kind === "destroy" && exact(data, baseKeys)) {
      port?.postMessage({ ...data, kind: "destroyed" });
      dispose();
    } else reject();
  };
  port.postMessage({ ...expected, kind: "ready" });
});
parent.postMessage({ protocol: "tinta-host-1", kind: "hello" }, "*");
