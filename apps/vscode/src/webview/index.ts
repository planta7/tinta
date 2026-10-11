import {
  createSession,
  decodeProgram,
  encodeProgram,
} from "@tinta-lang/engine";
import { validateAssets } from "@tinta-lang/artifacts";
import { diagnostic, limits } from "@tinta-lang/types/common";
import {
  boundedJson,
  controlState,
  exactKeys,
  extensionMessage,
  record,
  sameDocument,
  sameRevision,
  unsigned,
  type ExtensionToWebview,
  type WebviewIdentity,
} from "@tinta-lang/types/webview";
import type { Asset, ControlDefinition, Session } from "@tinta-lang/types";

declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
declare const tintaBootstrap: {
  readonly identity: WebviewIdentity;
  readonly previewHtml: string;
};

const api = acquireVsCodeApi();
let identity = tintaBootstrap.identity;
let lastRequest = 0;
let innerRequest = 0;
let innerRevision = -1;
let assetRevision = 0;
let session: Session | undefined;
let port: MessagePort | undefined;
let loaded = false;
let innerReady = false;
let disposed = false;
let pending: ExtensionToWebview | undefined;
let currentLoad: Extract<ExtensionToWebview, { kind: "load" }> | undefined;
let enabled = false;
const innerRequests = new Map<number, number>();
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const innerIdentity = {
  protocol: "tinta-host-1",
  documentId: token(),
  capability: token(),
};
const innerKeys = [
  "protocol",
  "documentId",
  "capability",
  "requestId",
  "sourceRevision",
  "kind",
];
const banner = document.createElement("p");
banner.setAttribute("role", "status");
banner.tabIndex = -1;
banner.textContent = "No valid preview yet. Check the source diagnostics.";
const resets = document.createElement("details");
resets.hidden = true;
const frame = document.createElement("iframe");
frame.title = "Interactive document preview";
frame.setAttribute(
  "sandbox",
  "allow-scripts allow-popups allow-popups-to-escape-sandbox",
);
document.body.append(banner, resets, frame);

function reply(kind: string, extra: Record<string, unknown> = {}): void {
  api.postMessage({ ...identity, kind, ...extra });
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  port?.close();
  port = undefined;
  session?.destroy();
  session = undefined;
  pending = undefined;
  innerRequests.clear();
  window.removeEventListener("message", receive);
  window.removeEventListener("pagehide", dispose);
  frame.remove();
}

function reject(): void {
  reply("diagnostics", {
    diagnostics: [
      diagnostic(
        "E_PROTOCOL",
        "Invalid preview message. The channel has been closed.",
      ),
    ],
  });
  banner.textContent = "E_PROTOCOL: Preview closed.";
  dispose();
}

function send(kind: string, extra: Record<string, unknown> = {}): void {
  innerRequests.set(++innerRequest, identity.requestId);
  while (innerRequests.size > 32)
    innerRequests.delete(innerRequests.keys().next().value!);
  port?.postMessage({
    ...innerIdentity,
    requestId: innerRequest,
    sourceRevision: identity.source.sourceRevision,
    kind,
    ...extra,
  });
}

function setEnabled(value: boolean): void {
  enabled = value;
  banner.textContent = value
    ? "Preview is current. Images require separately supplied local assets."
    : loaded
      ? "Preview is from the last valid source. Checking source; fix any errors to update it."
      : "No valid preview yet. Checking source; inspect the source diagnostics.";
  if (!value && document.activeElement === frame) banner.focus();
  if (port && loaded) send("set-enabled", { enabled: value });
}

function signature(control: ControlDefinition): string {
  return JSON.stringify([
    control.kind,
    control.initial,
    ...(control.kind === "slider"
      ? [control.min, control.max, control.step]
      : []),
    ...(control.kind === "choice" ? control.options : []),
  ]);
}

function load(message: Extract<ExtensionToWebview, { kind: "load" }>): void {
  currentLoad = message;
  if (message.assetRevision < assetRevision) return reject();
  const decoded = decodeProgram(message.program);
  if (
    !decoded.ok ||
    decoded.value.sourceUri !== message.source.uri ||
    decoded.value.profile !== message.source.profile ||
    decoded.value.sourceSha256 !== message.source.sourceSha256
  )
    return reject();
  const assets = new Map<string, Asset>();
  let total = 0;
  for (const asset of message.assets) {
    const raw = atob(asset.bytesBase64);
    if (
      btoa(raw) !== asset.bytesBase64 ||
      raw.length > limits.assetBytes ||
      assets.has(asset.path)
    )
      return reject();
    total += raw.length;
    if (total > limits.totalAssetBytes) return reject();
    assets.set(asset.path, {
      path: asset.path,
      mime: asset.mime,
      sha256: asset.sha256,
      bytes: Uint8Array.from(raw, (char) => char.charCodeAt(0)),
    });
  }
  const canonical = new Map(assets);
  for (const [path, target] of Object.entries(message.assetPaths)) {
    const asset = canonical.get(target);
    if (!asset || (canonical.has(path) && path !== target)) return reject();
    assets.set(path, asset);
  }
  validateAssets(assets);
  let created = createSession(decoded.value);
  if (!created.ok) return reject();
  const controls = decoded.value.declarations.filter(
    (item): item is ControlDefinition =>
      ["slider", "toggle", "choice"].includes(item.kind),
  );
  const previous = new Map(
    session?.program.declarations.map((item) => [item.name, item]) ?? [],
  );
  const answers: Record<string, string | number | boolean> =
    Object.create(null);
  let resetNames: string[] = [];
  for (const control of controls) {
    const old = previous.get(control.name);
    if (
      old &&
      ["slider", "toggle", "choice"].includes(old.kind) &&
      signature(old as ControlDefinition) === signature(control)
    )
      answers[control.name] = session!.getRevision().state[control.name]!;
    else {
      answers[control.name] = control.initial;
      if (session) resetNames.push(control.name);
    }
  }
  const candidate = session ? answers : message.baseline;
  if (!created.value.setControls(candidate).ok) {
    created.value.destroy();
    if (!session) return reject();
    created = createSession(decoded.value);
    if (!created.ok) return reject();
    resetNames = controls.map((control) => control.name);
  }
  session?.destroy();
  session = created.value;
  assetRevision = message.assetRevision;
  resets.replaceChildren();
  resets.hidden = resetNames.length === 0;
  if (resetNames.length) {
    const summary = document.createElement("summary");
    summary.textContent = `${resetNames.length} answers reset after source changes`;
    const names = document.createElement("p");
    names.textContent = resetNames.join(", ");
    resets.append(summary, names);
  }
  innerRevision = -1;
  loaded = true;
  send("load", {
    program: encodeProgram(decoded.value),
    assets: [...canonical.values()],
    assetPaths: message.assetPaths,
    baseline: session.getRevision().state,
  });
  setEnabled(true);
}

function innerMessage(value: unknown): void {
  if (
    !boundedJson(value) ||
    !record(value) ||
    value.protocol !== innerIdentity.protocol ||
    value.documentId !== innerIdentity.documentId ||
    value.capability !== innerIdentity.capability ||
    !unsigned(value.requestId) ||
    !unsigned(value.sourceRevision) ||
    value.requestId > innerRequest ||
    value.sourceRevision > identity.source.sourceRevision
  )
    return reject();
  if (
    value.kind === "ready" &&
    value.requestId === 0 &&
    !innerReady &&
    exactKeys(value, innerKeys)
  ) {
    innerReady = true;
    if (pending?.kind === "load") {
      const message = pending;
      pending = undefined;
      const desired = enabled;
      load(message);
      setEnabled(desired);
    }
    return;
  }
  if (value.sourceRevision < identity.source.sourceRevision) return;
  if (
    value.kind !== "state" ||
    !exactKeys(value, [...innerKeys, "controls", "sessionRevision"]) ||
    !controlState(value.controls) ||
    !unsigned(value.sessionRevision) ||
    !session
  )
    return reject();
  const outerId = innerRequests.get(value.requestId);
  if (outerId === undefined) return;
  if (value.sessionRevision <= innerRevision) return;
  if (!session.setControls(value.controls).ok) return reject();
  innerRevision = value.sessionRevision;
  reply("state", {
    controls: value.controls,
    sessionRevision: value.sessionRevision,
    assetRevision,
  });
}

function receive(event: MessageEvent<unknown>): void {
  if (disposed) return;
  if (event.source === frame.contentWindow) {
    if (
      port ||
      !record(event.data) ||
      !exactKeys(event.data, ["protocol", "kind"]) ||
      event.data.protocol !== "tinta-host-1" ||
      event.data.kind !== "hello"
    )
      return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (message: MessageEvent<unknown>) => {
      try {
        innerMessage(message.data);
      } catch {
        reject();
      }
    };
    frame.contentWindow!.postMessage(
      {
        ...innerIdentity,
        kind: "connect",
        requestId: 0,
        sourceRevision: identity.source.sourceRevision,
      },
      "*",
      [channel.port2],
    );
    return;
  }
  const message = event.data;
  if (
    !extensionMessage(message) ||
    message.panelId !== identity.panelId ||
    message.capability !== identity.capability ||
    !sameDocument(message.source, identity.source)
  )
    return reject();
  if (message.requestId <= lastRequest) return;
  if (message.kind !== "load" && !sameRevision(message.source, identity.source))
    return reject();
  if (
    message.kind === "load" &&
    (message.source.sourceRevision < identity.source.sourceRevision ||
      message.source.editorVersion < identity.source.editorVersion ||
      (message.source.sourceRevision === identity.source.sourceRevision &&
        !sameRevision(message.source, identity.source)))
  )
    return reject();
  lastRequest = message.requestId;
  identity = {
    protocol: message.protocol,
    panelId: message.panelId,
    capability: message.capability,
    requestId: message.requestId,
    source: message.source,
  };
  try {
    if (message.kind === "load") {
      if (!innerReady) {
        pending = message;
        enabled = true;
      } else load(message);
    } else if (message.kind === "set-enabled") setEnabled(message.enabled);
    else if (message.kind === "reset") {
      if (enabled && currentLoad) {
        session?.destroy();
        session = undefined;
        load({ ...currentLoad, ...identity });
      }
    } else if (message.kind === "get-state") {
      if (session)
        reply("state", {
          controls: session.getRevision().state,
          sessionRevision: Math.max(0, innerRevision),
          assetRevision,
        });
    } else if (message.kind === "destroy") {
      reply("destroyed");
      dispose();
    }
  } catch {
    reject();
  }
}

window.addEventListener("message", receive);
window.addEventListener("pagehide", dispose, { once: true });
frame.srcdoc = tintaBootstrap.previewHtml;
reply("ready");
